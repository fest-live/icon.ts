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

// Known working CDNs (avoid CORS issues)
const RELIABLE_CDNS = [
    'cdn.jsdelivr.net',
    'unpkg.com'
    // Excluding: 'cdn.skypack.dev', 'esm.sh' - known CORS issues
];

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
    const response = await fetch(url, {
        credentials: 'omit', // Prevent CORS issues with CDNs that return wildcard headers
        mode: 'cors' // Explicitly set CORS mode for external requests
    });
    if (!response.ok) {
        const errorMsg = `Failed to fetch ${url}: ${response.status} ${response.statusText}`;
        console.warn(`[ui-icon] ${errorMsg}`);
        throw new Error(errorMsg);
    }
    const blob = await response.blob();
    console.log(`[ui-icon] Fetched blob of size: ${blob.size} bytes`);
    return blob;
};

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

    // Don't retry 4xx client errors (except 408 Request Timeout which might be network related)
    if (/Failed to fetch:\s*4\d\d\b/.test(error.message)) {
        return !/408/.test(error.message); // Allow retry for 408
    }

    // Retry on network-related errors that might be temporary
    return /network|timeout|offline|connection|aborted/i.test(error.message) ||
           error.name === 'TypeError' && /fetch/i.test(error.message);
};

// Internal loader with retry support
/**
 * Races multiple icon sources and returns the first successful one,
 * while continuing to check for better/newer versions in the background
 */
