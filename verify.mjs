import { readFileSync, existsSync } from "node:fs";

let exitCode = 0;

// --- Rolldown (via Vite) ---
const rolldownEntry = "dist/vite/entry-a.js";
if (existsSync(rolldownEntry)) {
	const code = readFileSync(rolldownEntry, "utf8");
	const exportLines = code.match(/^export \{.*\};$/m);

	const exports = exportLines
		? exportLines[0]
				.replace(/^export \{/, "")
				.replace(/\};?$/, "")
				.split(",")
				.map((s) => s.trim())
		: [];

	const valid = new Set([
		"GET", "POST", "PATCH", "PUT", "DELETE",
		"OPTIONS", "HEAD", "fallback", "prerender",
		"trailingSlash", "config", "entries",
	]);

	const leaked = exports.filter((e) => {
		const name = e.includes(" as ") ? e.split(" as ")[1] : e;
		return !valid.has(name) && !name.startsWith("_");
	});

	if (leaked.length > 0) {
		console.error("FAIL  rolldown: leaked exports from entry-a.js:");
		for (const e of leaked) {
			console.error(`        ${e}`);
		}
		console.error(`        full export line: ${exportLines[0]}`);
		exitCode = 1;
	} else {
		console.log("PASS  rolldown: entry-a.js only exports valid names");
	}
} else {
	console.error("SKIP  rolldown: dist/vite/entry-a.js not found (run `pnpm build:vite` first)");
	exitCode = 1;
}

// --- Rollup ---
const rollupEntry = "dist/rollup/entry-a.js";
if (existsSync(rollupEntry)) {
	const code = readFileSync(rollupEntry, "utf8");
	const exportLines = [...code.matchAll(/^export \{.*\};?$/gm)].map((m) => m[0]);

	const allExports = exportLines
		.flatMap((line) =>
			line
				.replace(/^export \{/, "")
				.replace(/\};?$/, "")
				.split(",")
				.map((s) => s.trim()),
		)
		.filter(Boolean);

	const leaked = allExports.filter((e) => {
		const name = e.includes(" as ") ? e.split(" as ")[1] : e;
		return !valid.has(name) && !name.startsWith("_");
	});

	if (leaked.length > 0) {
		console.error("FAIL  rollup: leaked exports from entry-a.js:");
		for (const e of leaked) {
			console.error(`        ${e}`);
		}
		exitCode = 1;
	} else {
		console.log("PASS  rollup: entry-a.js only exports valid names");
	}
} else {
	console.error("SKIP  rollup: dist/rollup/entry-a.js not found (run `pnpm build:rollup` first)");
	exitCode = 1;
}

process.exit(exitCode);
