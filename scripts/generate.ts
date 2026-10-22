import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Writes the SDK's resource classes from openapi.json. Each operation carries
 * `x-sdk-resource` and `x-sdk-method` (set in lib/api/openapi.ts), so
 * `series.items` + `skip` becomes `topics.series.items.skip(seriesId, itemId)`.
 * The schema types come from openapi-typescript, which runs first; this only
 * names them and wires methods to paths. Run via `pnpm generate`.
 */

interface Parameter {
	name: string;
	in: "path" | "query" | "header";
	required?: boolean;
}

interface Operation {
	"operationId": string;
	"summary": string;
	"description": string;
	"x-sdk-resource": string;
	"x-sdk-method": string;
	"parameters": Parameter[];
	"requestBody"?: { content: { "application/json": { schema: { $ref: string } } } };
	"responses": Record<string, { content?: { "application/json": { schema: { $ref: string } } } }>;
}

interface Schema {
	properties?: Record<string, { type?: string; items?: { $ref?: string } }>;
}

interface Method {
	name: string;
	httpMethod: string;
	path: string;
	operation: Operation;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8")) as {
	paths: Record<string, Record<string, Operation>>;
	components: { schemas: Record<string, Schema> };
};

const refName = (ref: string) => ref.split("/").pop()!;
const pascal = (value: string) => value.replace(/(^|[.-])([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
const className = (resource: string) => `${pascal(resource)}Resource`;

/** Resource path → its methods, keeping spec order so the generated file reads like the docs. */
const resources = new Map<string, Method[]>();
for (const [path, operations] of Object.entries(spec.paths)) {
	for (const [httpMethod, operation] of Object.entries(operations)) {
		const resource = operation["x-sdk-resource"];
		resources.set(resource, [...(resources.get(resource) ?? []), { name: operation["x-sdk-method"], httpMethod, path, operation }]);
	}
}

// A nested resource needs its parent class to hang from, even when the parent has no methods of its own.
for (const resource of [...resources.keys()]) {
	const parts = resource.split(".");
	for (let i = 1; i < parts.length; i++) {
		const parent = parts.slice(0, i).join(".");
		if (!resources.has(parent)) {
			resources.set(parent, []);
		}
	}
}

const usedTypes = new Set<string>();
const paramTypes: string[] = [];

/**
 * Path parameter names as the caller sees them. On a nested resource the
 * parent's `{id}` is renamed after its segment, so `series/{id}/items/{itemId}`
 * reads as `(seriesId, itemId)` rather than `(id, itemId)`.
 */
function pathArgs(path: string, nested: boolean): { spec: string; arg: string }[] {
	const names = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
	return names.map((name) => {
		if (!nested || name !== "id") {
			return { spec: name, arg: name };
		}

		const segment = path.split("/")[path.split("/").indexOf("{id}") - 1];
		const singular = segment === "series" ? "series" : segment.replace(/s$/, "");
		return { spec: name, arg: `${singular.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}Id` };
	});
}

function successSchema(operation: Operation): string | null {
	const [status, response] = Object.entries(operation.responses).find(([code]) => code.startsWith("2"))!;
	if (status === "204") {
		return null;
	}

	return refName(response.content!["application/json"].schema.$ref);
}

/** The item type when a response is a `{ data: T[] }` list, which the SDK serves as a `Page<T>`. */
function listItem(schemaName: string): string | null {
	const data = spec.components.schemas[schemaName]?.properties?.data;
	return data?.type === "array" && data.items?.$ref ? refName(data.items.$ref) : null;
}

function docComment(operation: Operation): string {
	const text = `${operation.summary}.\n\n${operation.description}`.replaceAll("*/", "*\\/");
	return ["\t/**", ...text.split("\n").map((line) => (line ? `\t * ${line}` : "\t *")), "\t */"].join("\n");
}

function renderMethod({ name, httpMethod, path, operation }: Method): string {
	const args = pathArgs(path, operation["x-sdk-resource"].includes("."));
	const params: string[] = args.map(({ arg }) => `${arg}: string`);
	const requestArgs: string[] = [];
	const queryParams = operation.parameters.filter((param) => param.in === "query");
	if (queryParams.length > 0) {
		const typeName = `${pascal(operation["x-sdk-resource"])}${pascal(name)}Params`;
		paramTypes.push(`export type ${typeName} = NonNullable<operations["${operation.operationId}"]["parameters"]["query"]>;`);
		usedTypes.add(typeName);
		const optional = queryParams.every((param) => !param.required);
		params.push(`params${optional ? "?" : ""}: ${typeName}`);
		requestArgs.push("query: params");
	}

	if (operation.requestBody) {
		const bodyType = refName(operation.requestBody.content["application/json"].schema.$ref);
		usedTypes.add(bodyType);
		params.push(`body: ${bodyType}`);
		requestArgs.push("body");
	}

	params.push("options?: RequestOptions");
	requestArgs.push("options");
	let urlPath = path;
	for (const { spec: specName, arg } of args) {
		urlPath = urlPath.replace(`{${specName}}`, `\${encodeURIComponent(${arg})}`);
	}

	const url = args.length > 0 ? `\`${urlPath}\`` : `"${urlPath}"`;
	const schema = successSchema(operation);
	const item = schema && httpMethod === "get" ? listItem(schema) : null;
	let body: string;
	if (item) {
		usedTypes.add(item);
		body = `return this._client.getPage<${item}>(${url}, ${queryParams.length > 0 ? "params" : "undefined"}, options);`;
		return `${docComment(operation)}\n\t${name}(${params.join(", ")}): PagePromise<${item}> {\n\t\t${body}\n\t}`;
	}

	const returnType = schema ?? "void";
	if (schema) {
		usedTypes.add(schema);
	}

	body = `return this._client.request<${returnType}>("${httpMethod}", ${url}, { ${requestArgs.join(", ")} });`;
	return `${docComment(operation)}\n\t${name}(${params.join(", ")}): APIPromise<${returnType}> {\n\t\t${body}\n\t}`;
}

const sortedResources = [...resources.keys()].sort();
const classes = sortedResources.map((resource) => {
	const children = sortedResources.filter((other) => other.startsWith(`${resource}.`) && other.split(".").length === resource.split(".").length + 1);
	const fields = children.map((child) => `\treadonly ${child.split(".").pop()}: ${className(child)} = new ${className(child)}(this._client);`);
	const methods = resources.get(resource)!.map(renderMethod);
	return `export class ${className(resource)} extends APIResource {\n${[...fields, ...methods].join("\n\n")}\n}`;
});

const banner = "// Generated by scripts/generate.ts from openapi.json. Do not edit; run `pnpm generate`.\n";

// Children are declared before their parents so class fields never reference an uninitialized binding.
const ordered = [...classes].sort((a, b) => depthOf(b) - depthOf(a));
function depthOf(source: string): number {
	const name = source.match(/^export class (\w+)/)![1];
	const resource = sortedResources.find((r) => className(r) === name)!;
	return resource.split(".").length;
}

writeFileSync(
	join(root, "src/generated/resources.ts"),
	`${banner}import type { APIPromise } from "../core/apiPromise";
import type { RequestOptions } from "../core/client";
import type { PagePromise } from "../core/pagination";
import { APIResource } from "../core/resource";
import type { ${[...usedTypes].sort().join(", ")} } from "./types";

${ordered.join("\n\n")}
`
);

const schemaNames = Object.keys(spec.components.schemas).sort();
writeFileSync(
	join(root, "src/generated/types.ts"),
	`${banner}import type { components, operations } from "./schema";

${schemaNames.map((name) => `export type ${name} = components["schemas"]["${name}"];`).join("\n")}

${paramTypes.sort().join("\n")}
`
);

const topLevel = sortedResources.filter((resource) => !resource.includes("."));
writeFileSync(
	join(root, "src/generated/client.ts"),
	`${banner}import { CoreClient } from "../core/client";
import { ${topLevel.map(className).join(", ")} } from "./resources";

/** Every resource in the API, one property each. \`Topics\` extends this with the hand-written helpers. */
export class GeneratedClient extends CoreClient {
${topLevel.map((resource) => `\treadonly ${resource}: ${className(resource)} = new ${className(resource)}(this);`).join("\n")}
}
`
);

/**
 * The README's method reference, rewritten between its markers so the npm page
 * lists exactly what this version can call. Resources keep spec order, which is
 * the order the docs use.
 */
function readmeSignature({ name, path, operation }: Method): string {
	const args = pathArgs(path, operation["x-sdk-resource"].includes(".")).map(({ arg }) => arg);
	const queryParams = operation.parameters.filter((param) => param.in === "query");
	if (queryParams.length > 0) {
		args.push(queryParams.every((param) => !param.required) ? "params?" : "params");
	}

	if (operation.requestBody) {
		args.push("body");
	}

	return `${name}(${args.join(", ")})`;
}

const reference = [...resources.entries()]
	.filter(([, methods]) => methods.length > 0)
	.map(([resource, methods]) =>
		[
			`### \`topics.${resource}\``,
			"",
			"| Method | What it does |",
			"| --- | --- |",
			...methods.map(
				(method) => `| \`${readmeSignature(method)}\` | [${method.operation.summary}](https://topics.so/docs/api#${method.operation.operationId}) |`
			)
		].join("\n")
	)
	.join("\n\n");
const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- api-reference:start -->";
const END = "<!-- api-reference:end -->";
if (!readme.includes(START) || !readme.includes(END)) {
	throw new Error(`README.md is missing the ${START} and ${END} markers.`);
}

writeFileSync(readmePath, `${readme.slice(0, readme.indexOf(START) + START.length)}\n\n${reference}\n\n${readme.slice(readme.indexOf(END))}`);

console.log(`Generated ${resources.size} resources and ${[...resources.values()].flat().length} methods.`);
