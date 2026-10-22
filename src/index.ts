import type { ClientOptions } from "./core/client";
import { GeneratedClient } from "./generated/client";
import { Assets } from "./helpers/assets";
import { Creations } from "./helpers/creations";

/**
 * The Topics.so API client.
 *
 * ```ts
 * import { Topics } from "@topics-so/sdk";
 *
 * const topics = new Topics({ apiKey: process.env.TOPICS_API_KEY });
 * const image = await topics.creations.generateImage({ idea: "…", aspectRatio: "landscape" });
 * ```
 */
export class Topics extends GeneratedClient {
	override readonly creations: Creations = new Creations(this);
	override readonly assets: Assets = new Assets(this);

	constructor(options: ClientOptions = {}) {
		super(options);
	}
}

export type { APIPromise, APIResponse, RateLimit } from "./core/apiPromise";
export type { ClientOptions, RequestOptions } from "./core/client";
export {
	APIConnectionError,
	APIError,
	APITimeoutError,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	ConflictError,
	GenerationFailedError,
	InsufficientCreditsError,
	InternalServerError,
	NotFoundError,
	PermissionDeniedError,
	PlanRequiredError,
	QuotaExceededError,
	RateLimitError,
	ServiceUnavailableError,
	TopicsError,
	WaitTimeoutError,
	type ErrorCode
} from "./core/errors";
export { Page, PagePromise, type Pagination } from "./core/pagination";
export type { components, operations, paths } from "./generated/schema";
export type * from "./generated/types";
export type { UploadInput } from "./helpers/assets";
export type { CompletedCreation, GenerateImageInput, GenerateVideoInput, WaitOptions } from "./helpers/creations";
export { VERSION } from "./version";
