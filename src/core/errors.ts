import type { components } from "../generated/schema";

export type ErrorCode = components["schemas"]["Error"]["error"]["code"];

type Creation = components["schemas"]["Creation"];

/** The base of every error this SDK throws. */
export class TopicsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** The API answered with an error status. Subclassed per error code. */
export class APIError extends TopicsError {
	readonly status: number;
	/** The API's error code; null when the body wasn't the API's error envelope. */
	readonly code: ErrorCode | null;
	/** Quote this when you contact support. */
	readonly requestId: string | null;
	readonly headers: Headers;

	constructor(status: number, message: string, details: { code: ErrorCode | null; headers: Headers }) {
		super(message);
		this.status = status;
		this.code = details.code;
		this.headers = details.headers;
		this.requestId = details.headers.get("x-request-id");
	}

	/** Seconds from the `Retry-After` header, or null when it wasn't sent. */
	get retryAfter(): number | null {
		const value = this.headers.get("retry-after");
		return value === null || Number.isNaN(Number(value)) ? null : Number(value);
	}

	static from(status: number, body: unknown, headers: Headers): APIError {
		const envelope = (body as { error?: { code?: ErrorCode; message?: string } } | undefined)?.error;
		const code = envelope?.code ?? null;
		const message = envelope?.message ?? `Topics.so API returned ${status}.`;
		const ErrorClass = (code && ERROR_BY_CODE[code]) ?? ERROR_BY_STATUS[status] ?? (status >= 500 ? InternalServerError : APIError);
		return new ErrorClass(status, message, { code, headers });
	}
}

/** `validationError`: a parameter or body field is missing, malformed, or out of range. */
export class BadRequestError extends APIError {}

/** `unauthorized`: no key, or the key is unknown or revoked. */
export class AuthenticationError extends APIError {}

/** `creditsExhausted`: the month's allowance is spent and no purchased credits remain. */
export class InsufficientCreditsError extends APIError {}

/** `forbidden`: the key lacks a scope the endpoint requires. */
export class PermissionDeniedError extends APIError {}

/** `planRequired`: the request uses something the brand's plan does not include. */
export class PlanRequiredError extends PermissionDeniedError {}

/** `notFound`: nothing with that id exists in this brand. */
export class NotFoundError extends APIError {}

/** `conflict`: the resource isn't in a state that allows this, or an idempotency key was reused. */
export class ConflictError extends APIError {}

/** `rateLimitExceeded`: too many requests this second. Retried automatically. */
export class RateLimitError extends APIError {}

/** `quotaExceeded`: the monthly request quota is used up. Never retried. */
export class QuotaExceededError extends APIError {
	/** When the quota resets, from `Retry-After`. */
	get resetsAt(): Date | null {
		return this.retryAfter === null ? null : new Date(Date.now() + this.retryAfter * 1000);
	}
}

/** `serviceUnavailable`: an upstream dependency didn't answer. Retried automatically. */
export class ServiceUnavailableError extends APIError {}

/** Any other 5xx. Retried automatically. */
export class InternalServerError extends APIError {}

/** The request never got an answer: DNS, TLS, a reset connection. */
export class APIConnectionError extends TopicsError {
	constructor(message = "Could not reach the Topics.so API.", options?: ErrorOptions) {
		super(message, options);
	}
}

/** The request took longer than its `timeout`. */
export class APITimeoutError extends APIConnectionError {
	constructor() {
		super("The request to the Topics.so API timed out.");
	}
}

/** The caller's `signal` aborted the request. */
export class APIUserAbortError extends TopicsError {
	constructor() {
		super("The request was aborted.");
	}
}

/** A generation reached `failed`. `creation.error` says why. */
export class GenerationFailedError extends TopicsError {
	readonly creation: Creation;

	constructor(creation: Creation) {
		super(creation.error ?? "Generation failed.");
		this.creation = creation;
	}
}

/**
 * A wait ran out before the creation finished. It is still running: pass
 * `creation.id` to `creations.waitFor` to pick up where this left off.
 */
export class WaitTimeoutError extends TopicsError {
	readonly creation: Creation;

	constructor(creation: Creation) {
		super(`Creation ${creation.id} was still ${creation.status} when the wait ran out.`);
		this.creation = creation;
	}
}

const ERROR_BY_CODE: Record<ErrorCode, typeof APIError> = {
	validationError: BadRequestError,
	unauthorized: AuthenticationError,
	creditsExhausted: InsufficientCreditsError,
	forbidden: PermissionDeniedError,
	planRequired: PlanRequiredError,
	notFound: NotFoundError,
	conflict: ConflictError,
	rateLimitExceeded: RateLimitError,
	quotaExceeded: QuotaExceededError,
	serviceUnavailable: ServiceUnavailableError
};

const ERROR_BY_STATUS: Record<number, typeof APIError> = {
	400: BadRequestError,
	401: AuthenticationError,
	402: InsufficientCreditsError,
	403: PermissionDeniedError,
	404: NotFoundError,
	409: ConflictError,
	429: RateLimitError,
	503: ServiceUnavailableError
};
