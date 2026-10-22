import type { RequestOptions } from "../core/client";
import { TopicsError } from "../core/errors";
import { AssetsResource } from "../generated/resources";
import type { Asset, AssetUploadInput } from "../generated/types";

export interface UploadInput {
	kind: AssetUploadInput["kind"];
	name: string;
	/** Required unless `file` is a `Blob` or `File` that already carries its type. */
	contentType?: AssetUploadInput["contentType"];
}

export class Assets extends AssetsResource {
	/**
	 * Upload a file to the asset library in one call: presign, PUT the bytes
	 * straight to storage, then confirm. Takes a `Blob`, a `File`, or raw bytes
	 * (a Node `Buffer` is a `Uint8Array`). For a file already at a public URL,
	 * `create({ sourceUrl })` is simpler.
	 */
	async upload(file: Blob | ArrayBuffer | Uint8Array, input: UploadInput, options?: RequestOptions): Promise<Asset> {
		const blob = file instanceof Blob ? file : new Blob([file as BlobPart]);
		const contentType = input.contentType ?? (blob.type as AssetUploadInput["contentType"]);
		if (!contentType) {
			throw new TopicsError("Pass `contentType`: the file doesn't carry one.");
		}

		const upload = await this.createUpload({ kind: input.kind, name: input.name, contentType, size: blob.size }, options);
		const put = await this._client._fetch(upload.uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": contentType },
			body: blob,
			signal: options?.signal
		});
		if (!put.ok) {
			throw new TopicsError(`The upload to storage failed with ${put.status}.`);
		}

		return this.create({ kind: input.kind, name: input.name, key: upload.key, url: upload.url }, options);
	}
}
