import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationFailedError, Page, Topics, TopicsError, WaitTimeoutError } from "../src/index";
import { fakeFetch, json } from "./fakeFetch";

const client = (fetch: typeof globalThis.fetch) => new Topics({ apiKey: "tso_test", fetch });
const creation = (status: string, extra: object = {}) => ({ id: "cr_1", status, url: null, error: null, ...extra });

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("pagination", () => {
	const page = (n: number, pageCount: number, ids: string[]) =>
		json({ data: ids.map((id) => ({ id })), pagination: { page: n, perPage: 2, total: 5, pageCount } });

	it("awaits to the first page", async () => {
		const { fetch } = fakeFetch(page(1, 3, ["a", "b"]));
		const first = await client(fetch).posts.list({ perPage: 2 });
		expect(first).toBeInstanceOf(Page);
		expect(first.data).toEqual([{ id: "a" }, { id: "b" }]);
		expect(first.hasNextPage()).toBe(true);
	});

	it("walks every item across every page with for await, keeping the filters", async () => {
		const { fetch, calls } = fakeFetch(page(1, 3, ["a", "b"]), page(2, 3, ["c", "d"]), page(3, 3, ["e"]));
		const ids: string[] = [];
		for await (const post of client(fetch).posts.list({ perPage: 2, platform: "instagram" })) {
			ids.push(post.id);
		}

		expect(ids).toEqual(["a", "b", "c", "d", "e"]);
		expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual([null, "2", "3"]);
		expect(calls.every((call) => call.url.searchParams.get("platform") === "instagram")).toBe(true);
	});

	it("treats an unpaged list as a single page", async () => {
		const { fetch } = fakeFetch(json({ data: [{ id: "s_1" }] }));
		const sounds = await client(fetch).sounds.list();
		expect(sounds.pagination).toBeNull();
		expect(sounds.hasNextPage()).toBe(false);
		expect(() => sounds.nextPage()).toThrow(TopicsError);
	});
});

describe("creations.generateImage", () => {
	it("composes, creates, and long-polls to the finished image", async () => {
		const { fetch, calls } = fakeFetch(
			json({ idea: "Sunrise", prompt: "A sunrise, warm light" }),
			json(creation("pending"), 202),
			json(creation("generating")),
			json(creation("complete", { url: "https://media.topics.so/cr_1.jpg" }))
		);
		const image = await client(fetch).creations.generateImage({ idea: "Sunrise", aspectRatio: "landscape", castMemberId: "cm_1" });
		expect(image.url).toBe("https://media.topics.so/cr_1.jpg");
		expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
			"POST /api/v1/creations/compose",
			"POST /api/v1/creations",
			"GET /api/v1/creations/cr_1",
			"GET /api/v1/creations/cr_1"
		]);
		expect(calls[0].body).toEqual({ idea: "Sunrise", castMemberId: "cm_1" });
		expect(calls[1].body).toEqual({ prompt: "A sunrise, warm light", idea: "Sunrise", aspectRatio: "landscape", castMemberId: "cm_1" });
		expect(calls[2].url.searchParams.get("wait")).toBe("60");
	});

	it("keys both steps from one idempotency key, so a rerun replays the same prompt", async () => {
		const { fetch, calls } = fakeFetch(json({ idea: "i", prompt: "p" }), json(creation("complete", { url: "u" }), 202));
		await client(fetch).creations.generateImage({ idea: "i", aspectRatio: "square", idempotencyKey: "post-7-hero" });
		expect(calls[0].headers.get("idempotency-key")).toBe("post-7-hero:compose");
		expect(calls[1].headers.get("idempotency-key")).toBe("post-7-hero");
	});

	it("skips composing when given a full prompt", async () => {
		const { fetch, calls } = fakeFetch(json(creation("complete", { url: "u" }), 202));
		await client(fetch).creations.generateImage({ prompt: "verbatim", aspectRatio: "square" });
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toMatchObject({ prompt: "verbatim" });
	});

	it("needs an idea or a prompt", async () => {
		const { fetch } = fakeFetch();
		await expect(client(fetch).creations.generateImage({ aspectRatio: "square" })).rejects.toThrow(/idea/);
	});

	it("throws GenerationFailedError carrying the creation", async () => {
		const { fetch } = fakeFetch(json(creation("pending"), 202), json(creation("failed", { error: "Model refused" })));
		const error = await client(fetch)
			.creations.generateImage({ prompt: "p", aspectRatio: "square" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GenerationFailedError);
		expect((error as GenerationFailedError).message).toBe("Model refused");
		expect((error as GenerationFailedError).creation.id).toBe("cr_1");
	});

	it("throws WaitTimeoutError with the pending creation when time runs out", async () => {
		const { fetch } = fakeFetch(json(creation("pending"), 202), () => {
			vi.advanceTimersByTime(2_000);
			return json(creation("generating"));
		});
		const error = await client(fetch)
			.creations.generateImage({ prompt: "p", aspectRatio: "square", timeout: 1_500 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WaitTimeoutError);
		expect((error as WaitTimeoutError).creation.status).toBe("generating");
	});
});

