import { readFileSync, existsSync } from "node:fs";

const valid = new Set([
	"GET", "POST", "PATCH", "PUT", "DELETE",
	"OPTIONS", "HEAD", "fallback", "prerender",
	"trailingSlash", "config", "entries",
]);

function checkExports(file, label) {
	if (!existsSync(file)) {
		console.error(`SKIP  ${label}: ${file} not found (run the build first)`);
		return 1;
	}

	const code = readFileSync(file, "utf8");
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
		console.error(`FAIL  ${label}: leaked exports from entry-a.js:`);
		for (const e of leaked) {
			console.error(`        ${e}`);
		}
		console.error(`        full export line: ${exportLines.join(" | ")}`);
		return 1;
	}

	console.log(`PASS  ${label}: entry-a.js only exports valid names`);
	return 0;
}

let exitCode = 0;
exitCode |= checkExports("dist/rolldown/entry-a.js", "rolldown");
exitCode |= checkExports("dist/rollup/entry-a.js", "rollup");
process.exit(exitCode);
