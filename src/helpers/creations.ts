import type { RequestOptions } from "../core/client";
import { GenerationFailedError, TopicsError, WaitTimeoutError } from "../core/errors";
import { CreationsResource } from "../generated/resources";
import type { Creation, CreationInput } from "../generated/types";

/** A creation that finished: `url` is the image, or a video's cover frame. */
export type CompletedCreation = Creation & { status: "complete"; url: string };

export interface GenerateImageInput extends Omit<CreationInput, "prompt" | "mediaType" | "motionPrompt" | "durationSeconds" | "soundId"> {
	/** What the image should show; expanded server-side with the brand's style and cast. Needed unless `prompt` is given. */
	idea?: string;
	/** A full prompt used verbatim instead of composing one from `idea`. */
	prompt?: string;
	/**
	 * Makes the whole call safe to repeat, even after a restart: derive it from
	 * your own record, e.g. `post-${post.id}-hero`. Up to 190 characters, since
	 * the compose step reuses it with a suffix.
	 */
	idempotencyKey?: string;
	/** How long to wait for the finished image, in milliseconds. Default 180 s. */
	timeout?: number;
}

export interface GenerateVideoInput extends Omit<GenerateImageInput, "aspectRatio"> {
	/** The clip's shape. Default `story`, which is what a reel wants. */
	aspectRatio?: CreationInput["aspectRatio"];
	/** What moves and how. Camera and small movement; nothing new enters the frame. */
	motionPrompt?: string;
	/** Clip length in seconds, snapped to the nearest the brand's video model offers. */
	durationSeconds?: number;
	/** A library sound to put on the clip. Omitted keeps the model's own audio. */
	soundId?: string;
	/** How long to wait for the finished clip, in milliseconds. Default 600 s. */
	timeout?: number;
}

export interface WaitOptions {
	/** How long to wait in total, in milliseconds. Default 600 s. */
	timeout?: number;
	signal?: AbortSignal;
}

/** The server holds a `wait` request up to this long. */
const WAIT_LEG_SECONDS = 60;
const IMAGE_TIMEOUT_MS = 180_000;
const VIDEO_TIMEOUT_MS = 600_000;

export class Creations extends CreationsResource {
	/**
	 * Generate one on-brand image and wait for it. Composes a prompt from `idea`
	 * unless `prompt` is given, starts the generation (debiting its price in
	 * credits), and long-polls until it finishes.
	 *
	 * Throws `GenerationFailedError` if generation fails, and `WaitTimeoutError`
	 * (carrying the still-running creation) if `timeout` passes first.
	 */
	generateImage(input: GenerateImageInput, options?: RequestOptions): Promise<CompletedCreation> {
		const { timeout = IMAGE_TIMEOUT_MS, ...rest } = input;
		return this.#generate(rest, timeout, options);
	}

	/**
	 * Generate a video and wait for it: the image is generated first, then
	 * animated with the brand's video model, both paid up front. The creation
	 * returned is the clip; `videoUrl` is the file.
	 */
	generateVideo(input: GenerateVideoInput, options?: RequestOptions): Promise<CompletedCreation> {
		const { timeout = VIDEO_TIMEOUT_MS, aspectRatio = "story", ...rest } = input;
		return this.#generate({ ...rest, aspectRatio, mediaType: "video" }, timeout, options);
	}

	/**
	 * Long-poll a creation until it completes or fails. Use it to resume after a
	 * `WaitTimeoutError`, or to finish a generation started elsewhere.
	 */
	async waitFor(id: string, options: WaitOptions = {}): Promise<CompletedCreation> {
		return this.#settle(null, id, Date.now() + (options.timeout ?? VIDEO_TIMEOUT_MS), options.signal);
	}

	async #generate(
		input: Omit<GenerateImageInput, "timeout"> & Pick<CreationInput, "mediaType" | "motionPrompt" | "durationSeconds" | "soundId">,
		timeout: number,
		options: RequestOptions = {}
	): Promise<CompletedCreation> {
		const deadline = Date.now() + timeout;
		const { idempotencyKey = options.idempotencyKey, prompt, idea, ...shape } = input;
		let composed = { prompt, idea };
		if (!prompt) {
			if (!idea) {
				throw new TopicsError("Pass an `idea`, or a full `prompt`.");
			}

			// Composing is a model call, so a retry would write a different prompt. Keying it means a
			// replay returns the first prompt, and the create below stays the same request.
			const result = await this.compose(
				{ idea, castMemberId: shape.castMemberId },
				{ ...options, idempotencyKey: idempotencyKey ? `${idempotencyKey}:compose` : undefined }
			);
			composed = { prompt: result.prompt, idea: result.idea };
		}

		const created = await this.create({ ...shape, prompt: composed.prompt!, idea: composed.idea }, { ...options, idempotencyKey });
		return this.#settle(created, created.id, deadline, options.signal);
	}

	async #settle(initial: Creation | null, id: string, deadline: number, signal: AbortSignal | undefined): Promise<CompletedCreation> {
		let creation = initial;
		while (creation === null || creation.status === "pending" || creation.status === "generating") {
			const remaining = Math.floor((deadline - Date.now()) / 1000);
			if (remaining <= 0 && creation !== null) {
				throw new WaitTimeoutError(creation);
			}

			const wait = Math.max(0, Math.min(WAIT_LEG_SECONDS, remaining));
			creation = await this.get(id, { wait }, { signal, timeout: (wait + 30) * 1000 });
		}

		if (creation.status === "failed") {
			throw new GenerationFailedError(creation);
		}

		return creation as CompletedCreation;
	}
}
