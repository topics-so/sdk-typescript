import { APIPromise } from "./apiPromise";
import { TopicsError } from "./errors";

export interface Pagination {
	page: number;
	perPage: number;
	total: number;
	pageCount: number;
}

/** Every list endpoint's body. Lists that aren't paged yet omit `pagination`. */
export interface PageResponse<T> {
	data: T[];
	pagination?: Pagination;
}

/**
 * One page of a list. Iterate it with `for await` to walk every item across
 * every page, fetching the next page only when the current one runs out.
 */
export class Page<T> implements AsyncIterable<T> {
	readonly data: T[];
	/** Null for lists that come back whole. */
	readonly pagination: Pagination | null;
	readonly #fetchPage: (page: number) => Promise<Page<T>>;

	constructor(body: PageResponse<T>, fetchPage: (page: number) => Promise<Page<T>>) {
		this.data = body.data;
		this.pagination = body.pagination ?? null;
		this.#fetchPage = fetchPage;
	}

	hasNextPage(): boolean {
		return this.pagination !== null && this.pagination.page < this.pagination.pageCount;
	}

	nextPage(): Promise<Page<T>> {
		if (!this.hasNextPage()) {
			throw new TopicsError("This is the last page. Check hasNextPage() first.");
		}

		return this.#fetchPage(this.pagination!.page + 1);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		let page: Page<T> = this;
		while (true) {
			yield* page.data;
			if (!page.hasNextPage()) {
				return;
			}

			page = await page.nextPage();
		}
	}
}

/** A list call: await it for the first page, or `for await` it for every item. */
export class PagePromise<T> extends APIPromise<Page<T>> implements AsyncIterable<T> {
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		yield* await this;
	}
}
