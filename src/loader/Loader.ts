import {
    isOPFSSupported,
    getCachedVectorIcon,
    cacheVectorIcon,
    getCachedRasterIcon,
    cacheRasterIcon,
} from "./OPFSCache";

import {
    registerIconRule,
    hasIconRule,
} from "./CSSIconRegistry";

//
//import * as icons from "lucide";
export const iconMap = new Map<string, Promise<string>>();

// Minimal caches - only for in-flight operations, not long-term storage
// CSS stylesheet handles the actual caching via attribute selectors
export const resolvedUrlCache = new Map<string, string>();
export const imageElementCache = new Map<string, Promise<HTMLImageElement>>();

// Re-export registry functions for external use
export { registerIconRule, hasIconRule } from "./CSSIconRegistry";

export const MAX_RASTER_SIZE = 512;
export const MIN_RASTER_SIZE = 32;

// Timeout and retry queue configuration
// Increased timeout for mobile/slow networks
const FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 1000; // Progressive delay
const MAX_RETRIES = 5; // More retries for unreliable networks

// Network detection utilities
const isOnline = (): boolean => {
    try {
        return navigator.onLine !== false;
    } catch {
        return true; // Assume online if can't detect
    }
};

const isSlowConnection = (): boolean => {
    try {
        const connection = (navigator as any).connection ||
                          (navigator as any).mozConnection ||
                          (navigator as any).webkitConnection;
        if (!connection) return false;

        // Check for slow connection types
        const slowTypes = ['slow-2g', '2g', '3g'];
        return slowTypes.includes(connection.effectiveType) ||
               connection.saveData === true ||
               connection.downlink < 1.5; // Less than 1.5 Mbps
    } catch {
        return false;
    }
};

// Delayed retry queue
type QueuedItem = { name: string; creator?: (name: any) => any; resolve: (v: string) => void; reject: (e: Error) => void; retries: number };
const retryQueue: QueuedItem[] = [];
let retryScheduled = false;

const scheduleRetryQueue = () => {
    if (retryScheduled || retryQueue.length === 0) { return; }
    retryScheduled = true;
    setTimeout(processRetryQueue, RETRY_DELAY_MS);
};

const processRetryQueue = () => {
    retryScheduled = false;

    // Skip retries if offline
    if (!isOnline()) {
        if (typeof console !== "undefined") {
            console.log?.("[icon-loader] Skipping retries - device is offline");
        }
        // Clear queue to prevent accumulation
        retryQueue.length = 0;
        return;
    }

    const batch = retryQueue.splice(0, Math.min(2, retryQueue.length)); // Even smaller batches
    for (const item of batch) {
        // Add progressive delay for retries
        const delay = RETRY_DELAY_MS * Math.pow(1.5, item.retries - 1);
        setTimeout(() => {
            loadAsImageInternal(item.name, item.creator, item.retries)
                .then(item.resolve)
                .catch((error) => {
                    // Enhanced error logging for debugging
                    if (typeof console !== "undefined") {
                        console.warn?.(`[icon-loader] Retry ${item.retries}/${MAX_RETRIES} failed for ${item.name}:`, error?.message || error);
                    }
                    item.reject(error);
                });
        }, delay);
    }

    // Schedule next batch with longer delay if we have more items
    if (retryQueue.length > 0) {
        const nextDelay = isSlowConnection() ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
        setTimeout(processRetryQueue, nextDelay);
    }
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

export type DevicePixelSize = { inline: number; block: number };

const globalScope = typeof globalThis !== "undefined" ? (globalThis as { location?: Location }) : {};
const hasChromeRuntime = (): boolean => {
    try {
        const chromeRuntime = (globalThis as any)?.chrome?.runtime;
        return !!chromeRuntime?.id;
    } catch {
        return false;
    }
};

const pickBaseUrl = (): string | undefined => {
    try {
        if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI !== "about:blank") {
            return document.baseURI;
        }
    } catch {
        /* noop */
    }

    try {
        const { location } = globalScope;
        if (location?.href && location.href !== "about:blank") {
            return location.href;
        }
        if (location?.origin) {
            return location.origin;
        }
    } catch {
        /* noop */
    }
    return undefined;
};

const DEFAULT_BASE_URL = pickBaseUrl();

export const fallbackMaskValue = (url: string) => (!url ? "none" : `url("${url}")`);