const raceAndUpgradeIcon = async (candidateUrls: Array<{url: string, priority: number, isLocal?: boolean}>, effectiveUrl: string): Promise<string> => {
    if (candidateUrls.length === 0) {
        throw new Error("No candidate URLs provided");
    }

    // Sort by priority (lower number = higher priority)
    candidateUrls.sort((a, b) => a.priority - b.priority);

    return new Promise((resolve, reject) => {
        let resolved = false;
        let bestResult: {url: string, dataUrl: string, priority: number} | null = null;
        const errors: Array<{url: string, error: unknown}> = [];

        const tryResolve = (url: string, dataUrl: string, priority: number) => {
            if (resolved && bestResult && priority >= bestResult.priority) {
                // We already have a better or equal result, just cache this one
                if (isOPFSSupported() && url === effectiveUrl) {
                    fetchAndCacheSvg(url).catch(() => {/* silent */});
                }
                console.log(`[ui-icon] Loaded backup source for ${effectiveUrl}: ${url} (priority: ${priority})`);
                return;
            }

            if (!resolved) {
                resolved = true;
                bestResult = {url, dataUrl, priority};
                console.log(`[ui-icon] Fastest source for ${effectiveUrl}: ${url} (priority: ${priority})`);
                resolve(dataUrl);

                // Continue loading better versions in background
                loadBetterVersions(candidateUrls, priority, effectiveUrl);
            } else if (!bestResult || priority < bestResult.priority) {
                // Found a better version, update the result
                bestResult = {url, dataUrl, priority};
                console.log(`[ui-icon] Upgraded to better version for ${effectiveUrl}: ${url} (priority: ${priority})`);
                // Note: We don't re-resolve here as the component might have already rendered
                // But we can update caches and prepare for future loads
            }

            // Cache successful loads
            if (isOPFSSupported() && url === effectiveUrl) {
                fetchAndCacheSvg(url).catch(() => {/* silent */});
            }
        };

        const loadBetterVersions = (remainingUrls: Array<{url: string, priority: number}>, currentPriority: number, effectiveUrl: string) => {
            // Continue loading higher priority (better) versions in background
            const betterUrls = remainingUrls.filter(candidate => candidate.priority < currentPriority);
            betterUrls.forEach(candidate => {
                withTimeout(fetchAndCacheSvg(candidate.url), FETCH_TIMEOUT_MS)
                    .then(async (blob) => {
                        // Same validation as main loading
                        if (!blob || blob.size === 0) return;
                        if (blob.size > 1024 * 1024) return;

                        const svgText = await blob.text();
                        if (!svgText || svgText.trim().length === 0) return;

                        const dataUrl = toSvgDataUrl(svgText);
                        if (!dataUrl || !dataUrl.startsWith('data:image/svg+xml')) return;

                        console.log(`[ui-icon] Background loaded better version from ${candidate.url}`);
                        tryResolve(candidate.url, dataUrl, candidate.priority);
                    })
                    .catch(() => {/* ignore background load failures */});
            });
        };

        // Start racing all candidates
        candidateUrls.forEach(candidate => {
            // Use shorter timeout for non-primary sources to fail faster
            const timeout = candidate.priority <= 1 ? FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS * 0.7;
            withTimeout(fetchAndCacheSvg(candidate.url), timeout)
                .then(async (blob) => {
                    // Validate blob before processing
                    if (!blob || blob.size === 0) {
                        throw new Error(`Empty or invalid blob from ${candidate.url}`);
                    }

                    if (blob.size > 1024 * 1024) { // 1MB limit
                        throw new Error(`Blob too large from ${candidate.url}: ${blob.size} bytes`);
                    }

                    const svgText = await blob.text();

                    // Additional validation for SVG content
                    if (!svgText || svgText.trim().length === 0) {
                        throw new Error(`Empty SVG content from ${candidate.url}`);
                    }

                    const dataUrl = toSvgDataUrl(svgText);

                    // Validate the data URL was created successfully
                    if (!dataUrl || !dataUrl.startsWith('data:image/svg+xml')) {
                        throw new Error(`Failed to create valid data URL from ${candidate.url}`);
                    }

                    console.log(`[ui-icon] Successfully loaded ${candidate.isLocal ? 'local' : 'remote'} icon from ${candidate.url} (${svgText.length} chars)`);
                    tryResolve(candidate.url, dataUrl, candidate.priority);
                })
                .catch((error) => {
                    // Provide more specific error messages for common issues
                    let errorMsg = error?.message || error;
                    let isCorsError = false;

                    if (errorMsg.includes('CORS') || errorMsg.includes('Access-Control')) {
                        errorMsg = `CORS policy blocked access to ${candidate.url}. Skipping this CDN.`;
                        isCorsError = true;
                    } else if (errorMsg.includes('Failed to fetch')) {
                        errorMsg = `Network error loading ${candidate.url}.`;
                    }

                    // Log CORS errors at a lower level since they're expected for some CDNs
                    if (isCorsError) {
                        console.log(`[ui-icon] CORS blocked: ${candidate.url} - trying next source`);
                    } else {
                        console.warn(`[ui-icon] Failed to load from ${candidate.url}: ${errorMsg}`);
                    }

                    errors.push({url: candidate.url, error: new Error(errorMsg)});

                    // If all candidates failed, reject
                    if (errors.length === candidateUrls.length && !resolved) {
                        const errorMessages = errors.map(e => `${e.url}: ${(e.error as Error).message}`).join('; ');
                        reject(new Error(`All ${candidateUrls.length} icon sources failed: ${errorMessages}`));
                    }
                });
        });
    });
};

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
            // Create candidate URLs with priorities (lower = better)
            const candidateUrls: Array<{url: string, priority: number, isLocal?: boolean}> = [];

            // Priority 0: OPFS cached blob URLs (fastest) - non-blocking
            if (isOPFSSupported()) {
                // Start cache check in background, don't await
                getCachedVectorIcon(effectiveUrl).then(cached => {
                    if (cached) {
                        candidateUrls.unshift({url: cached, priority: 0, isLocal: true});
                        console.log(`[ui-icon] Added cached version for ${effectiveUrl}: ${cached}`);
                    }
                }).catch(() => {
                    /* cache miss - ignore */
                });
            }

            // Priority 0.5: Local same-origin resources (if available)
            try {
                const urlObj = new URL(effectiveUrl);
                if (urlObj.origin === window.location.origin) {
                    // This is already a local resource, prioritize it
                    candidateUrls.push({url: effectiveUrl, priority: 0.5, isLocal: true});
                }
            } catch {
                /* invalid URL - ignore */
            }

            // Priority 1: Primary CDN URL (if not already added as local)
            if (!candidateUrls.some(c => c.url === effectiveUrl)) {
                candidateUrls.push({url: effectiveUrl, priority: 1});
            }

            // Priority 2: Alternative CDN versions (try newer versions first)
            if (effectiveUrl.includes('cdn.jsdelivr.net') && effectiveUrl.includes('@phosphor-icons/core')) {
                // Try newer versions first, then older ones
                const altVersions = ['latest', '3', '2.1', '2'];
                altVersions.forEach((version, index) => {
                    if (!effectiveUrl.includes(`@${version}`)) {
                        const altUrl = effectiveUrl.replace(/@\d+(?:\.\d+)?/, `@${version}`);
                        candidateUrls.push({url: altUrl, priority: 2 + index * 0.1}); // Fine-grained priority
                    }
                });
            }

            // Priority 3: Alternative CDN mirrors (only reliable ones)
            if (effectiveUrl.includes('cdn.jsdelivr.net')) {
                RELIABLE_CDNS.forEach((cdn, index) => {
                    if (!effectiveUrl.includes(cdn)) {
                        const mirror = { url: effectiveUrl.replace('cdn.jsdelivr.net', cdn), priority: 3 + index * 0.1 };
                        candidateUrls.push({url: mirror.url, priority: mirror.priority});
                    }
                });
            }

            // Priority 4: HTTP fallback for HTTPS-only failures (rare but useful for some networks)
            if (effectiveUrl.startsWith('https://')) {
                candidateUrls.push({url: effectiveUrl.replace('https://', 'http://'), priority: 4});
            }

            // Debug logging for racing candidates
            if (candidateUrls.length > 1) {
                console.log(`[ui-icon] Racing ${candidateUrls.length} sources for ${effectiveUrl}:`,
                    candidateUrls.map(c => ({
                        url: c.url.replace('https://', '').split('/')[0], // Just show domain for brevity
                        priority: c.priority,
                        local: c.isLocal || false
                    })));
            }

            // Race all candidates and return the fastest successful one
            const result = await raceAndUpgradeIcon(candidateUrls, effectiveUrl);
            return result;

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
