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
                        img.onload = null;
                        img.onerror = null;
                        reject(new Error(`Timeout loading icon: ${url}`));
                    }
                }, FETCH_TIMEOUT_MS);

                try { img.decoding = "async"; } catch (_) { /* noop */ }
                try { img.crossOrigin = "anonymous"; } catch (_) { /* noop */ }

                img.onload = () => {
                    if (settled) { return; }
                    settled = true;
                    clearTimeout(timeoutId);
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
                        retryImg.onload = () => resolve(retryImg);
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
        } catch {
            /* cache miss, proceed with rasterization */
        }
    }

    const img = await loadImageElement(url);
    const canvas = createCanvas(size);
    const context = canvas.getContext("2d") as CanvasRenderingContext2D;
    if (!context) { throw new Error("Unable to acquire 2d context"); }
    context?.clearRect?.(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in context) {
        try { context.imageSmoothingQuality = "high"; } catch (_) { /* noop */ }
    }

    const naturalWidth = img.naturalWidth || img.width || size;
    const naturalHeight = img.naturalHeight || img.height || size;
    const safeWidth = naturalWidth || size;
    const safeHeight = naturalHeight || size;
    const scale = Math.min(size / safeWidth, size / safeHeight) || 1;
    const drawWidth = safeWidth * scale;
    const drawHeight = safeHeight * scale;
    const offsetX = (size - drawWidth) / 2;
    const offsetY = (size - drawHeight) / 2;

    context?.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

    // Cache raster to OPFS in background
    if (isOPFSSupported()) {
        canvasToBlob(canvas).then((blob) => {
            if (blob) {
                cacheRasterIcon(opfsCacheKey, size, blob).catch(() => {
                    /* silent cache failure */
                });
            }
        }).catch(() => {
            /* silent */
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
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
    }
    const blob = await response.blob();

    // Cache in OPFS (non-blocking)
    if (isOPFSSupported()) {
        cacheVectorIcon(url, blob).catch(() => {
            /* silent cache failure */
        });
    }

    return blob;
};

// Internal loader with retry support and OPFS caching
const loadAsImageInternal = async (name: any, creator?: (name: any) => any, attempt = 0): Promise<string> => {
    if (isPathURL(name)) {
        const resolvedUrl = resolveAssetUrl(name);

        // Check OPFS cache first for vector icons
        if (isOPFSSupported()) {
            try {
                const cachedUrl = await getCachedVectorIcon(resolvedUrl);
                if (cachedUrl) {
                    return cachedUrl;
                }
            } catch {
                /* cache miss, proceed with fetch */
            }
        }

        // Fetch and cache
        try {
            const blob = await withTimeout(fetchAndCacheSvg(resolvedUrl), FETCH_TIMEOUT_MS);
            return URL.createObjectURL(blob);
        } catch (error) {
            // On timeout, queue for retry
            if (attempt < MAX_RETRIES && error instanceof Error && error.message === "Timeout") {
                return new Promise((resolve, reject) => {
                    retryQueue.push({ name, creator, resolve, reject, retries: attempt + 1 });
                    scheduleRetryQueue();
                });
            }
            // Fallback: return resolved URL directly (browser will fetch)
            return resolvedUrl;
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
