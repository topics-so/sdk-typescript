# Topics.so TypeScript SDK

[![npm version](https://img.shields.io/npm/v/@topics-so/sdk?color=000&label=npm)](https://www.npmjs.com/package/@topics-so/sdk)
[![bundle size](https://img.shields.io/bundlejs/size/@topics-so/sdk?color=000)](https://bundlejs.com/?q=@topics-so/sdk)
[![types](https://img.shields.io/npm/types/@topics-so/sdk?color=000)](https://www.npmjs.com/package/@topics-so/sdk)
[![license](https://img.shields.io/npm/l/@topics-so/sdk?color=000)](./LICENSE)

The official TypeScript client for the [Topics.so](https://topics.so) API.

Read every post and its metrics. Generate on-brand images and reels from one line of text. Run series and autopilot from your own code.

```ts
import { Topics } from "@topics-so/sdk";

const topics = new Topics();

const image = await topics.creations.generateImage({
	idea: "Morning espresso ritual, warm window light",
	aspectRatio: "landscape"
});
```

## Why this SDK

- **Every endpoint, typed.** Each one is a method named for what it does, with editor docs on every field.
- **Generation in one call.** `generateImage` and `generateVideo` compose, create, and wait for the finished file.
- **Safe to retry.** Every POST carries an idempotency key, so a retry never spends credits twice.
- **Errors you can branch on.** Each API error has its own class, and each carries a request id.
- **Lists that page themselves.** Walk every post with `for await`.
- **Small and dependency-free.** About 3 kB, on Node.js, Bun, Deno, and edge runtimes.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Images and video](#images-and-video)
- [Lists](#lists)
- [Uploads](#uploads)
- [Errors](#errors)
- [Retries and idempotency](#retries-and-idempotency)
- [Timeouts and cancellation](#timeouts-and-cancellation)
- [Configuration](#configuration)
- [Using it with Next.js](#using-it-with-nextjs)
- [Types](#types)
- [API reference](#api-reference)
- [Versioning](#versioning)
- [Support](#support)
- [Source and contributing](#source-and-contributing)

## Install

```bash
npm install @topics-so/sdk
# or
pnpm add @topics-so/sdk
# or
bun add @topics-so/sdk
```

Requires Node.js 20 or later, or any runtime with a standard `fetch`. Works from ESM and CommonJS.

## Quickstart

Create an API key in your Topics.so dashboard under **API**, choose its scopes, and set it in your environment:

```bash
TOPICS_API_KEY=tso_…
```

The client reads `TOPICS_API_KEY` on its own:

```ts
import { Topics } from "@topics-so/sdk";

const topics = new Topics();

const { available } = await topics.credits.get();
const kit = await topics.brandKit.get();
const post = await topics.posts.get("cm8xk21p40001s6014r9e2n7q");
```

> [!IMPORTANT]
> A key is a secret. Use the SDK from a server, a background job, or a build step, never from browser code. Constructing a client in a browser throws.

## Images and video

`generateImage` composes a prompt from your idea with the brand's style and cast, starts the generation, and waits for the finished file. The brand's base style, cast member, and reference photos are applied for you.

```ts
const image = await topics.creations.generateImage({
	idea: `${post.title}: ${post.summary}`,
	aspectRatio: "landscape",
	castMemberId: "cm_…",
	overlay: { template: "headline", text: post.title },
	idempotencyKey: `post-${post.id}-hero`
});

image.url; // the finished image, always a string
```

Pass `prompt` instead of `idea` to use a prompt word for word.

`generateVideo` takes the same input, plus `motionPrompt`, `durationSeconds`, and `soundId`. It generates a still, animates it, and returns the clip. `aspectRatio` defaults to `story`.

```ts
const clip = await topics.creations.generateVideo({
	idea: "Pouring espresso, slow motion",
	motionPrompt: "Slow push in",
	soundId: "snd_…"
});

clip.videoUrl;
```

Both throw `GenerationFailedError` when generation fails, and `WaitTimeoutError` when their `timeout` passes first. After a timeout the creation is still running, so you can pick it up later:

```ts
import { WaitTimeoutError } from "@topics-so/sdk";

try {
	await topics.creations.generateVideo({ idea, timeout: 60_000 });
} catch (error) {
	if (error instanceof WaitTimeoutError) {
		await saveForLater(error.creation.id);
	}
}

// Later, from a cron:
const clip = await topics.creations.waitFor(creationId);
```

To control each step yourself, the plain methods are there too: `creations.compose`, `creations.create`, and `creations.get(id, { wait: 60 })`.

## Lists

A list method returns a page. Await it for one page, or `for await` it to walk every item. The next page is fetched only when the current one runs out.

```ts
for await (const post of topics.posts.list({ platform: "instagram", sort: "views" })) {
	console.log(post.title, post.metrics.views);
}

const page = await topics.posts.list({ perPage: 50 });
page.data; // Post[]
page.pagination; // { page, perPage, total, pageCount }

if (page.hasNextPage()) {
	const next = await page.nextPage();
}
```

## Uploads

```ts
import { readFile } from "node:fs/promises";

const photo = await topics.assets.upload(await readFile("maya.jpg"), {
	kind: "castReference",
	name: "Maya, front-lit",
	contentType: "image/jpeg"
});
```

`upload` takes a `Blob`, a `File`, or bytes, and sends them straight to storage. For a file already at a public URL, `create` is simpler:

```ts
await topics.assets.create({ kind: "inspiration", name: "Balcony light", sourceUrl: "https://…" });
```

## Errors

Every error extends `TopicsError`. Each API error code has its own class:

| Class                      | Status | When                                                      |
| -------------------------- | ------ | --------------------------------------------------------- |
| `BadRequestError`          | 400    | A parameter or body field is missing or invalid.          |
| `AuthenticationError`      | 401    | The key is missing, unknown, or revoked.                  |
| `InsufficientCreditsError` | 402    | The brand is out of credits.                              |
| `PermissionDeniedError`    | 403    | The key lacks a scope.                                    |
| `PlanRequiredError`        | 403    | The brand's plan doesn't include this.                    |
| `NotFoundError`            | 404    | Nothing with that id exists in this brand.                |
| `ConflictError`            | 409    | The resource isn't in a state that allows this.           |
| `RateLimitError`           | 429    | Too many requests this second. Retried for you.           |
| `QuotaExceededError`       | 429    | The month's request quota is spent. `resetsAt` says when. |
| `ServiceUnavailableError`  | 503    | Something upstream didn't answer. Retried for you.        |
| `InternalServerError`      | 5xx    | Something went wrong on our side. Retried for you.        |
| `APIConnectionError`       |        | The request never got an answer.                          |
| `APITimeoutError`          |        | The request took longer than its `timeout`.               |
| `APIUserAbortError`        |        | Your `signal` aborted the request.                        |
| `GenerationFailedError`    |        | A generation finished as `failed`.                        |
| `WaitTimeoutError`         |        | A wait ran out before the generation finished.            |

An `APIError` carries `status`, `code`, `message`, `requestId`, and `headers`. Quote the request id when you contact us.

```ts
import { InsufficientCreditsError, TopicsError } from "@topics-so/sdk";

try {
	await topics.creations.generateImage({ idea, aspectRatio: "square" });
} catch (error) {
	if (error instanceof InsufficientCreditsError) {
		// Top up, or wait for the monthly reset.
	} else if (error instanceof TopicsError) {
		console.error(error.message);
	}
}
```

## Retries and idempotency

Connection errors, timeouts, rate limits, and 5xx responses are retried twice, with exponential backoff and jitter. A `Retry-After` from the API is honoured. A used-up monthly quota is never retried.

Every POST carries an `Idempotency-Key`, the same one on every retry of that call. The API replays the first response instead of running the request again, so a retry never spends credits twice.

That covers retries within one call. To make a call safe to repeat after a crash or a redeploy, pass your own key, built from your own record:

```ts
await topics.creations.generateImage({ idea, aspectRatio: "square", idempotencyKey: `article-${article.id}` });
await topics.series.items.publish(seriesId, itemId, { idempotencyKey: `publish-${itemId}` });
```

Keys replay for 24 hours. Reusing a key with a different request is a `ConflictError`.

## Timeouts and cancellation

Each request times out after 90 seconds by default. Override it on the client, or per call:

```ts
const topics = new Topics({ timeout: 30_000, maxRetries: 4 });

await topics.posts.list({ perPage: 100 }, { timeout: 10_000 });
```

Pass an `AbortSignal` to cancel:

```ts
const controller = new AbortController();
const pending = topics.creations.generateImage({ idea, aspectRatio: "square" }, { signal: controller.signal });
controller.abort();
```

## Configuration

```ts
const topics = new Topics({
	apiKey: process.env.TOPICS_API_KEY, // default
	baseUrl: "https://topics.so/api", // default; TOPICS_BASE_URL overrides it
	timeout: 90_000, // per request, in ms
	maxRetries: 2,
	fetch: customFetch, // for tests or proxies
	defaultHeaders: { "X-Trace": "…" }
});
```

Every method takes per-call options as its last argument: `signal`, `timeout`, `maxRetries`, `idempotencyKey`, and `headers`.

### More than one brand

A key belongs to one brand. Make one client per key with `withOptions`, which keeps every other setting:

```ts
const acme = new Topics({ apiKey: process.env.TOPICS_KEY_ACME });
const recovery = acme.withOptions({ apiKey: process.env.TOPICS_KEY_RECOVERY });
```

### Headers and rate limits

Every method returns a promise with `.withResponse()`, for the data together with the raw response:

```ts
const { data, requestId, rateLimit, response } = await topics.credits.get().withResponse();

rateLimit.remaining; // requests left this second
rateLimit.quotaRemaining; // requests left this month
```

## Using it with Next.js

Create one client in a server-only module and import it where you need it:

```ts
// lib/topics.ts
import "server-only";
import { Topics } from "@topics-so/sdk";

export const topics = new Topics();
```

```ts
// app/actions.ts
"use server";
import { topics } from "@/lib/topics";

export async function generateHero(postId: string, idea: string) {
	const image = await topics.creations.generateImage({ idea, aspectRatio: "landscape", idempotencyKey: `post-${postId}-hero` });
	return image.url;
}
```

Metrics refresh every 30 minutes, so cache reads at least that long. The [caching guide](https://topics.so/docs/api#caching) has patterns for `fetch` revalidation and in-memory caches.

## Types

Every schema in the API is exported by name: `Creation`, `Series`, `SeriesItem`, `Post`, `CastMember`, `BrandKit`, and the rest. Parameter types are exported as `PostsListParams` and so on.

```ts
import type { Post, SeriesItem } from "@topics-so/sdk";
```

The raw `paths`, `components`, and `operations` types are exported too, and the OpenAPI spec itself ships in the package as `@topics-so/sdk/openapi.json`.

## API reference

Every method below links to its full reference, with parameters, responses, and the scope it needs. The helpers `creations.generateImage`, `creations.generateVideo`, `creations.waitFor`, and `assets.upload` are described above.

<!-- api-reference:start -->

### `topics.posts`

| Method | What it does |
| --- | --- |
| `list(params?)` | [List posts](https://topics.so/docs/api#list-posts) |
| `get(id)` | [Retrieve a post](https://topics.so/docs/api#get-post) |

### `topics.brandKit`

| Method | What it does |
| --- | --- |
| `get()` | [Get the brand kit](https://topics.so/docs/api#get-brand-kit) |
| `update(body)` | [Update the brand kit](https://topics.so/docs/api#update-brand-kit) |

### `topics.credits`

| Method | What it does |
| --- | --- |
| `get()` | [Get credits](https://topics.so/docs/api#get-credits) |

### `topics.assets`

| Method | What it does |
| --- | --- |
| `list(params?)` | [List assets](https://topics.so/docs/api#list-assets) |
| `create(body)` | [Add an asset](https://topics.so/docs/api#create-asset) |
| `createUpload(body)` | [Start a direct upload](https://topics.so/docs/api#create-asset-upload) |
| `delete(id)` | [Delete an asset](https://topics.so/docs/api#delete-asset) |

### `topics.sounds`

| Method | What it does |
| --- | --- |
| `list()` | [List sounds](https://topics.so/docs/api#list-sounds) |
| `create(body)` | [Add a sound](https://topics.so/docs/api#create-sound) |
| `search(params?)` | [Search Instagram's sounds](https://topics.so/docs/api#search-sounds) |
| `update(id, body)` | [Edit a sound](https://topics.so/docs/api#update-sound) |
| `delete(id)` | [Remove a sound](https://topics.so/docs/api#delete-sound) |

### `topics.castMembers`

| Method | What it does |
| --- | --- |
| `list()` | [List cast members](https://topics.so/docs/api#list-cast-members) |
| `create(body)` | [Create a cast member](https://topics.so/docs/api#create-cast-member) |
| `get(id)` | [Retrieve a cast member](https://topics.so/docs/api#get-cast-member) |
| `update(id, body)` | [Update a cast member](https://topics.so/docs/api#update-cast-member) |
| `delete(id)` | [Delete a cast member](https://topics.so/docs/api#delete-cast-member) |

### `topics.creations`

| Method | What it does |
| --- | --- |
| `list(params?)` | [List creations](https://topics.so/docs/api#list-creations) |
| `create(body)` | [Generate an image or a video](https://topics.so/docs/api#create-creation) |
| `compose(body)` | [Compose a prompt](https://topics.so/docs/api#compose-prompt) |
| `get(id, params?)` | [Retrieve a creation](https://topics.so/docs/api#get-creation) |
| `delete(id)` | [Delete a creation](https://topics.so/docs/api#delete-creation) |
| `retry(id)` | [Retry a creation](https://topics.so/docs/api#retry-creation) |
| `animate(id, body)` | [Animate into a reel](https://topics.so/docs/api#animate-creation) |
| `rerenderOverlay(id, body)` | [Re-render the overlay](https://topics.so/docs/api#rerender-overlay) |

### `topics.series`

| Method | What it does |
| --- | --- |
| `list()` | [List series](https://topics.so/docs/api#list-series) |
| `create(body)` | [Create a series](https://topics.so/docs/api#create-series) |
| `get(id)` | [Retrieve a series](https://topics.so/docs/api#get-series) |
| `update(id, body)` | [Update a series](https://topics.so/docs/api#update-series) |
| `delete(id)` | [Delete a series](https://topics.so/docs/api#delete-series) |
| `runReview(id)` | [Run the strategist now](https://topics.so/docs/api#run-series-review) |

### `topics.series.items`

| Method | What it does |
| --- | --- |
| `create(seriesId, body)` | [Add a post to a series](https://topics.so/docs/api#add-series-item) |
| `skip(seriesId, itemId)` | [Skip a slot](https://topics.so/docs/api#skip-item) |
| `regenerate(seriesId, itemId)` | [Regenerate a slot](https://topics.so/docs/api#regenerate-item) |
| `update(seriesId, itemId, body)` | [Edit a slot](https://topics.so/docs/api#update-item) |
| `delete(seriesId, itemId)` | [Delete a slot](https://topics.so/docs/api#delete-item) |
| `rewriteCaption(seriesId, itemId)` | [Rewrite a slot's caption](https://topics.so/docs/api#rewrite-item-caption) |
| `publish(seriesId, itemId)` | [Publish a slot now](https://topics.so/docs/api#publish-item) |
| `markPosted(seriesId, itemId, body)` | [Mark a hand-off as posted](https://topics.so/docs/api#mark-item-posted) |

### `topics.members`

| Method | What it does |
| --- | --- |
| `list()` | [List members](https://topics.so/docs/api#list-members) |
| `updateRole(id, body)` | [Change a member's role](https://topics.so/docs/api#update-member-role) |

### `topics.invitations`

| Method | What it does |
| --- | --- |
| `list()` | [List invitations](https://topics.so/docs/api#list-invitations) |
| `create(body)` | [Invite someone](https://topics.so/docs/api#create-invitation) |
| `cancel(id)` | [Cancel an invitation](https://topics.so/docs/api#cancel-invitation) |

### `topics.brands`

| Method | What it does |
| --- | --- |
| `list()` | [List brands](https://topics.so/docs/api#list-brands) |
| `create(body)` | [Create a brand](https://topics.so/docs/api#create-brand) |
| `update(id, body)` | [Update a brand](https://topics.so/docs/api#update-brand) |

<!-- api-reference:end -->

## Versioning

This package follows semantic versioning. New endpoints and fields arrive in minor releases. A breaking change to the API would come as a new `/v2` and a new major version. Every release is in the [changelog](./CHANGELOG.md).

## Support

- Docs: [topics.so/docs/api](https://topics.so/docs/api)
- Plain-text docs for AI tools: [topics.so/docs/api.md](https://topics.so/docs/api.md)
- Bugs and requests: [GitHub issues](https://github.com/topics-so/sdk-typescript/issues)
- Email: [support@topics.so](mailto:support@topics.so)

## Source and contributing

This repository is a mirror. The SDK is generated from the Topics.so API's own OpenAPI spec, in the same commit as the API change it covers, and copied here on every release. Issues and pull requests are welcome. A fix that lands here is carried into the generator, so the next release keeps it.

Every release on npm is published from this repository's [release workflow](./.github/workflows/release.yml) with a provenance attestation.

## License

MIT
