import { VERSION } from "../version";
import { APIPromise, type APIResponse, type RateLimit } from "./apiPromise";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, QuotaExceededError, TopicsError } from "./errors";
import { Page, PagePromise, type PageResponse } from "./pagination";

export interface ClientOptions {
	/** A brand API key from the Topics.so dashboard. Defaults to `process.env.TOPICS_API_KEY`. */
	apiKey?: string;
	/** Defaults to `process.env.TOPICS_BASE_URL`, then `https://topics.so/api`. */
	baseUrl?: string;
	/** Per-request timeout in milliseconds. Default 90 s, above the API's 60 s long-poll. */
	timeout?: number;
	/** Retries for connection errors, timeouts, rate limits, and 5xx. Default 2. */
	maxRetries?: number;
	/** A custom fetch, for tests or proxies. */
	fetch?: typeof globalThis.fetch;
	defaultHeaders?: Record<string, string>;
	/**
	 * Keys are secrets and the API sends no CORS headers, so constructing a client
	 * in a browser throws. Set this only for test environments that fake a DOM.
	 */
	dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
	signal?: AbortSignal;
	/** Overrides the client's timeout for this request, in milliseconds. */
	timeout?: number;
	maxRetries?: number;
	/**
	 * Sent as `Idempotency-Key`. Every POST gets a fresh one per call by default,
	 * which covers the SDK's own retries; pass your own, derived from your own
	 * record ids, to make a retry after a process restart safe too.
	 */
	idempotencyKey?: string;
	headers?: Record<string, string>;
}

type Method = "get" | "post" | "put" | "patch" | "delete";

interface RequestArgs {
	query?: object;
	body?: unknown;
	options?: RequestOptions;
}

const DEFAULT_BASE_URL = "https://topics.so/api";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;
/** A `Retry-After` longer than this isn't worth holding the caller for; the error surfaces instead. */
const MAX_RETRY_AFTER_MS = 60_000;

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export class CoreClient {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly timeout: number;
	readonly maxRetries: number;
	/** @internal */
	readonly _fetch: typeof globalThis.fetch;
	readonly #options: ClientOptions;

	constructor(options: ClientOptions = {}) {
		const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
		if (isBrowser && !options.dangerouslyAllowBrowser) {
			throw new TopicsError(
				"The Topics.so SDK runs on servers only: an API key in browser code is readable by anyone. Call it from your backend instead."
			);
		}

		const apiKey = options.apiKey ?? env?.TOPICS_API_KEY;
		if (!apiKey) {
			throw new TopicsError("Missing API key. Pass `apiKey`, or set the TOPICS_API_KEY environment variable.");
		}

		this.apiKey = apiKey;
		this.baseUrl = (options.baseUrl ?? env?.TOPICS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.#options = options;
	}

	/** A copy of this client with some options changed, e.g. another brand's `apiKey`. */
	withOptions(options: ClientOptions): this {
		const Client = this.constructor as new (options: ClientOptions) => this;
		return new Client({ ...this.#options, ...options });
	}

	/** @internal */
	request<T>(method: Method, path: string, args: RequestArgs = {}): APIPromise<T> {
		return new APIPromise(this.#send<T>(method, path, args));
	}

	/** @internal */
	getPage<T>(path: string, query: object | undefined, options: RequestOptions | undefined): PagePromise<T> {
		const fetchPage = async (page?: number): Promise<APIResponse<Page<T>>> => {
			const result = await this.#send<PageResponse<T>>("get", path, { query: page === undefined ? query : { ...query, page }, options });
			const nextPage = async (next: number) => (await fetchPage(next)).data;
			return { ...result, data: new Page(result.data, nextPage) };
		};

		return new PagePromise(fetchPage());
	}

	async #send<T>(method: Method, path: string, { query, body, options = {} }: RequestArgs): Promise<APIResponse<T>> {
		const url = this.#url(path, query);
		const maxRetries = options.maxRetries ?? this.maxRetries;
		const headers: Record<string, string> = {
			"Authorization": `Bearer ${this.apiKey}`,
			"Accept": "application/json",
			"User-Agent": `topics-sdk-typescript/${VERSION} ${runtime()}`,
			...this.#options.defaultHeaders,
			...options.headers
		};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		// Generated once, outside the retry loop, so every attempt of this call is the same request to the server.
		if (method === "post") {
			headers["Idempotency-Key"] = options.idempotencyKey ?? `sdk-${crypto.randomUUID()}`;
		}

		const init: RequestInit = { method: method.toUpperCase(), headers, body: body === undefined ? undefined : JSON.stringify(body) };
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.#fetchWithTimeout(url, init, options.timeout ?? this.timeout, options.signal);
			} catch (error) {
				if (error instanceof APIUserAbortError || attempt >= maxRetries) {
					throw error;
				}

				await sleep(backoff(attempt));
				continue;
			}

			if (response.ok) {
				const data = response.status === 204 ? undefined : await response.json();
				return { data: data as T, response, requestId: response.headers.get("x-request-id"), rateLimit: readRateLimit(response.headers) };
			}

			const error = APIError.from(response.status, await response.json().catch(() => undefined), response.headers);
			const delay = retryDelay(error, attempt);
			if (delay === null || attempt >= maxRetries) {
				throw error;
			}

			await sleep(delay);
		}
	}

	#url(path: string, query: object | undefined): string {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}

		return url.toString();
	}

	async #fetchWithTimeout(url: string, init: RequestInit, timeout: number, signal: AbortSignal | undefined): Promise<Response> {
		if (signal?.aborted) {
			throw new APIUserAbortError();
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this._fetch(url, { ...init, signal: controller.signal });
		} catch (error) {
			if (signal?.aborted) {
				throw new APIUserAbortError();
			}

			if (controller.signal.aborted) {
				throw new APITimeoutError();
			}

			throw new APIConnectionError(undefined, { cause: error });
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * How long to wait before retrying, or null when this error must not be
 * retried. A 409 retries only with `Retry-After`, which the API sends only when
 * the same idempotency key is still running; every other conflict is final.
 */
function retryDelay(error: APIError, attempt: number): number | null {
	const retryAfterMs = error.retryAfter === null ? null : error.retryAfter * 1000;
	if (error instanceof QuotaExceededError) {
		return null;
	}

	if (error.status === 409) {
		return retryAfterMs;
	}

	if (error.status === 408 || error.status === 429 || error.status >= 500) {
		return retryAfterMs !== null && retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : backoff(attempt);
	}

	return null;
}

/** Exponential from 0.5 s, capped at 8 s, with up to 25% jitter so a burst of clients doesn't retry in lockstep. */
function backoff(attempt: number): number {
	return Math.min(500 * 2 ** attempt, 8_000) * (1 - Math.random() * 0.25);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRateLimit(headers: Headers): RateLimit {
	const number = (name: string) => {
		const value = headers.get(name);
		return value === null ? null : Number(value);
	};

	return {
		limit: number("x-ratelimit-limit"),
		remaining: number("x-ratelimit-remaining"),
		reset: number("x-ratelimit-reset"),
		quotaLimit: number("x-quota-limit"),
		quotaRemaining: number("x-quota-remaining")
	};
}

function runtime(): string {
	const g = globalThis as { Bun?: { version: string }; Deno?: { version: { deno: string } }; process?: { versions?: { node?: string } } };
	if (g.Bun) {
		return `bun/${g.Bun.version}`;
	}

	if (g.Deno) {
		return `deno/${g.Deno.version.deno}`;
	}

	if (g.process?.versions?.node) {
		return `node/${g.process.versions.node}`;
	}

	return "unknown";
}
