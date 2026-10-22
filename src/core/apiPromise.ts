/** The caller's standing on the per-second rate limit and the monthly quota, from the response headers. */
export interface RateLimit {
	limit: number | null;
	remaining: number | null;
	/** Unix time, in seconds, when the current one-second window resets. */
	reset: number | null;
	quotaLimit: number | null;
	quotaRemaining: number | null;
}

export interface APIResponse<T> {
	data: T;
	response: Response;
	/** Quote this when you contact support. */
	requestId: string | null;
	rateLimit: RateLimit;
}

/**
 * What every API method returns: await it for the data, or call
 * `.withResponse()` for the data together with the raw response, request id,
 * and rate-limit state. The request starts as soon as the method is called.
 */
export class APIPromise<T> implements PromiseLike<T> {
	readonly #result: Promise<APIResponse<T>>;

	constructor(result: Promise<APIResponse<T>>) {
		this.#result = result;
	}

	withResponse(): Promise<APIResponse<T>> {
		return this.#result;
	}

	then<Fulfilled = T, Rejected = never>(
		onfulfilled?: ((value: T) => Fulfilled | PromiseLike<Fulfilled>) | null,
		onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null
	): Promise<Fulfilled | Rejected> {
		return this.#result.then((result) => result.data).then(onfulfilled, onrejected);
	}

	catch<Rejected = never>(onrejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null): Promise<T | Rejected> {
		return this.then(undefined, onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<T> {
		return this.then().finally(onfinally);
	}

	get [Symbol.toStringTag]() {
		return "APIPromise";
	}
}