export const resolveAssetUrl = (input: string): string => {
    if (!input || typeof input !== "string") { return ""; }
    const cached = resolvedUrlCache.get(input);
    if (cached) { return cached; }

    let resolved = input;
    if (typeof URL === "function") {
        try {
            resolved = DEFAULT_BASE_URL ? new URL(input, DEFAULT_BASE_URL).href : new URL(input).href;
        } catch {
            try {
                resolved = new URL(input, globalScope.location?.origin ?? undefined).href;
            } catch {
                resolved = input;
            }
        }
    }

    resolvedUrlCache.set(input, resolved);
    if (!resolvedUrlCache.has(resolved)) {
        resolvedUrlCache.set(resolved, resolved);
    }
    return resolved;
};

// In-flight promise tracking to prevent duplicate loads
const inflightPromises = new Map<string, Promise<string>>();

const isSafeCssMaskUrl = (url: string): boolean => {
    if (!url || typeof url !== "string") return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return true;

    // Allow relative and root-relative paths (same-origin).
    if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return true;

    // For absolute URLs, only allow same-origin to avoid CSS cross-origin fetch + credentials issues.
    if (typeof URL === "function") {
        try {
            const base = globalScope.location?.origin ?? DEFAULT_BASE_URL;
            const parsed = new URL(trimmed, base);
            const origin = globalScope.location?.origin;
            if (origin && parsed.origin === origin) return true;
        } catch {
            return false;
        }
    }

    return false;
};

/**
 * Generates cache key for icon lookup
 */
const makeCacheKey = (cacheKey: string | undefined, normalizedUrl: string, bucket: number): string => {
    const sanitizedKey = (cacheKey ?? "").trim();
    return sanitizedKey ? `${sanitizedKey}@${bucket}` : `${normalizedUrl}@${bucket}`;
};

export const quantizeToBucket = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) { value = MIN_RASTER_SIZE; }
    const safe = Math.max(value, MIN_RASTER_SIZE);
    const bucket = 2 ** Math.ceil(Math.log2(safe));
    return Math.min(MAX_RASTER_SIZE, bucket);
};

export const loadImageElement = (url: string): Promise<HTMLImageElement> => {
    const resolvedUrl = resolveAssetUrl(url);
    if (!resolvedUrl) { return Promise.reject(new Error("Invalid icon URL")); }
    if (!imageElementCache.has(resolvedUrl)) {
        const promise = (async (): Promise<HTMLImageElement> => {
            // Try OPFS cache first for blob URL
            let effectiveUrl = resolvedUrl;
            if (isOPFSSupported()) {
                try {
                    const cachedUrl = await getCachedVectorIcon(resolvedUrl);
                    if (cachedUrl) {
                        effectiveUrl = cachedUrl;
                    }
                } catch {
                    /* cache miss */
                }
            }

            return new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                let settled = false;

                // Timeout for image loading to prevent stuck preloading
                const timeoutId = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        img.onload = img.onerror = null;
                        reject(new Error(`Timeout loading icon: ${url}`));
                    }
                }, FETCH_TIMEOUT_MS);

                // Configure image properties
                try { img.decoding = "async"; } catch (_) { /* noop */ }
                try { img.crossOrigin = "anonymous"; } catch (_) { /* noop */ }

                // Prevent image from being displayed if it accidentally gets added to DOM
                img.style.display = 'none';
                img.style.position = 'absolute';
                img.style.visibility = 'hidden';

                img.onload = () => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timeoutId);

                    // Validate loaded image
                    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
                        reject(new Error(`Invalid image dimensions for: ${url}`));
                        return;
                    }

                    resolve(img);
                };

                img.onerror = (_event) => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timeoutId);

                    // If cached URL failed, try original URL
                    if (effectiveUrl !== resolvedUrl) {
                        const retryImg = new Image();
                        try { retryImg.decoding = "async"; } catch (_) { /* noop */ }
                        try { retryImg.crossOrigin = "anonymous"; } catch (_) { /* noop */ }
                        retryImg.style.display = retryImg.style.position = retryImg.style.visibility = 'none';

                        retryImg.onload = () => {
                            if (retryImg.naturalWidth === 0 || retryImg.naturalHeight === 0) {
                                reject(new Error(`Invalid retry image dimensions for: ${url}`));
                                return;
                            }
                            resolve(retryImg);
                        };
                        retryImg.onerror = () => reject(new Error(`Failed to load icon: ${url}`));
                        retryImg.src = resolvedUrl;
                        return;
                    }
                    reject(new Error(`Failed to load icon: ${url}`));
                };

                img.src = effectiveUrl;
            });
        })().then(async (img) => {
            if (typeof img.decode === "function") {
                try { await img.decode(); } catch (_) { /* ignore decode errors */ }
            }

            // Cache SVG to OPFS if loaded from network
            if (isOPFSSupported() && img.src === resolvedUrl) {
                // Fetch and cache in background
                fetch(resolvedUrl)
                    .then(r => r.blob())
                    .then(blob => cacheVectorIcon(resolvedUrl, blob))
                    .catch(() => { /* silent */ });
            }

            return img;
        }).catch((error) => {
            // Remove from cache on failure to allow retry
            imageElementCache.delete(resolvedUrl);
            throw error;
        });
        imageElementCache.set(resolvedUrl, promise);
    }
    return imageElementCache.get(resolvedUrl)!;
};

