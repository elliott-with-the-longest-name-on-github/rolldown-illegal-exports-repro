import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
	input: {
		"entry-a": "src/entry-a.js",
		"entry-b": "src/entry-b.js",
	},
	output: {
		dir: "dist/rollup",
		format: "esm",
		entryFileNames: "[name].js",
		chunkFileNames: "chunks/[name].js",
	},
	preserveEntrySignatures: "strict",
	external: [],
	plugins: [
		nodeResolve({ preferBuiltins: true, exportConditions: ["import", "node", "default"] }),
		commonjs({ transformMixedEsModules: true }),
	],
};
