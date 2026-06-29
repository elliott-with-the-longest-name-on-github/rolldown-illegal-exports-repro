import { defineConfig } from "rolldown";

export default defineConfig({
	input: {
		"entry-a": "src/entry-a.js",
		"entry-b": "src/entry-b.js",
	},
	output: {
		dir: "dist/rolldown",
		format: "esm",
		entryFileNames: "[name].js",
		chunkFileNames: "chunks/[name].js",
	},
	preserveEntrySignatures: "strict",
	platform: "node",
	external: [],
});
