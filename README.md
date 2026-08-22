# Icon.TS

`@fest-lib/icon` — Phosphor `ui-icon` web component plus OPFS / CSS-registry caches so apps do not hit a CDN per glyph.

Default export is `UIPhosphorIcon`. Also exposes cache stats, prefetch, and stylesheet rule registration.

## Install

```bash
npm install @fest-lib/icon
```

```ts
import UIPhosphorIcon, { prefetchIcon, getIconCacheStats } from "@fest-lib/icon";

customElements.define("ui-icon", UIPhosphorIcon);
await prefetchIcon("house");
```

## Layout

| Path | Role |
| --- | --- |
| `src/loader/Phosphor.ts` | `<ui-icon>` element |
| `src/loader/OPFSCache.ts` | OPFS glyph cache |
| `src/loader/Loader.ts` | in-memory load / invalidate |
| `src/loader/CSSIconRegistry.ts` | CSS rule registry |

Peers: `@fest-lib/core`, `dom`, `object`, `uniform`. Runtime also uses LUR.E. Build: `npm run build`. Publish: `npm run publish`.