export const createCanvas = (size: number): OffscreenCanvas | HTMLCanvasElement => {
    const dimension = Math.max(size, MIN_RASTER_SIZE);
    if (typeof OffscreenCanvas !== "undefined") {
        return new OffscreenCanvas(dimension, dimension);
    }
    const canvas = document.createElement("canvas");
    canvas.width = dimension;
    canvas.height = dimension;
    return canvas;
};

export const canvasToImageUrl = async (canvas: OffscreenCanvas | HTMLCanvasElement): Promise<string> => {
    if ("convertToBlob" in canvas) {
        const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
        return URL.createObjectURL(blob);
    }
    const htmlCanvas = canvas as HTMLCanvasElement;
    if (typeof htmlCanvas.toBlob === "function") {
        const blob = await new Promise<Blob>((resolve, reject) => {
            htmlCanvas.toBlob((blobValue) => {
                if (blobValue) { resolve(blobValue); }
                else { reject(new Error("Canvas toBlob returned null")); }
            }, "image/png");
        });
        return URL.createObjectURL(blob);
    }
    return htmlCanvas.toDataURL("image/png");
};

/**
 * Converts canvas to blob for OPFS caching
 */
const canvasToBlob = async (canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob | null> => {
    try {
        if ("convertToBlob" in canvas) {
            return await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
        }
        const htmlCanvas = canvas as HTMLCanvasElement;
        if (typeof htmlCanvas.toBlob === "function") {
            return await new Promise<Blob | null>((resolve) => {
                htmlCanvas.toBlob((blob) => resolve(blob), "image/png");
            });
        }
    } catch {
        /* noop */
    }
    return null;
};

export const rasterizeSvgToMask = async (url: string, bucket: number, cacheKey?: string): Promise<string> => {
    const size = Math.max(bucket, MIN_RASTER_SIZE);
    const opfsCacheKey = cacheKey || url;

    // Check OPFS cache first for raster version
    if (isOPFSSupported()) {
        try {
            const cachedRaster = await getCachedRasterIcon(opfsCacheKey, size);
            if (cachedRaster) {
                return fallbackMaskValue(cachedRaster);
            }
        } catch (error) {
            console.warn('[ui-icon] OPFS cache read failed:', error);
        }
    }

    const img = await loadImageElement(url);
    const canvas = createCanvas(size);
    const context = canvas.getContext("2d", {
        alpha: true,
        desynchronized: true,
        willReadFrequently: false
    }) as CanvasRenderingContext2D;

    if (!context) {
        throw new Error("Unable to acquire 2d context for rasterization");
    }

    // Configure canvas for high-quality rendering
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.globalCompositeOperation = 'source-over';

    const naturalWidth = img.naturalWidth || img.width || size;
    const naturalHeight = img.naturalHeight || img.height || size;

    // Ensure we have valid dimensions
    const safeWidth = Math.max(1, naturalWidth);
    const safeHeight = Math.max(1, naturalHeight);

    // Calculate scale to fit within canvas while maintaining aspect ratio
    const scale = Math.min(size / safeWidth, size / safeHeight);
    const drawWidth = Math.max(1, Math.floor(safeWidth * scale));
    const drawHeight = Math.max(1, Math.floor(safeHeight * scale));

    // Center the image on the canvas
    const offsetX = Math.floor((size - drawWidth) / 2);
    const offsetY = Math.floor((size - drawHeight) / 2);

    // Clear canvas with transparent background
    context.clearRect(0, 0, size, size);

    // Draw the image with proper scaling and error handling
    try {
        context.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
    } catch (error) {
        console.warn('[ui-icon] Failed to draw image on canvas:', error);
        // Fallback: create a simple colored rectangle as placeholder
        context.fillStyle = 'rgba(128, 128, 128, 0.5)';
        context.fillRect(offsetX, offsetY, drawWidth, drawHeight);
    }

    // Cache raster to OPFS in background with error handling
    if (isOPFSSupported()) {
        canvasToBlob(canvas).then((blob) => {
            if (blob && blob.size > 0) {
                return cacheRasterIcon(opfsCacheKey, size, blob);
            }
        }).catch((error) => {
            console.warn('[ui-icon] OPFS cache write failed:', error);
        });
    }

    const rasterUrl = await canvasToImageUrl(canvas);
    return fallbackMaskValue(rasterUrl);
};

/**
 * Ensures a mask value is available for an icon.
 * Uses CSS registry for caching - the result is registered as a CSS rule
 * with attribute selectors, so the browser handles caching.
 */
export const ensureMaskValue = (url: string, cacheKey: string | undefined, bucket: number): Promise<string> => {
    const safeUrl = typeof url === "string" ? url : "";
    const normalizedUrl = resolveAssetUrl(safeUrl);
    const effectiveUrl = normalizedUrl || safeUrl;
    const key = makeCacheKey(cacheKey, normalizedUrl, bucket);

    if (!effectiveUrl) {
        return Promise.resolve(fallbackMaskValue(""));
    }

    // Check if already in-flight
    const inflight = inflightPromises.get(key);
    if (inflight) { return inflight; }

    const promise = loadAsImage(effectiveUrl, /*bucket, cacheKey*/)
        .catch((error) => {
            if (effectiveUrl && typeof console !== "undefined") {
                console.warn?.("[ui-icon] Mask generation failed; refusing to use cross-origin CSS url() fallback", error);
            }
            // IMPORTANT:
            // Do not fall back to `url("https://...")` for cross-origin CDNs, because CSS fetches use
            // credentials=include and many CDNs respond with ACAO="*", which is blocked in that mode.
            return fallbackMaskValue(isSafeCssMaskUrl(effectiveUrl) ? effectiveUrl : "");
        })
        .finally(() => {
            inflightPromises.delete(key);
        });

    inflightPromises.set(key, promise);
    return promise;
};

export const camelToKebab = (camel: string) => {
    if (typeof camel !== "string") { return ""; }
    return camel
        .replace(/[_\s]+/g, "-")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
        .toLowerCase();
};

/**
 * Creates an image-set CSS value for resolution-aware icons.
 * Used by the CSS registry for generating rules.
 */
export const createImageSetValue = (url: string, resolutions: Array<{ scale: number; size: number }> = []): string => {
    if (!url) { return "linear-gradient(#0000, #0000)"; }

    const baseSet = [`url("${url}") 1x`];

    for (const { scale } of resolutions) {
        if (scale > 1) {
            baseSet.push(`url("${url}") ${scale}x`);
        }
    }

    return `image-set(${baseSet.join(", ")})`;
};

/**
 * Registers an icon in the CSS registry.
 * This generates a CSS rule with attribute selectors and image-set.
 *
 * @param iconName - The icon name (e.g., "house", "arrow-right")
 * @param iconStyle - The icon style (e.g., "duotone", "fill")
 * @param url - The resolved icon URL
 * @param bucket - The size bucket for the icon
 */
export const generateIconImageVariable = (
    iconName: string,
    url: string,
    bucket: number
): void => {
    // Parse iconName to extract the style if it's in "style:name" format
    const parts = iconName.split(":");
    const [iconStyle, name] = parts.length === 2 ? parts : ["duotone", iconName];

    // Register in the CSS stylesheet via registry
    registerIconRule(name, iconStyle, url, bucket);
};

export const isPathURL = (url: unknown): url is string => {
    if (typeof url !== "string" || !url) { return false; }
    if (typeof URL === "undefined") {
        return /^([a-z]+:)?\/\//i.test(url) || url.startsWith("/") || url.startsWith("./") || url.startsWith("../");
    }

    if (typeof URL.canParse === "function") {
        try {
            if (URL.canParse(url, DEFAULT_BASE_URL)) { return true; }
            if (globalScope.location?.origin && URL.canParse(url, globalScope.location.origin)) { return true; }
        } catch {
            /* noop */
        }
    }

    try {
        new URL(url, DEFAULT_BASE_URL ?? globalScope.location?.origin ?? undefined);
        return true;
    } catch {
        return false;
    }
};
export const rasterizeSVG = (blob: Blob | string)=>{ return isPathURL(blob) ? resolveAssetUrl(blob) : URL.createObjectURL(blob); }

/**
 * Fetches SVG content with a hard timeout and abort support.
 * This prevents “fetch storms” from piling up and timing out later.
 */
const fetchSvgBlob = async (url: string, timeoutMs: number): Promise<Blob> => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
        const response = await fetch(url, {
            credentials: "omit",
            mode: "cors",
            signal: controller?.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const blob = await response.blob();
        if (!blob || blob.size === 0) {
            throw new Error("Empty SVG response");
        }
        return blob;
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error("Timeout");
        }
        throw e;
    } finally {
        if (timeoutId) { clearTimeout(timeoutId); }
    }
};

