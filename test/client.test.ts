import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APIConnectionError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	ConflictError,
	InsufficientCreditsError,
	InternalServerError,
	NotFoundError,
	PermissionDeniedError,
	PlanRequiredError,
	QuotaExceededError,
	ServiceUnavailableError,
	Topics,
	TopicsError,
	VERSION
} from "../src/index";
import { apiError, fakeFetch, json } from "./fakeFetch";

const client = (fetch: typeof globalThis.fetch, options = {}) => new Topics({ apiKey: "tso_test", fetch, ...options });

/** Runs a call to completion while fake timers carry it through its backoff sleeps. */
async function settle<T>(promise: PromiseLike<T>): Promise<T> {
	const result = Promise.resolve(promise).then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	);
	await vi.runAllTimersAsync();
	const outcome = await result;
	if ("error" in outcome) {
		throw outcome.error;
	}

	return outcome.value;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("construction", () => {
	it("reads the key and base URL from the environment when not passed", async () => {
		vi.stubEnv("TOPICS_API_KEY", "tso_env");
		vi.stubEnv("TOPICS_BASE_URL", "http://localhost:3000/api/");
		const { fetch, calls } = fakeFetch(json({ allowance: 1 }));
		await new Topics({ fetch }).credits.get();
		expect(calls[0].headers.get("authorization")).toBe("Bearer tso_env");
		expect(calls[0].url.toString()).toBe("http://localhost:3000/api/v1/credits");
	});

	it("throws without a key", () => {
		vi.stubEnv("TOPICS_API_KEY", "");
		expect(() => new Topics()).toThrow(TopicsError);
	});

	it("refuses to run in a browser unless told to", () => {
		vi.stubGlobal("window", { document: {} });
		expect(() => new Topics({ apiKey: "tso_test" })).toThrow(/servers only/);
		expect(() => new Topics({ apiKey: "tso_test", dangerouslyAllowBrowser: true })).not.toThrow();
	});

	it("withOptions keeps the rest of the configuration and the helpers", async () => {
		const { fetch, calls } = fakeFetch(json({ allowance: 1 }));
		const other = client(fetch, { baseUrl: "https://example.test/api" }).withOptions({ apiKey: "tso_other" });
		expect(other).toBeInstanceOf(Topics);
		expect(typeof other.creations.generateImage).toBe("function");
		await other.credits.get();
		expect(calls[0].url.origin).toBe("https://example.test");
		expect(calls[0].headers.get("authorization")).toBe("Bearer tso_other");
	});
});

describe("requests", () => {
	it("builds the path, query, body, and headers", async () => {
		const { fetch, calls } = fakeFetch(json({ id: "it_1" }));
		await client(fetch).series.items.update("ser 1", "it_1", { caption: "Hi" });
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].url.pathname).toBe("/api/v1/series/ser%201/items/it_1");
		expect(calls[0].body).toEqual({ caption: "Hi" });
		expect(calls[0].headers.get("content-type")).toBe("application/json");
		expect(calls[0].headers.get("user-agent")).toContain(`topics-sdk-typescript/${VERSION}`);
		expect(calls[0].headers.get("idempotency-key")).toBeNull();
	});

	it("drops undefined query values", async () => {
		const { fetch, calls } = fakeFetch(json({ data: [] }));
		await client(fetch).posts.list({ platform: "instagram", q: undefined });
		expect(calls[0].url.search).toBe("?platform=instagram");
	});

	it("gives every POST an idempotency key, and honours one passed in", async () => {
		const { fetch, calls } = fakeFetch(json({ id: "cr_1" }, 202), json({ id: "cr_2" }, 202));
		const topics = client(fetch);
		await topics.creations.create({ prompt: "p", aspectRatio: "square" });
		await topics.creations.create({ prompt: "p", aspectRatio: "square" }, { idempotencyKey: "post-42" });
		expect(calls[0].headers.get("idempotency-key")).toMatch(/^sdk-[0-9a-f-]{36}$/);
		expect(calls[1].headers.get("idempotency-key")).toBe("post-42");
	});

	it("resolves a 204 to undefined", async () => {
		const { fetch } = fakeFetch(new Response(null, { status: 204 }));
		await expect(client(fetch).assets.delete("as_1")).resolves.toBeUndefined();
	});

	it("exposes the response, request id, and rate limit with withResponse()", async () => {
		const { fetch } = fakeFetch(
			json({ allowance: 1 }, 200, { "X-Request-Id": "req_1", "X-RateLimit-Limit": "5", "X-RateLimit-Remaining": "4", "X-Quota-Remaining": "999" })
		);
		const { data, requestId, rateLimit, response } = await client(fetch).credits.get().withResponse();
		expect(data).toEqual({ allowance: 1 });
		expect(requestId).toBe("req_1");
		expect(rateLimit).toMatchObject({ limit: 5, remaining: 4, quotaRemaining: 999 });
		expect(response.status).toBe(200);
	});
});

