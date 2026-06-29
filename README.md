# rolldown leaks `__commonJSMin` wrappers as top-level ESM exports

## Problem

When rolldown inlines a dynamic `import()` of a CJS module (because it's already in the same chunk via a static `require()`), it leaks the internal `__commonJSMin` wrapper functions as top-level ESM exports of the entry chunk.

Source (`src/entry-a.js`) exports only `POST`:

```js
import { Sandbox } from "@vercel/sandbox";

export const POST = async (event) => { ... };
```

Rolldown output:

```js
export { POST, require_token_error as n, require_token_util as t };
```

Rollup output (same input, same Node.js resolution):

```js
export { P as POST } from './chunks/entry-a.js';
```

The leaked exports break SvelteKit, which validates endpoint exports against an allowlist (`GET`, `POST`, etc.) and rejects anything else.

## Reproduce

```bash
pnpm install
pnpm build:all
pnpm verify
```

Output:

```
FAIL  rolldown: leaked exports from entry-a.js:
        require_token_error as n
        require_token_util as t
PASS  rollup: entry-a.js only exports valid names
```

Requires `platform: "node"` (rolldown defaults to `"browser"`, which resolves `@vercel/oidc` to a stub that doesn't trigger the bug).

## Environment

- rolldown 1.0.0
- Rollup 4.62.2
- Node.js v24.12.0