const tryLoadFromVectorCache = async (canonicalUrl: string): Promise<string | null> => {
    if (!canonicalUrl) return null;
    if (!isOPFSSupported()) return null;
    try {
        const cached = await getCachedVectorIcon(canonicalUrl);
        if (!cached) return null;

        const blob = await fetchSvgBlob(cached, FETCH_TIMEOUT_MS);
        const svgText = await blob.text();
        if (!svgText || svgText.trim().length === 0) return null;
        return toSvgDataUrl(svgText);
    } catch {
        return null;
    }
};

/**
 * Fallback icon SVG (used when all icon sources fail).
 *
 * Note: This is used as a CSS mask, so we prefer solid filled shapes and avoid
 * odd self-intersections that can look like “artifacts” at small sizes.
 */
const FALLBACK_SVG_TEXT = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" fill-rule="evenodd" d="M6 2a4 4 0 0 0-4 4v12a4 4 0 0 0 4 4h12a4 4 0 0 0 4-4V6a4 4 0 0 0-4-4H6zm0 2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" clip-rule="evenodd"/>
  <path fill="currentColor" d="M11 7h2v7h-2z"/>
  <path fill="currentColor" d="M11 16h2v2h-2z"/>
</svg>`;

/**
 * Validates and converts SVG text to data URL
 */
const toSvgDataUrl = (svgText: string): string => {
    if (!svgText || typeof svgText !== 'string') {
        throw new Error('Invalid SVG text: empty or not a string');
    }

    // Basic validation - check for SVG tag
    const trimmed = svgText.trim();
    if (!trimmed.includes('<svg') || !trimmed.includes('</svg>')) {
        throw new Error('Invalid SVG: missing svg tags');
    }

    // Check for reasonable size (not empty, not too large)
    if (trimmed.length < 50) {
        throw new Error('Invalid SVG: content too small');
    }

    if (trimmed.length > 1024 * 1024) { // 1MB limit
        throw new Error('Invalid SVG: content too large');
    }

    // Basic XML structure check
    const openTags = trimmed.match(/<[^/?][^>]*>/g) || [];
    const closeTags = trimmed.match(/<\/[^>]+>/g) || [];
    const selfClosingTags = trimmed.match(/<[^>]+\/>/g) || [];

    // Rough check that we have balanced tags
    if (openTags.length + selfClosingTags.length < closeTags.length) {
        throw new Error('Invalid SVG: unbalanced tags');
    }

    // Ensure proper UTF-8 encoding for SVG data URLs
    try {
        // Use TextEncoder for proper UTF-8 handling
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(svgText);
        const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
        return `data:image/svg+xml;base64,${btoa(binaryString)}`;
    } catch {
        // Fallback to the original method if TextEncoder fails
        try {
            return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
        } catch {
            // Final fallback: return SVG as-is without base64 encoding
            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
        }
    }
};

const FALLBACK_SVG_DATA_URL = (() => {
    try {
        return toSvgDataUrl(FALLBACK_SVG_TEXT);
    } catch {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FALLBACK_SVG_TEXT)}`;
    }
})();

