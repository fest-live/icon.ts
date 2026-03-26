#!/usr/bin/env node
/**
 * Offline: reads `@phosphor-icons/core` duotone SVGs from node_modules (after npm install),
 * emits static SCSS (:host attribute → --icon-image data URLs) + TS Set for fast path in Phosphor.ts.
 *
 * Run: node scripts/generate-phosphor-duotone-map.mjs
 * Env: PHOSPHOR_GEN_LIMIT=n — cap icons (dev only)
 *
 * @see https://github.com/phosphor-icons/homepage#phosphor-icons
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const outDir = join(pkgRoot, "src/loader/generated");
const require = createRequire(import.meta.url);

function resolvePhosphorRoot() {
    let cur = pkgRoot;
    for (let i = 0; i < 12; i++) {
        const pkgJson = join(cur, "node_modules/@phosphor-icons/core/package.json");
        if (existsSync(pkgJson)) return dirname(pkgJson);
        const next = dirname(cur);
        if (next === cur) break;
        cur = next;
    }
    try {
        return dirname(require.resolve("@phosphor-icons/core/package.json"));
    } catch {
        return null;
    }
}

const phosphorRoot = resolvePhosphorRoot();
if (!phosphorRoot) {
    console.error("[generate-phosphor-duotone-map] @phosphor-icons/core not found — npm install at repo or package root.");
    process.exit(1);
}

const duotoneDir = join(phosphorRoot, "assets/duotone");
const limitRaw = process.env.PHOSPHOR_GEN_LIMIT;
const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 0) : 0;

const allFiles = (await readdir(duotoneDir)).filter((f) => /-duotone\.svg$/i.test(f));
const names = allFiles
    .map((f) => f.replace(/-duotone\.svg$/i, ""))
    .filter((n) => /^[a-z0-9-]+$/i.test(n))
    .sort();

const use = limit > 0 ? names.slice(0, limit) : names;

const scssLines = [
    "/* AUTO-GENERATED — run: node scripts/generate-phosphor-duotone-map.mjs */",
    "/* @phosphor-icons/core duotone → :host(ui-icon) --icon-image (base64), no network */",
    "",
];

for (const name of use) {
    const buf = await readFile(join(duotoneDir, `${name}-duotone.svg`));
    const b64 = buf.toString("base64");
    scssLines.push(`:host([icon="${name}"]:not([icon-style])),`);
    scssLines.push(`:host([icon="${name}"][icon-style="duotone"]) {`);
    scssLines.push(`    --icon-image: url("data:image/svg+xml;base64,${b64}");`);
    scssLines.push(`}`);
    scssLines.push("");
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "phosphor-duotone-map.scss"), scssLines.join("\n") + "\n", "utf8");

const tsBody = use.map((n) => `    "${n}",`).join("\n");
const ts = `/* AUTO-GENERATED — run: node scripts/generate-phosphor-duotone-map.mjs */
export const PHOSPHOR_DUOTONE_STATIC = new Set<string>([
${tsBody}
]);
`;
await writeFile(join(outDir, "phosphor-duotone-known.ts"), ts, "utf8");

console.log(`[generate-phosphor-duotone-map] Wrote ${use.length} duotone icons (of ${names.length} total) → src/loader/generated/`);