describe("errors", () => {
	it.each([
		[400, "validationError", BadRequestError],
		[401, "unauthorized", AuthenticationError],
		[402, "creditsExhausted", InsufficientCreditsError],
		[403, "forbidden", PermissionDeniedError],
		[403, "planRequired", PlanRequiredError],
		[404, "notFound", NotFoundError],
		[409, "conflict", ConflictError],
		[429, "quotaExceeded", QuotaExceededError]
	])("maps %i %s to its class", async (status, code, ErrorClass) => {
		const { fetch } = fakeFetch(apiError(status, code, { "X-Request-Id": "req_9" }));
		const error = await client(fetch)
			.credits.get()
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ErrorClass);
		expect(error).toMatchObject({ status, code, requestId: "req_9", message: `${code} happened` });
	});

	it("falls back to the status when the body isn't the API's envelope", async () => {
		const { fetch } = fakeFetch(new Response("Bad gateway", { status: 502 }));
		const error = await settle(client(fetch, { maxRetries: 0 }).credits.get()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(InternalServerError);
		expect(error).toMatchObject({ code: null });
	});
});

describe("retries", () => {
	it("retries 5xx, connection errors, and rate limits with the same idempotency key", async () => {
		const { fetch, calls } = fakeFetch(
			apiError(503, "serviceUnavailable"),
			new TypeError("fetch failed"),
			apiError(429, "rateLimitExceeded"),
			json({ id: "cr_1" }, 202)
		);
		const creation = await settle(client(fetch, { maxRetries: 3 }).creations.create({ prompt: "p", aspectRatio: "square" }));
		expect(creation).toEqual({ id: "cr_1" });
		expect(calls).toHaveLength(4);
		expect(new Set(calls.map((call) => call.headers.get("idempotency-key"))).size).toBe(1);
	});

	it("stops at maxRetries and throws the last error", async () => {
		const { fetch, calls } = fakeFetch(apiError(503, "serviceUnavailable"), apiError(503, "serviceUnavailable"), apiError(503, "serviceUnavailable"));
		await expect(settle(client(fetch).credits.get())).rejects.toBeInstanceOf(ServiceUnavailableError);
		expect(calls).toHaveLength(3);
	});

	it("waits as long as Retry-After says", async () => {
		const { fetch, calls } = fakeFetch(apiError(429, "rateLimitExceeded", { "Retry-After": "3" }), json({}));
		const pending = client(fetch).credits.get();
		await vi.advanceTimersByTimeAsync(2_900);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		await pending;
		expect(calls).toHaveLength(2);
	});

	it("never retries a used-up monthly quota", async () => {
		const { fetch, calls } = fakeFetch(apiError(429, "quotaExceeded", { "Retry-After": "86400" }));
		const error = await client(fetch)
			.credits.get()
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(QuotaExceededError);
		expect((error as QuotaExceededError).resetsAt).toBeInstanceOf(Date);
		expect(calls).toHaveLength(1);
	});

	it("retries a conflict only while the same key is still running", async () => {
		const running = fakeFetch(apiError(409, "conflict", { "Retry-After": "1" }), json({ id: "cr_1" }));
		await expect(settle(client(running.fetch).creations.retry("cr_1"))).resolves.toEqual({ id: "cr_1" });
		expect(running.calls).toHaveLength(2);
		const final = fakeFetch(apiError(409, "conflict"));
		await expect(client(final.fetch).creations.retry("cr_1")).rejects.toBeInstanceOf(ConflictError);
		expect(final.calls).toHaveLength(1);
	});

	it("does not retry a 4xx", async () => {
		const { fetch, calls } = fakeFetch(apiError(404, "notFound"));
		await expect(client(fetch).posts.get("p_1")).rejects.toBeInstanceOf(NotFoundError);
		expect(calls).toHaveLength(1);
	});

	it("wraps a network failure as APIConnectionError once retries run out", async () => {
		const { fetch } = fakeFetch(new TypeError("fetch failed"));
		await expect(client(fetch, { maxRetries: 0 }).credits.get()).rejects.toBeInstanceOf(APIConnectionError);
	});
});

describe("timeouts and aborts", () => {
	const hang = (call: { url: URL }, signal?: AbortSignal) =>
		new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException(`aborted ${call.url}`, "AbortError"))));

	it("times out a request that takes too long", async () => {
		const fetch = ((input: string, init: RequestInit) => hang({ url: new URL(input) }, init.signal ?? undefined)) as typeof globalThis.fetch;
		const pending = client(fetch, { timeout: 1_000, maxRetries: 0 })
			.credits.get()
			.catch((caught: unknown) => caught);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await pending).toBeInstanceOf(APITimeoutError);
	});

	it("stops without retrying when the caller aborts", async () => {
		let calls = 0;
		const fetch = ((input: string, init: RequestInit) => {
			calls++;
			return hang({ url: new URL(input) }, init.signal ?? undefined);
		}) as typeof globalThis.fetch;
		const controller = new AbortController();
		const pending = client(fetch)
			.credits.get({ signal: controller.signal })
			.catch((caught: unknown) => caught);
		controller.abort();
		expect(await pending).toBeInstanceOf(APIUserAbortError);
		expect(calls).toBe(1);
	});
});
