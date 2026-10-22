import type { CoreClient } from "./client";

export class APIResource {
	protected readonly _client: CoreClient;

	constructor(client: CoreClient) {
		this._client = client;
	}
}
