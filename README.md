<p align="center">
  <strong>@fest-lib/icon</strong><br>
  Phosphor <code>&lt;ui-icon&gt;</code> with OPFS + CSS-registry caches — no CDN hit per glyph after warm.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fest-lib/icon"><img src="https://img.shields.io/npm/v/@fest-lib/icon?style=flat-square" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@fest-lib/icon?style=flat-square" alt="MIT"></a>
  <a href="https://github.com/fest-live/icon.ts"><img src="https://img.shields.io/github/stars/fest-live/icon.ts?style=flat-square" alt="stars"></a>
</p>

Default export is `UIPhosphorIcon`. Glyphs come from `@phosphor-icons/core` (bundled dependency). First paint can prefetch; later loads read OPFS / the CSS registry.

```text
core · dom · object · lure · uniform
 └── fest/icon        ← you are here
      └── fl-ui · Speed Dial · App Menu
```

## Install

```bash
npm install @fest-lib/core @fest-lib/dom @fest-lib/object @fest-lib/uniform @fest-lib/lure @fest-lib/icon
```

Peers: `core`, `dom`, `object`, `uniform`. Runtime also uses LUR.E (listed as a dependency).

```ts
import UIPhosphorIcon, { prefetchIcon, getIconCacheStats } from "@fest-lib/icon";

if (!customElements.get("ui-icon")) {
    customElements.define("ui-icon", UIPhosphorIcon);
}
await prefetchIcon("house");
console.log(getIconCacheStats());
```

```html
<ui-icon icon="house" icon-style="duotone"></ui-icon>
```

## API

| Export | Role |
| --- | --- |
| `UIPhosphorIcon` (default) | custom element |
| `prefetchIcon` / `invalidateIconCache` / `clearIconCaches` | memory loader |
| `initOPFSCache` / `clearIconCache` / `getIconCacheStats` | OPFS |
| `registerIconRule` / `preregisterIcons` / `getRegistryStats` | CSS registry |
| `isOPFSSupported` | feature detect |

## Layout

| Path | Role |
| --- | --- |
| `src/loader/Phosphor.ts` | `<ui-icon>` |
| `src/loader/OPFSCache.ts` | OPFS |
| `src/loader/Loader.ts` | in-memory load |
| `src/loader/CSSIconRegistry.ts` | stylesheet rules |

## Workspace

```bash
cd modules/projects/icon.ts
npm run generate:phosphor-map
npm run dev
npm run build
npm run publish
```

License: [MIT](LICENSE).
