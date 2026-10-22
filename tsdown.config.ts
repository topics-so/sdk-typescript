import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	platform: "neutral",
	target: "node20",
	define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
	clean: true,
	// Doc comments ship in the .d.ts, where editors read them; in the runtime bundle they'd only triple its size.
	outputOptions: { comments: false }
});
