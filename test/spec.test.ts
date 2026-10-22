import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APIError, Topics } from "../src/index";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));

/** The generated client and the hand-written error map both have to keep up with the spec. */
describe("coverage of the spec", () => {
	const topics = new Topics({ apiKey: "tso_test" });

	it("has a method for every operation", () => {
		for (const operations of Object.values(spec.paths) as Record<string, Record<string, string>>[]) {
			for (const operation of Object.values(operations)) {
				const resource = operation["x-sdk-resource"]
					.split(".")
					.reduce((node: Record<string, unknown>, key: string) => node[key] as Record<string, unknown>, topics as never);
				expect(typeof resource[operation["x-sdk-method"]], operation.operationId).toBe("function");
			}
		}
	});

	it("maps every error code to its own class", () => {
		const codes: string[] = spec.components.schemas.Error.properties.error.properties.code.enum;
		for (const code of codes) {
			const error = APIError.from(400, { error: { code, message: "m" } }, new Headers());
			expect(error.constructor, code).not.toBe(APIError);
		}
	});
});
