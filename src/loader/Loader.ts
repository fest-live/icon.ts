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
const FETCH_TIMEOUT_MS = 2000;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 3;

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
    const batch = retryQueue.splice(0, Math.min(4, retryQueue.length));
    for (const item of batch) {
        loadAsImageInternal(item.name, item.creator, item.retries)
            .then(item.resolve)
            .catch(item.reject);
    }
    scheduleRetryQueue();
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
                console.warn?.("[ui-icon] Rasterization failed, using SVG mask", error);
            }
            return fallbackMaskValue(effectiveUrl);
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
 * Fetches SVG content from URL and caches it in OPFS
 */
const fetchAndCacheSvg = async (url: string): Promise<Blob> => {
    console.log(`[ui-icon] Fetching SVG from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
    }
    const blob = await response.blob();
    console.log(`[ui-icon] Fetched blob of size: ${blob.size}`);
    return blob;
};

const toSvgDataUrl = (svgText: string): string => {
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

const rewritePhosphorUrl = (url: string): string => {
    // Legacy (broken) format used previously:
    // - https://cdn.jsdelivr.net/gh/phosphor-icons/phosphor-icons/src/{style}/{name}.svg
    //
    // Correct/stable format (npm package assets):
    // - https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/{style}/{name}-{style}.svg
    //
    // Keep this rewrite conservative: only rewrite known phosphor CDN patterns.
    if (!url || typeof url !== 'string') return url;

    try {
        const urlObj = new URL(url);

        // Only rewrite GitHub phosphor URLs
        if (urlObj.hostname === 'cdn.jsdelivr.net' &&
            urlObj.pathname.startsWith('/gh/phosphor-icons/phosphor-icons/')) {

            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            const srcIndex = pathParts.indexOf('src');

            if (srcIndex >= 0 && pathParts.length >= srcIndex + 3) {
                const style = pathParts[srcIndex + 1];
                const fileName = pathParts[srcIndex + 2];

                if (style && fileName && fileName.endsWith('.svg')) {
                    const iconName = fileName.replace(/\.svg$/i, '');

                    // Validate style and icon name
                    const validStyles = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];
                    if (validStyles.includes(style) && iconName && /^[a-z0-9-]+$/.test(iconName)) {
                        return `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/${style}/${iconName}-${style}.svg`;
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
    return /Failed to fetch:\s*4\d\d\b/.test(error.message);
};

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
            // Prefer OPFS cached blob URL (if available), fall back to network.
            const candidateUrls: string[] = [];
            if (isOPFSSupported()) {
                try {
                    const cached = await getCachedVectorIcon(effectiveUrl);
                    if (cached) { candidateUrls.push(cached); }
                } catch {
                    /* cache miss */
                }
            }
            candidateUrls.push(effectiveUrl);

            let lastError: unknown;
            for (const url of candidateUrls) {
                try {
                    const blob = await withTimeout(fetchAndCacheSvg(url), FETCH_TIMEOUT_MS);

                    // Cache into OPFS (store under the effective URL key)
                    if (isOPFSSupported() && url === effectiveUrl) {
                        cacheVectorIcon(effectiveUrl, blob).catch(() => { /* silent */ });
                    }

                    const svgText = await blob.text();
                    return toSvgDataUrl(svgText);
                } catch (e) {
                    lastError = e;
                }
            }
            throw lastError ?? new Error("Failed to load SVG");
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

            // Final fallback: return a simple placeholder SVG
            console.warn(`[ui-icon] All loading methods failed, using placeholder for: ${effectiveUrl}`);
            return "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDMTMuMSAyIDE0IDIuOSAxNCA0VjE2QzE0IDE3LjEgMTMuMSAxOCA5LjUgMThIMTUuNUMxNi45IDE4IDE4IDE3LjEgMTggMTZWNFY0QzE4IDIuOSAxNi45IDIgMTUuNSAySDEyWk0xMiAwaDE1LjVDMTguNiAwIDIwIDEuNCAyMCA0VjE2QzIwIDE4LjYgMTguNiAyMCAxNS41IDIwSDguNUM1LjQgMjAgNCAxOC42IDQgMTZWNFY0QzQgMS40IDUuNCAwIDguNSAwSDEyWk04LjUgNFYxNkgyMEw4LjUgNFoiIGZpbGw9ImN1cnJlbnRDb2xvciIvPgo8L3N2Zz4K";
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
