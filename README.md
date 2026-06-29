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

After building with **rolldown** 1.0.0, the output (`dist/rolldown/entry-a.js`) contains:

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

## Root cause analysis

### Module resolution: the `platform` option

The bug requires `platform: "node"`. Rolldown defaults to `platform: "browser"` for ESM output, which causes a different module resolution path that hides the bug.

The `@vercel/oidc` package has conditional exports:

```json
{
  "exports": {
    ".": {
      "browser": "./dist/index-browser.js",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  }
}
```

- **`platform: "browser"`** (rolldown default for ESM) → resolves to `index-browser.js` → stubbed functions (`return ""`), no dynamic imports, no CJS interop → **no leak**
- **`platform: "node"`** (Vite SSR, rolldown CLI with `platform: "node"`) → resolves to `index.js` → full implementation with dynamic `import("./token-util.js")` → CJS interop with `__commonJSMin` wrappers → **leak**

This is why the bug only appeared in production (via Vite SSR builds) and not in initial rolldown CLI testing — the default `platform: "browser"` resolves to the browser stub which doesn't trigger the code path.

### The CJS interop chain

With the Node.js build, the bug manifests through this chain:

1. `@vercel/sandbox` (CJS) `require()`s `@vercel/oidc`, forcing `@vercel/oidc`'s CJS modules into the entry chunk
2. Inside `@vercel/oidc`, `get-vercel-oidc-token.js` both statically `require()`s and dynamically `import()`s `token-util.js`
3. The static `require()` forces `token-util.js` into the entry chunk
4. The dynamic `import()` is then inlined as `Promise.resolve().then(() => __toESM(require_token_util()))` (because the module is already in the same chunk)
5. The `__commonJSMin` wrappers (`require_token_error`, `require_token_util`) are incorrectly added to the entry chunk's export list

### Why Vite triggers it

Vite sets `platform: "node"` for SSR builds (`ssr: { noExternal: true }`), which correctly resolves `@vercel/oidc` to its Node.js build. The rolldown CLI with default settings uses `platform: "browser"`, resolving to the browser stub. This is why the bug was initially attributed to Vite — Vite's SSR configuration is the correct one for server-side code, but it's the one that triggers the rolldown bug.

### Why Rollup doesn't leak

Rollup handles the same CJS interop differently. It converts CJS modules to ESM using `@rollup/plugin-commonjs`, which creates named exports without `__commonJSMin` wrappers. The dynamic `import()` is preserved as a real `import()` call, and internal wrappers stay private to their chunk.

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

# Verify: rolldown CLI should FAIL, Vite should FAIL, rollup should PASS
pnpm verify
```

### Expected output

```
FAIL  rolldown: leaked exports from entry-a.js:
        require_token_error as n
        require_token_util as t
        full export line: export { POST, require_token_error as n, require_token_util as t };
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
| `rolldown.config.js` | Builds with rolldown 1.0.0 CLI — `platform: "node"` + multiple entries + `preserveEntrySignatures: "strict"`. **Reproduces the bug.** |
| `vite-build.mjs` | Builds with Vite 8.0.12 (which uses rolldown 1.0.0 internally) using SSR + `noExternal: true` — matching SvelteKit's server build configuration. **Reproduces the bug.** |
| `rollup.config.js` | Builds the same inputs with Rollup 4.62.2 + `@rollup/plugin-commonjs` + `@rollup/plugin-node-resolve` (with `exportConditions: ["import", "node", "default"]` for a fair comparison). Does **not** reproduce the bug. |
| `verify.mjs` | Checks all three outputs against the SvelteKit endpoint export allowlist. |

### Why `@vercel/sandbox` is required

`@vercel/sandbox` is a CJS package that `require()`s `@vercel/oidc`. This forces `@vercel/oidc`'s CJS modules into the same chunk as the entry (rather than a shared chunk). Inside `@vercel/oidc`, `get-vercel-oidc-token.js` both statically `require()`s and dynamically `import()`s `token-util.js`. The static require forces `token-util.js` into the entry chunk; the dynamic `import()` is then inlined as `Promise.resolve().then(() => __toESM(require_token_util()))`. This inlining is where rolldown incorrectly exports the wrapper.

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
