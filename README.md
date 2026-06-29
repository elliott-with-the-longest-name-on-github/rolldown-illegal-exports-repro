# rolldown leaks `__commonJSMin` wrappers as top-level ESM exports

Minimal reproduction of a rolldown bug where internal `__commonJSMin` wrapper functions (used for CJS interop) are incorrectly exported as top-level ESM exports from entry chunks. Rollup does not exhibit this behavior.

## The bug

When a CJS dependency (e.g. `@vercel/oidc`, used via `@vercel/sandbox`) contains modules that **both** statically `require()` and dynamically `import()` each other, rolldown inlines the dynamic `import()` into a `Promise.resolve().then(() => __toESM(require_x()))` pattern. However, it also leaks the internal `__commonJSMin` wrapper functions (`require_token_error`, `require_token_util`) as **top-level ESM exports** of the entry chunk — with minified names (`n`, `t`).

### What happens

The entry source (`src/entry-a.js`) only exports `POST`:

```js
import { Sandbox } from "@vercel/sandbox";

export const POST = async (event) => {
	const sandbox = await Sandbox.create({ teamId: "test", token: "test", projectId: "test" });
	return new Response(JSON.stringify({ id: sandbox.id }));
};
```

After building with **rolldown** (via Vite 8.0.12 / rolldown 1.0.0), the output (`dist/vite/entry-a.js`) contains:

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

After building with **Rollup** 4.62.2, the output (`dist/rollup/entry-a.js`) is clean:

```js
export { P as POST } from './chunks/entry-a.js';
```

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

# Build with both bundlers
pnpm build:all

# Verify: rolldown should FAIL (leaked exports), rollup should PASS
pnpm verify
```

### Expected output

```
FAIL  rolldown: leaked exports from entry-a.js:
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
| `vite-build.mjs` | Builds with Vite 8.0.12 (rolldown 1.0.0) using SSR + `noExternal: true` + multiple entries + `preserveEntrySignatures: "strict"` — matching SvelteKit's server build configuration. |
| `rollup.config.js` | Builds the same inputs with Rollup 4.62.2 + `@rollup/plugin-commonjs` + `@rollup/plugin-node-resolve` for comparison. |
| `verify.mjs` | Checks both outputs against the SvelteKit endpoint export allowlist. |

### Why `@vercel/sandbox` is required

`@vercel/sandbox` is a CJS package that `require()`s `@vercel/oidc`. This forces `@vercel/oidc`'s CJS modules into the same chunk as the entry (rather than a shared chunk). Inside `@vercel/oidc`, `get-vercel-oidc-token.js` both statically `require()`s and dynamically `import()`s `token-util.js`. The static require forces `token-util.js` into the entry chunk; the dynamic `import()` is then inlined as `Promise.resolve().then(() => __toESM(require_token_util()))`. This inlining is where rolldown incorrectly exports the wrapper.

Importing `@vercel/oidc` directly from ESM does **not** reproduce the bug — the CJS modules land in separate chunks and the wrappers are correctly scoped to those chunks.

## Environment

| Tool | Version |
|---|---|
| rolldown | 1.0.0 (via vite 8.0.12) |
| rollup | 4.62.2 |
| Node.js | v24.12.0 |
| OS | macOS (darwin arm64) |

## Expected fix

Internal `__commonJSMin` wrapper functions should never appear in the entry chunk's export list. They are implementation details of rolldown's CJS interop, not part of the module's public API. When a dynamic `import()` of a CJS module is inlined (because the module is already in the same chunk via a static `require()`), the wrapper should remain a private binding.