export const FALLBACK_ICON_DATA_URL = FALLBACK_SVG_DATA_URL;

const rewritePhosphorUrl = (url: string): string => {
    // Legacy (broken) format used previously:
    // - https://cdn.jsdelivr.net/gh/phosphor-icons/phosphor-icons/src/{style}/{name}.svg
    //
    // Correct/stable format (npm package assets):
    // - https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/{style}/{name}.svg
    //
    // Keep this rewrite conservative: only rewrite known phosphor patterns.
    if (!url || typeof url !== 'string') return url;

    try {
        const isHttpOrigin = (() => {
            const proto = (globalScope.location as any)?.protocol || "";
            return proto === "http:" || proto === "https:";
        })();
        const isExtensionRuntime = hasChromeRuntime();

        const toNpmAssetUrl = (style: string, baseName: string) => {
            // For duotone icons, append '-duotone' to the filename
            // For other styles like 'fill', 'bold', etc., append '-{style}'
            const iconFileName = style === "duotone"
                ? `${baseName}-duotone`
                : style !== "regular"
                    ? `${baseName}-${style}`
                    : baseName;
            return `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/${style}/${iconFileName}.svg`;
        };

        const urlObj = new URL(url);

        // In extension runtimes (including content scripts on http(s) pages),
        // `/assets/icons/phosphor/...` is not guaranteed to exist. Rewrite to CDN.
        if ((isExtensionRuntime || !isHttpOrigin) && urlObj.pathname.startsWith("/assets/icons/phosphor/")) {
            const parts = urlObj.pathname.split("/").filter(Boolean); // ["assets","icons","phosphor",style,name.svg]
            const style = parts[3] || "duotone";
            const fileName = parts[4] || "";
            const baseName = fileName.replace(/\.svg$/i, "");
            const validStyles = ["thin", "light", "regular", "bold", "fill", "duotone"];
            if (validStyles.includes(style) && baseName && /^[a-z0-9-]+$/.test(baseName)) {
                return toNpmAssetUrl(style, baseName);
            }
            return url;
        }

        // Only rewrite GitHub phosphor URLs
        if (urlObj.hostname === 'cdn.jsdelivr.net' &&
            urlObj.pathname.startsWith('/gh/phosphor-icons/phosphor-icons/')) {

            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            const srcIndex = pathParts.indexOf('src');

            if (srcIndex >= 0 && pathParts.length >= srcIndex + 3) {
                const style = pathParts[srcIndex + 1];
                const fileName = pathParts[srcIndex + 2];

                if (style && fileName && fileName.endsWith('.svg')) {
                    let iconName = fileName.replace(/\.svg$/i, '');

                    // Remove style suffix from icon name if present (e.g., "folder-open-duotone" -> "folder-open")
                    if (style === 'duotone' && iconName.endsWith('-duotone')) {
                        iconName = iconName.replace(/-duotone$/, '');
                    } else if (style !== 'regular' && iconName.endsWith(`-${style}`)) {
                        iconName = iconName.replace(new RegExp(`-${style}$`), '');
                    }

                    // Validate style and icon name
                    const validStyles = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];
                    if (validStyles.includes(style) && iconName && /^[a-z0-9-]+$/.test(iconName)) {
                        // Prefer proxy only on non-extension http(s) origins where /api exists.
                        return (isHttpOrigin && !isExtensionRuntime)
                            ? `/assets/icons/phosphor/${style}/${iconName}.svg`
                            : toNpmAssetUrl(style, iconName);
                    }
                }
            }
        }

        // Also handle direct npm package URLs that might be used
        if (urlObj.hostname === 'cdn.jsdelivr.net' &&
            urlObj.pathname.startsWith('/npm/@phosphor-icons/')) {
            // Extract style and icon name from npm URL
            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            const assetsIndex = pathParts.indexOf('assets');

            if (assetsIndex >= 0 && pathParts.length >= assetsIndex + 3) {
                const style = pathParts[assetsIndex + 1];
                const fileName = pathParts[assetsIndex + 2];

                if (style && fileName && fileName.endsWith('.svg')) {
                    let iconName = fileName.replace(/\.svg$/i, '');

                    // Remove style suffix from icon name if present (e.g., "folder-open-duotone" -> "folder-open")
                    if (style === 'duotone' && iconName.endsWith('-duotone')) {
                        iconName = iconName.replace(/-duotone$/, '');
                    } else if (style !== 'regular' && iconName.endsWith(`-${style}`)) {
                        iconName = iconName.replace(new RegExp(`-${style}$`), '');
                    }

                    // Validate style and icon name
                    const validStyles = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];
                    if (validStyles.includes(style) && iconName && /^[a-z0-9-]+$/.test(iconName)) {
                        // Prefer proxy only on non-extension http(s) origins where /api exists.
                        return (isHttpOrigin && !isExtensionRuntime)
                            ? `/assets/icons/phosphor/${style}/${iconName}.svg`
                            : toNpmAssetUrl(style, iconName);
                    }
                }
            }
        }
    } catch (error) {
        // Invalid URL, return as-is
        console.warn('[ui-icon] Invalid URL for phosphor rewrite:', url, error);
    }

    return url;
};