describe("creations.generateVideo", () => {
	it("asks for a video, story-shaped by default", async () => {
		const { fetch, calls } = fakeFetch(json(creation("complete", { url: "cover", videoUrl: "clip" }), 202));
		const clip = await client(fetch).creations.generateVideo({ prompt: "p", motionPrompt: "slow push in", soundId: "snd_1" });
		expect(clip.videoUrl).toBe("clip");
		expect(calls[0].body).toEqual({ prompt: "p", aspectRatio: "story", mediaType: "video", motionPrompt: "slow push in", soundId: "snd_1" });
	});
});

describe("creations.waitFor", () => {
	it("resumes a creation by id", async () => {
		const { fetch, calls } = fakeFetch(json(creation("generating")), json(creation("complete", { url: "u" })));
		const done = await client(fetch).creations.waitFor("cr_1");
		expect(done.status).toBe("complete");
		expect(calls).toHaveLength(2);
	});
});

describe("assets.upload", () => {
	it("presigns, PUTs the bytes, and confirms", async () => {
		const upload = { uploadUrl: "https://bucket.test/put?sig=1", url: "https://media.topics.so/a.jpg", key: "media/a.jpg" };
		const { fetch, calls } = fakeFetch(json(upload, 201), new Response(null, { status: 200 }), json({ id: "as_1" }, 201));
		const asset = await client(fetch).assets.upload(new Uint8Array([1, 2, 3]), { kind: "photo", name: "Balcony", contentType: "image/jpeg" });
		expect(asset).toEqual({ id: "as_1" });
		expect(calls[0].body).toEqual({ kind: "photo", name: "Balcony", contentType: "image/jpeg", size: 3 });
		expect(calls[1]).toMatchObject({ method: "PUT", url: new URL(upload.uploadUrl) });
		expect(calls[1].headers.get("authorization")).toBeNull();
		expect(calls[2].body).toEqual({ kind: "photo", name: "Balcony", key: upload.key, url: upload.url });
	});

	it("takes the content type from a Blob", async () => {
		const { fetch, calls } = fakeFetch(json({ uploadUrl: "https://b.test/u", url: "u", key: "k" }, 201), new Response(null), json({ id: "as_1" }, 201));
		await client(fetch).assets.upload(new Blob(["x"], { type: "image/png" }), { kind: "logo", name: "Logo" });
		expect(calls[0].body).toMatchObject({ contentType: "image/png" });
	});

	it("needs a content type for raw bytes", async () => {
		const { fetch } = fakeFetch();
		await expect(client(fetch).assets.upload(new Uint8Array([1]), { kind: "photo", name: "x" })).rejects.toThrow(/contentType/);
	});
});
