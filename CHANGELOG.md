# @topics-so/sdk

## 0.3.0

### Minor Changes

- b773dc6: `topics.posts.list()` leaves out posts deleted, archived, or made private on the platform; pass `includeRemoved: true` to bring them back. Every post now carries `removedAt`, and `topics.posts.get()` lists only the slides still on the post.

## 0.2.0

### Minor Changes

- c1ccd96: `topics.accounts.list()` returns the brand's connected accounts with their handle, profile picture, profile link and follower count.

## 0.1.2

### Patch Changes

- The source is public at [github.com/topics-so/sdk-typescript](https://github.com/topics-so/sdk-typescript), and releases are published from there with npm provenance.

## 0.1.1

### Patch Changes

- A fuller README: a method reference for every endpoint, generated from the spec, plus guides for errors, retries, timeouts, multiple brands, and Next.js. The OpenAPI spec is importable as `@topics-so/sdk/openapi.json`, and the package ships its MIT license.

## 0.1.0

### Minor Changes

- First release. `new Topics({ apiKey })` exposes every endpoint as a typed method (`topics.series.items.skip(seriesId, itemId)`), with typed errors per API error code, automatic retries that reuse one idempotency key, `for await` pagination, `.withResponse()` for headers and request ids, and helpers for generating images and videos, waiting on creations, and uploading assets.
