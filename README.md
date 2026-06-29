# Vite's rolldown integration leaks `__commonJSMin` wrappers as top-level ESM exports

Minimal reproduction of a bug where Vite's rolldown integration incorrectly exports internal `__commonJSMin` wrapper functions (rolldown's CJS interop helpers) as top-level ESM exports from entry chunks.

**Important**: This bug does **not** reproduce with rolldown CLI directly — only when rolldown is driven by Vite (via `ssr.noExternal` + Vite's CJS plugin pipeline). Rolldown CLI correctly keeps the wrappers in shared chunks. Rollup also does not exhibit this behavior.

## The bug

When a CJS dependency (e.g. `@vercel/oidc`, used via `@vercel/sandbox`) contains modules that **both** statically `require()` and dynamically `import()` each other, Vite's rolldown integration inlines the CJS modules and dynamic `import()` calls into the entry chunk. The dynamic `import()` becomes `Promise.resolve().then(() => __toESM(require_x()))`. However, the internal `__commonJSMin` wrapper functions (`require_token_error`, `require_token_util`) are also leaked as **top-level ESM exports** of the entry chunk — with minified names (`n`, `t`).

### Three-way comparison

The entry source (`src/entry-a.js`) only exports `POST`:

```js
import { Sandbox } from "@vercel/sandbox";

export const POST = async (event) => {
	const sandbox = await Sandbox.create({ teamId: "test", token: "test", projectId: "test" });
	return new Response(JSON.stringify({ id: sandbox.id }));
};
```

| Bundler | Entry exports | CJS wrappers | Dynamic `import()` |
|---|---|---|---|
| **rolldown CLI** 1.0.0 | `export { POST }` | In shared chunks | Preserved as real `import()` |
| **Vite** 8.0.12 (rolldown) | `export { POST, require_token_error as n, require_token_util as t }` | **Inlined into entry** | **Inlined** as `Promise.resolve().then(() => __toESM(require_x()))` |
| **Rollup** 4.62.2 | `export { P as POST }` | In shared chunks | Preserved as real `import()` |

### What Vite's output looks like

`dist/vite/entry-a.js`:

```js
// line 24880 — internal CJS wrapper, should NOT be exported
var require_token_error = /* @__PURE__ */ __commonJSMin(((exports, module) => { ... }));

// line 25229 — internal CJS wrapper, should NOT be exported
var require_token_util = /* @__PURE__ */ __commonJSMin(((exports, module) => { ... }));

// line 24956 — inlined dynamic import referencing the wrapper
const [...] = await Promise.all([
  await Promise.resolve().then(() => __toESM(require_token_util())),
  ...
]);

// line 27778 — THE BUG: wrappers leaked as exports with minified names
export { POST, require_token_error as n, require_token_util as t };
```

### Why rolldown CLI doesn't reproduce it

Rolldown CLI keeps the CJS modules in shared chunks and preserves the dynamic `import()` as a real `import()` call. The `__commonJSMin` wrappers exist (146 occurrences in the output) but are scoped to shared chunks, never leaked as entry exports. Vite's `ssr.noExternal: true` and its CJS plugin pipeline cause rolldown to make different chunking decisions — inlining the CJS modules and dynamic imports into the entry chunk, which is where the wrapper leak occurs.

## Real-world impact

This breaks **SvelteKit** deployments. SvelteKit's postbuild analysis (`@sveltejs/kit` `src/core/postbuild/analyse.js`) validates endpoint exports against an allowlist (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`, `OPTIONS`, `HEAD`, `fallback`, `prerender`, `trailingSlash`, `config`, `entries`, or `_`-prefixed names). The leaked export `n` (which is `require_token_error`) fails validation:

```
Error: Invalid export 'i' in /.well-known/workflow/v1/step
  (valid exports are GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD, fallback,
   prerender, trailingSlash, config, entries, or anything with a '_' prefix)

  at validate (.../@sveltejs/kit/src/utils/exports.js:21:10)
  at analyse_endpoint (.../@sveltejs/kit/src/core/postbuild/analyse.js:180:2)
```

This was observed in a production SvelteKit app using the Vercel Workflow plugin (`workflow@4.2.4`) where `@vercel/sandbox@1.10.2` pulls in `@vercel/oidc@3.2.0` (CJS). The generated workflow route `+server.js` only exports `POST`, but the bundled output leaks four `__commonJSMin` wrappers (`require_token_error$1 as i`, `require_token_error as n`, `require_token_util$1 as r`, `require_token_util as t`) because two versions of `@vercel/oidc` (3.2.0 and 3.4.1) are present in the same chunk.

## Reproduction

### Prerequisites

- Node.js 22+
- pnpm

### Steps

```bash
pnpm install

# Build with all three bundlers
pnpm build:all

# Verify: rolldown CLI should PASS, Vite should FAIL, rollup should PASS
pnpm verify
```

### Expected output

```
PASS  rolldown: entry-a.js only exports valid names
FAIL  vite (rolldown): leaked exports from entry-a.js:
        require_token_error as n
        require_token_util as t
        full export line: export { POST, require_token_error as n, require_token_util as t };
PASS  rollup: entry-a.js only exports valid names
```

## How the reproduction works

| Component | Purpose |
|---|---|
| `src/entry-a.js` | ESM entry that imports `@vercel/sandbox` (which transitively imports the CJS package `@vercel/oidc`). Exports only `POST`. |
| `src/entry-b.js` | A second, unrelated ESM entry (`GET`). Ensures code splitting is active with multiple entry points. |
| `rolldown.config.js` | Builds with rolldown 1.0.0 CLI directly — multiple entries + `preserveEntrySignatures: "strict"`. Does **not** reproduce the bug. |
| `vite-build.mjs` | Builds with Vite 8.0.12 (which uses rolldown 1.0.0 internally) using SSR + `noExternal: true` + multiple entries + `preserveEntrySignatures: "strict"` — matching SvelteKit's server build configuration. **Reproduces the bug.** |
| `rollup.config.js` | Builds the same inputs with Rollup 4.62.2 + `@rollup/plugin-commonjs` + `@rollup/plugin-node-resolve` for comparison. Does **not** reproduce the bug. |
| `verify.mjs` | Checks all three outputs against the SvelteKit endpoint export allowlist. |

### Why `@vercel/sandbox` is required

`@vercel/sandbox` is a CJS package that `require()`s `@vercel/oidc`. Under Vite's `ssr.noExternal`, this forces `@vercel/oidc`'s CJS modules into the same chunk as the entry (rather than a shared chunk). Inside `@vercel/oidc`, `get-vercel-oidc-token.js` both statically `require()`s and dynamically `import()`s `token-util.js`. The static require forces `token-util.js` into the entry chunk; the dynamic `import()` is then inlined as `Promise.resolve().then(() => __toESM(require_token_util()))`. This inlining is where the wrapper is incorrectly exported.

Importing `@vercel/oidc` directly from ESM does **not** reproduce the bug — the CJS modules land in separate chunks and the wrappers are correctly scoped to those chunks.

## Environment

| Tool | Version |
|---|---|
| rolldown | 1.0.0 (CLI and via Vite) |
| Vite | 8.0.12 |
| Rollup | 4.62.2 |
| Node.js | v24.12.0 |
| OS | macOS (darwin arm64) |

## Expected fix

Internal `__commonJSMin` wrapper functions should never appear in the entry chunk's export list. They are implementation details of rolldown's CJS interop, not part of the module's public API. When a dynamic `import()` of a CJS module is inlined (because the module is already in the same chunk via a static `require()`), the wrapper should remain a private binding.