const isClientErrorStatus = (error: unknown): boolean => {
    if (!(error instanceof Error)) { return false; }

    // Don't retry 4xx client errors (except 408 Request Timeout which might be network related)
    if (/\bHTTP\s*4\d\d\b/.test(error.message) || /\b4\d\d\b/.test(error.message)) {
        return !/408/.test(error.message); // Allow retry for 408
    }

    // Retry on network-related errors that might be temporary
    return /network|timeout|offline|connection|aborted/i.test(error.message) ||
           error.name === 'TypeError' && /fetch/i.test(error.message);
};

// Internal loader with retry support
// Internal loader with retry support

const loadAsImageInternal = async (name: any, creator?: (name: any) => any, attempt = 0): Promise<string> => {
    if (isPathURL(name)) {
        const resolvedUrl = resolveAssetUrl(name);

        // Skip if this is already a data URL (from cache or previous processing)
        if (resolvedUrl.startsWith("data:")) {
            console.log(`[ui-icon] Already a data URL, returning as-is`);
            return resolvedUrl;
        }

        const effectiveUrl = rewritePhosphorUrl(resolvedUrl);
        if (effectiveUrl !== resolvedUrl) {
            console.log(`[ui-icon] Rewrote phosphor URL: ${resolvedUrl} -> ${effectiveUrl}`);
        }

        try {
            // Try OPFS cache first (fast, local, avoids network storms).
            if (isOPFSSupported()) {
                try {
                    const cached = await withTimeout(getCachedVectorIcon(effectiveUrl), 50);
                    if (cached) {
                        const blob = await fetchSvgBlob(cached, FETCH_TIMEOUT_MS);
                        const svgText = await blob.text();
                        return toSvgDataUrl(svgText);
                    }
                } catch {
                    /* cache miss or timeout */
                }
            }

            // Build a small, correct fallback list (sequential attempts).
            const candidates: string[] = [effectiveUrl];

            // jsDelivr -> unpkg (correct path mapping for phosphor assets)
            if (effectiveUrl.startsWith("https://cdn.jsdelivr.net/npm/")) {
                const unpkg = effectiveUrl.replace("https://cdn.jsdelivr.net/npm/", "https://unpkg.com/");
                candidates.push(unpkg);
            }

            // Only attempt a second mirror if it’s an https URL and not already included.
            if (effectiveUrl.startsWith("https://") && effectiveUrl.includes("cdn.jsdelivr.net")) {
                const mirror = effectiveUrl.replace("cdn.jsdelivr.net", "unpkg.com").replace("/npm/", "/");
                if (!candidates.includes(mirror)) {
                    candidates.push(mirror);
                }
            }

            const errors: Error[] = [];
            for (const url of candidates) {
                try {
                    const blob = await fetchSvgBlob(url, FETCH_TIMEOUT_MS);
                    if (blob.size > 1024 * 1024) {
                        throw new Error(`Blob too large (${blob.size} bytes)`);
                    }
                    const svgText = await blob.text();
                    const dataUrl = toSvgDataUrl(svgText);

                    // Cache vector SVG for the canonical URL in background (best-effort),
                    // even if we succeeded via a mirror.
                    if (isOPFSSupported()) {
                        cacheVectorIcon(effectiveUrl, blob).catch(() => { /* silent */ });
                    }

                    return dataUrl;
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    errors.push(new Error(`${url}: ${err.message}`));
                }
            }

            throw new Error(`All icon sources failed: ${errors.map(e => e.message).join("; ")}`);

        } catch (error) {
            console.warn(`[ui-icon] Failed to load icon: ${effectiveUrl}`, error);

            // Don't spam retries on 404/4xx: it's a deterministic failure.
            if (attempt < MAX_RETRIES && !isClientErrorStatus(error)) {
                console.log(`[ui-icon] Queueing retry ${attempt + 1} for ${effectiveUrl}`);
                return new Promise((resolve, reject) => {
                    retryQueue.push({ name, creator, resolve, reject, retries: attempt + 1 });
                    scheduleRetryQueue();
                });
            }

            // If everything failed (CORS/offline/etc), prefer returning a cached vector icon if present.
            const cachedDataUrl = await tryLoadFromVectorCache(effectiveUrl);
            if (cachedDataUrl) {
                console.warn(`[ui-icon] Using OPFS cached icon after failures: ${effectiveUrl}`);
                return cachedDataUrl;
            }

            // Final fallback: return a simple placeholder SVG
            console.warn(`[ui-icon] All loading methods failed, using fallback SVG for: ${effectiveUrl}`, error);
            return FALLBACK_SVG_DATA_URL;
        }
    }

    const doLoad = async (): Promise<string> => {
        const element = await (creator ? creator?.(name) : name);
        if (isPathURL(element)) {
            // Recurse to get OPFS caching for path URLs
            return loadAsImageInternal(element, undefined, attempt);
        }
        let file: any = name;
        if (element instanceof Blob || element instanceof File) { file = element; }
        else {
            const text = typeof element == "string" ? element : element.outerHTML;
            file = new Blob([`<?xml version=\"1.0\" encoding=\"UTF-8\"?>`, text], { type: "image/svg+xml" });
        }
        return rasterizeSVG(file);
    };

    try {
        // First attempt with timeout
        return await withTimeout(doLoad(), FETCH_TIMEOUT_MS);
    } catch (error) {
        // On timeout, queue for retry if not exceeded max retries
        if (attempt < MAX_RETRIES && error instanceof Error && error.message === "Timeout") {
            return new Promise((resolve, reject) => {
                retryQueue.push({ name, creator, resolve, reject, retries: attempt + 1 });
                scheduleRetryQueue();
            });
        }
        throw error;
    }
};

