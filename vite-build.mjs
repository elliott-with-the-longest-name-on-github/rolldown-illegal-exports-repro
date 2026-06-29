import { build } from "vite";

await build({
	configFile: false,
	logLevel: "info",
	ssr: { noExternal: true },
	build: {
		ssr: true,
		outDir: "dist/vite",
		target: "node22",
		rollupOptions: {
			input: {
				"entry-a": "src/entry-a.js",
				"entry-b": "src/entry-b.js",
			},
			output: {
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name].js",
			},
			preserveEntrySignatures: "strict",
		},
	},
});
