export interface Call {
	url: URL;
	method: string;
	headers: Headers;
	body: unknown;
}

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

/** A fetch that answers from a queue and records every call. */
export function fakeFetch(...replies: Reply[]) {
	const calls: Call[] = [];
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const call: Call = {
			url: new URL(String(input)),
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? JSON.parse(init.body) : init.body
		};
		calls.push(call);
		const reply = replies.shift();
		if (!reply) {
			throw new Error(`Unexpected request: ${call.method} ${call.url}`);
		}

		if (reply instanceof Error) {
			throw reply;
		}

		return typeof reply === "function" ? reply(call) : reply;
	};

	return { fetch: fetch as typeof globalThis.fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers });
}

export function apiError(status: number, code: string, headers: Record<string, string> = {}): Response {
	return json({ error: { code, message: `${code} happened` } }, status, headers);
}