export const loadAsImage = async (name: any, creator?: (name: any) => any): Promise<string> => {
    if (isPathURL(name)) { name = resolveAssetUrl(name) || name; }
    // @ts-ignore // !experimental `getOrInsert` feature!
    return iconMap.getOrInsertComputed(name, () => loadAsImageInternal(name, creator, 0));
};

/**
 * Clears in-memory caches for icon loading
 * Useful when switching themes or when cache becomes stale
 */
export const clearIconCaches = (): void => {
    resolvedUrlCache.clear();
    imageElementCache.clear();
    iconMap.clear();
    retryQueue.length = 0; // Clear pending retries

    if (typeof console !== "undefined") {
        console.log?.("[icon-loader] Cleared all in-memory caches");
    }
};

/**
 * Forces cache invalidation for a specific icon
 * @param iconName The icon name/URL to invalidate
 */
export const invalidateIconCache = (iconName: string): void => {
    if (!iconName) return;

    // Remove from in-memory caches
    resolvedUrlCache.delete(iconName);
    imageElementCache.delete(iconName);
    iconMap.delete(iconName);

    // Remove from OPFS cache (async, fire-and-forget)
    if (typeof import('./OPFSCache') !== 'undefined') {
        import('./OPFSCache').then(({ clearAllCache }) => {
            // For individual icons, we might want to implement selective clearing
            // For now, just clear problematic entries
            clearAllCache().catch(() => { /* silent */ });
        }).catch(() => { /* silent */ });
    }

    if (typeof console !== "undefined") {
        console.log?.(`[icon-loader] Invalidated cache for: ${iconName}`);
    }
};

