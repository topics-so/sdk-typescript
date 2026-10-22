# @topics-so/sdk

## 0.1.2

### Patch Changes

- The source is public at [github.com/topics-so/sdk-typescript](https://github.com/topics-so/sdk-typescript), and releases are published from there with npm provenance.

## 0.1.1

### Patch Changes

- A fuller README: a method reference for every endpoint, generated from the spec, plus guides for errors, retries, timeouts, multiple brands, and Next.js. The OpenAPI spec is importable as `@topics-so/sdk/openapi.json`, and the package ships its MIT license.

## 0.1.0

### Minor Changes

- First release. `new Topics({ apiKey })` exposes every endpoint as a typed method (`topics.series.items.skip(seriesId, itemId)`), with typed errors per API error code, automatic retries that reuse one idempotency key, `for await` pagination, `.withResponse()` for headers and request ids, and helpers for generating images and videos, waiting on creations, and uploading assets.
