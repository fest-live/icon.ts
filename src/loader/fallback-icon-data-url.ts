/**
 * Standalone fallback data URL for failed icon loads.
 * Kept in a tiny module so Phosphor.ts does not depend on Loader.ts for this binding
 * (avoids Vite dev / circular graph issues with missing named exports).
 */

const FALLBACK_SVG_TEXT = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" fill-rule="evenodd" d="M6 2a4 4 0 0 0-4 4v12a4 4 0 0 0 4 4h12a4 4 0 0 0 4-4V6a4 4 0 0 0-4-4H6zm0 2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" clip-rule="evenodd"/>
  <path fill="currentColor" d="M11 7h2v7h-2z"/>
  <path fill="currentColor" d="M11 16h2v2h-2z"/>
</svg>`;

const toSvgDataUrl = (svgText: string): string => {
    if (!svgText || typeof svgText !== "string") {
        throw new Error("Invalid SVG text: empty or not a string");
    }

    const trimmed = svgText.trim();
    if (!trimmed.includes("<svg") || !trimmed.includes("</svg>")) {
        throw new Error("Invalid SVG: missing svg tags");
    }

    if (trimmed.length < 50) {
        throw new Error("Invalid SVG: content too small");
    }

    if (trimmed.length > 1024 * 1024) {
        throw new Error("Invalid SVG: content too large");
    }

    const openTags = trimmed.match(/<[^/?][^>]*>/g) || [];
    const closeTags = trimmed.match(/<\/[^>]+>/g) || [];
    const selfClosingTags = trimmed.match(/<[^>]+\/>/g) || [];

    if (openTags.length + selfClosingTags.length < closeTags.length) {
        throw new Error("Invalid SVG: unbalanced tags");
    }

    try {
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(svgText);
        const binaryString = Array.from(utf8Bytes, (byte) => String.fromCharCode(byte)).join("");
        return `data:image/svg+xml;base64,${btoa(binaryString)}`;
    } catch {
        try {
            return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
        } catch {
            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
        }
    }
};

export const FALLBACK_ICON_DATA_URL = (() => {
    try {
        return toSvgDataUrl(FALLBACK_SVG_TEXT);
    } catch {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FALLBACK_SVG_TEXT)}`;
    }
})();