/**
 * Tests the racing loading functionality by loading an icon with verbose logging
 * @param iconUrl The icon URL to test
 * @returns Promise that resolves to the loaded data URL
 */
export const testIconRacing = async (iconUrl: string): Promise<string> => {
    console.log(`[icon-test] Testing racing for: ${iconUrl}`);

    // Clear caches to force fresh load
    clearIconCaches();

    const startTime = performance.now();
    const result = await loadAsImage(iconUrl);
    const endTime = performance.now();

    console.log(`[icon-test] Racing test completed in ${(endTime - startTime).toFixed(2)}ms`);
    console.log(`[icon-test] Result:`, result.substring(0, 100) + '...');

    return result;
};

/**
 * Debug function to check icon system status
 */
export const debugIconSystem = (): void => {
    console.group('[icon-debug] Icon System Status');

    // Check caches first (always available)
    console.log('Resolved URL cache size:', resolvedUrlCache.size);
    console.log('Image element cache size:', imageElementCache.size);
    console.log('Icon map size:', iconMap.size);
    console.log('Retry queue length:', retryQueue.length);

    // Check CSS registry and OPFS asynchronously
    Promise.all([
        import('./CSSIconRegistry').then(({ getRegistryStats, ensureStyleSheet }) => {
            const sheet = ensureStyleSheet();
            const stats = getRegistryStats();
            console.log('CSS Registry:', stats);
            console.log('StyleSheet exists:', !!sheet);
            console.log('Adopted sheets:', document.adoptedStyleSheets?.length || 0);
            console.log('CSS rules in sheet:', sheet?.cssRules?.length || 0);
        }).catch(e => console.error('CSS Registry error:', e)),

        import('./OPFSCache').then(({ isOPFSSupported, getCacheStats }) => {
            console.log('OPFS supported:', isOPFSSupported());
            return getCacheStats().then(stats => {
                console.log('OPFS cache stats:', stats);
            });
        }).catch(e => console.error('OPFS check error:', e))
    ]).catch(() => {/* ignore */});

    // Check network status
    console.log('Network online:', navigator.onLine);
    console.log('Slow connection:', isSlowConnection());

    console.groupEnd();
};
