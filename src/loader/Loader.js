import { isOPFSSupported, getCachedVectorIcon, cacheVectorIcon, getCachedRasterIcon, cacheRasterIcon, } from "./OPFSCache";
import { registerIconRule, } from "./CSSIconRegistry";
//
//import * as icons from "lucide";
export const iconMap = new Map();
// Minimal caches - only for in-flight operations, not long-term storage
// CSS stylesheet handles the actual caching via attribute selectors
export const resolvedUrlCache = new Map();
export const imageElementCache = new Map();
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
const isOnline = () => {
    try {
        return navigator.onLine !== false;
    }
    catch {
        return true; // Assume online if can't detect
    }
};
const isSlowConnection = () => {
    try {
        const connection = navigator.connection ||
            navigator.mozConnection ||
            navigator.webkitConnection;
        if (!connection)
            return false;
        // Check for slow connection types
        const slowTypes = ['slow-2g', '2g', '3g'];
        return slowTypes.includes(connection.effectiveType) ||
            connection.saveData === true ||
            connection.downlink < 1.5; // Less than 1.5 Mbps
    }
    catch {
        return false;
    }
};
const retryQueue = [];
let retryScheduled = false;
const scheduleRetryQueue = () => {
    if (retryScheduled || retryQueue.length === 0) {
        return;
    }
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
const withTimeout = (promise, ms) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Timeout")), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};
const globalScope = typeof globalThis !== "undefined" ? globalThis : {};
const hasChromeRuntime = () => {
    try {
        const chromeRuntime = globalThis?.chrome?.runtime;
        return !!chromeRuntime?.id;
    }
    catch {
        return false;
    }
};
const pickBaseUrl = () => {
    try {
        if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI !== "about:blank") {
            return document.baseURI;
        }
    }
    catch {
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
    }
    catch {
        /* noop */
    }
    return undefined;
};
const DEFAULT_BASE_URL = pickBaseUrl();
export const fallbackMaskValue = (url) => (!url ? "none" : `url("${url}")`);
export const resolveAssetUrl = (input) => {
    if (!input || typeof input !== "string") {
        return "";
    }
    const cached = resolvedUrlCache.get(input);
    if (cached) {
        return cached;
    }
    let resolved = input;
    if (typeof URL === "function") {
        try {
            resolved = DEFAULT_BASE_URL ? new URL(input, DEFAULT_BASE_URL).href : new URL(input).href;
        }
        catch {
            try {
                resolved = new URL(input, globalScope.location?.origin ?? undefined).href;
            }
            catch {
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
const inflightPromises = new Map();
const isSafeCssMaskUrl = (url) => {
    if (!url || typeof url !== "string")
        return false;
    const trimmed = url.trim();
    if (!trimmed)
        return false;
    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:"))
        return true;
    // Allow relative and root-relative paths (same-origin).
    if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../"))
        return true;
    // For absolute URLs, only allow same-origin to avoid CSS cross-origin fetch + credentials issues.
    if (typeof URL === "function") {
        try {
            const base = globalScope.location?.origin ?? DEFAULT_BASE_URL;
            const parsed = new URL(trimmed, base);
            const origin = globalScope.location?.origin;
            if (origin && parsed.origin === origin)
                return true;
        }
        catch {
            return false;
        }
    }
    return false;
};
/**
 * Generates cache key for icon lookup
 */
const makeCacheKey = (cacheKey, normalizedUrl, bucket) => {
    const sanitizedKey = (cacheKey ?? "").trim();
    return sanitizedKey ? `${sanitizedKey}@${bucket}` : `${normalizedUrl}@${bucket}`;
};
export const quantizeToBucket = (value) => {
    if (!Number.isFinite(value) || value <= 0) {
        value = MIN_RASTER_SIZE;
    }
    const safe = Math.max(value, MIN_RASTER_SIZE);
    const bucket = 2 ** Math.ceil(Math.log2(safe));
    return Math.min(MAX_RASTER_SIZE, bucket);
};
export const loadImageElement = (url) => {
    const resolvedUrl = resolveAssetUrl(url);
    if (!resolvedUrl) {
        return Promise.reject(new Error("Invalid icon URL"));
    }
    if (!imageElementCache.has(resolvedUrl)) {
        const promise = (async () => {
            // Try OPFS cache first for blob URL
            let effectiveUrl = resolvedUrl;
            if (isOPFSSupported()) {
                try {
                    const cachedUrl = await getCachedVectorIcon(resolvedUrl);
                    if (cachedUrl) {
                        effectiveUrl = cachedUrl;
                    }
                }
                catch {
                    /* cache miss */
                }
            }
            return new Promise((resolve, reject) => {
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
                try {
                    img.decoding = "async";
                }
                catch (_) { /* noop */ }
                try {
                    img.crossOrigin = "anonymous";
                }
                catch (_) { /* noop */ }
                // Prevent image from being displayed if it accidentally gets added to DOM
                img.style.display = 'none';
                img.style.position = 'absolute';
                img.style.visibility = 'hidden';
                img.onload = () => {
                    if (settled) {
                        return;
                    }
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
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeoutId);
                    // If cached URL failed, try original URL
                    if (effectiveUrl !== resolvedUrl) {
                        const retryImg = new Image();
                        try {
                            retryImg.decoding = "async";
                        }
                        catch (_) { /* noop */ }
                        try {
                            retryImg.crossOrigin = "anonymous";
                        }
                        catch (_) { /* noop */ }
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
                try {
                    await img.decode();
                }
                catch (_) { /* ignore decode errors */ }
            }
            // Cache SVG to OPFS if loaded from network
            if (isOPFSSupported() && img.src === resolvedUrl) {
                // Fetch and cache in background
                fetch(resolvedUrl)
                    .then(r => r.blob())
                    .then(blob => cacheVectorIcon(resolvedUrl, blob))
                    .catch(() => { });
            }
            return img;
        }).catch((error) => {
            // Remove from cache on failure to allow retry
            imageElementCache.delete(resolvedUrl);
            throw error;
        });
        imageElementCache.set(resolvedUrl, promise);
    }
    return imageElementCache.get(resolvedUrl);
};
export const createCanvas = (size) => {
    const dimension = Math.max(size, MIN_RASTER_SIZE);
    if (typeof OffscreenCanvas !== "undefined") {
        return new OffscreenCanvas(dimension, dimension);
    }
    const canvas = document.createElement("canvas");
    canvas.width = dimension;
    canvas.height = dimension;
    return canvas;
};
export const canvasToImageUrl = async (canvas) => {
    if ("convertToBlob" in canvas) {
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return URL.createObjectURL(blob);
    }
    const htmlCanvas = canvas;
    if (typeof htmlCanvas.toBlob === "function") {
        const blob = await new Promise((resolve, reject) => {
            htmlCanvas.toBlob((blobValue) => {
                if (blobValue) {
                    resolve(blobValue);
                }
                else {
                    reject(new Error("Canvas toBlob returned null"));
                }
            }, "image/png");
        });
        return URL.createObjectURL(blob);
    }
    return htmlCanvas.toDataURL("image/png");
};
/**
 * Converts canvas to blob for OPFS caching
 */
const canvasToBlob = async (canvas) => {
    try {
        if ("convertToBlob" in canvas) {
            return await canvas.convertToBlob({ type: "image/png" });
        }
        const htmlCanvas = canvas;
        if (typeof htmlCanvas.toBlob === "function") {
            return await new Promise((resolve) => {
                htmlCanvas.toBlob((blob) => resolve(blob), "image/png");
            });
        }
    }
    catch {
        /* noop */
    }
    return null;
};
export const rasterizeSvgToMask = async (url, bucket, cacheKey) => {
    const size = Math.max(bucket, MIN_RASTER_SIZE);
    const opfsCacheKey = cacheKey || url;
    // Check OPFS cache first for raster version
    if (isOPFSSupported()) {
        try {
            const cachedRaster = await getCachedRasterIcon(opfsCacheKey, size);
            if (cachedRaster) {
                return fallbackMaskValue(cachedRaster);
            }
        }
        catch (error) {
            console.warn('[ui-icon] OPFS cache read failed:', error);
        }
    }
    const img = await loadImageElement(url);
    const canvas = createCanvas(size);
    const context = canvas.getContext("2d", {
        alpha: true,
        desynchronized: true,
        willReadFrequently: false
    });
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
    }
    catch (error) {
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
export const ensureMaskValue = (url, cacheKey, bucket) => {
    const safeUrl = typeof url === "string" ? url : "";
    const normalizedUrl = resolveAssetUrl(safeUrl);
    const effectiveUrl = normalizedUrl || safeUrl;
    const key = makeCacheKey(cacheKey, normalizedUrl, bucket);
    if (!effectiveUrl) {
        return Promise.resolve(fallbackMaskValue(""));
    }
    // Check if already in-flight
    const inflight = inflightPromises.get(key);
    if (inflight) {
        return inflight;
    }
    const promise = loadAsImage(effectiveUrl)
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
export const camelToKebab = (camel) => {
    if (typeof camel !== "string") {
        return "";
    }
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
export const createImageSetValue = (url, resolutions = []) => {
    if (!url) {
        return "linear-gradient(#0000, #0000)";
    }
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
export const generateIconImageVariable = (iconName, url, bucket) => {
    // Parse iconName to extract the style if it's in "style:name" format
    const parts = iconName.split(":");
    const [iconStyle, name] = parts.length === 2 ? parts : ["duotone", iconName];
    // Register in the CSS stylesheet via registry
    registerIconRule(name, iconStyle, url, bucket);
};
export const isPathURL = (url) => {
    if (typeof url !== "string" || !url) {
        return false;
    }
    if (typeof URL === "undefined") {
        return /^([a-z]+:)?\/\//i.test(url) || url.startsWith("/") || url.startsWith("./") || url.startsWith("../");
    }
    if (typeof URL.canParse === "function") {
        try {
            if (URL.canParse(url, DEFAULT_BASE_URL)) {
                return true;
            }
            if (globalScope.location?.origin && URL.canParse(url, globalScope.location.origin)) {
                return true;
            }
        }
        catch {
            /* noop */
        }
    }
    try {
        new URL(url, DEFAULT_BASE_URL ?? globalScope.location?.origin ?? undefined);
        return true;
    }
    catch {
        return false;
    }
};
export const rasterizeSVG = (blob) => { return isPathURL(blob) ? resolveAssetUrl(blob) : URL.createObjectURL(blob); };
/**
 * Fetches SVG content with a hard timeout and abort support.
 * This prevents “fetch storms” from piling up and timing out later.
 */
const fetchSvgBlob = async (url, timeoutMs) => {
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
    }
    catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error("Timeout");
        }
        throw e;
    }
    finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
};
const tryLoadFromVectorCache = async (canonicalUrl) => {
    if (!canonicalUrl)
        return null;
    if (!isOPFSSupported())
        return null;
    try {
        const cached = await getCachedVectorIcon(canonicalUrl);
        if (!cached)
            return null;
        const blob = await fetchSvgBlob(cached, FETCH_TIMEOUT_MS);
        const svgText = await blob.text();
        if (!svgText || svgText.trim().length === 0)
            return null;
        return toSvgDataUrl(svgText);
    }
    catch {
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
const toSvgDataUrl = (svgText) => {
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
    }
    catch {
        // Fallback to the original method if TextEncoder fails
        try {
            return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
        }
        catch {
            // Final fallback: return SVG as-is without base64 encoding
            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
        }
    }
};
const FALLBACK_SVG_DATA_URL = (() => {
    try {
        return toSvgDataUrl(FALLBACK_SVG_TEXT);
    }
    catch {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FALLBACK_SVG_TEXT)}`;
    }
})();
export const FALLBACK_ICON_DATA_URL = FALLBACK_SVG_DATA_URL;
const rewritePhosphorUrl = (url) => {
    // Legacy (broken) format used previously:
    // - https://cdn.jsdelivr.net/gh/phosphor-icons/phosphor-icons/src/{style}/{name}.svg
    //
    // Correct/stable format (npm package assets):
    // - https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/{style}/{name}.svg
    //
    // Keep this rewrite conservative: only rewrite known phosphor patterns.
    if (!url || typeof url !== 'string')
        return url;
    try {
        const isHttpOrigin = (() => {
            const proto = globalScope.location?.protocol || "";
            return proto === "http:" || proto === "https:";
        })();
        const isExtensionRuntime = hasChromeRuntime();
        const toNpmAssetUrl = (style, baseName) => {
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
        // `/assets/icons/*` aliases may not exist. Rewrite to stable CDN URL.
        if ((isExtensionRuntime || !isHttpOrigin) && urlObj.pathname.startsWith("/assets/icons/")) {
            const parts = urlObj.pathname.split("/").filter(Boolean);
            const validStyles = ["thin", "light", "regular", "bold", "fill", "duotone"];
            let style = "duotone";
            let baseName = "";
            // /assets/icons/phosphor/:style/:icon
            if (parts[2] === "phosphor") {
                style = (parts[3] || "duotone").toLowerCase();
                baseName = (parts[4] || "").replace(/\.svg$/i, "");
            }
            else if (parts[2] === "duotone") {
                // /assets/icons/duotone/:icon
                style = "duotone";
                baseName = (parts[3] || "").replace(/\.svg$/i, "");
            }
            else if (parts.length >= 4) {
                // /assets/icons/:style/:icon
                style = (parts[2] || "duotone").toLowerCase();
                baseName = (parts[3] || "").replace(/\.svg$/i, "");
            }
            else if (parts.length === 3) {
                // /assets/icons/:icon (default style)
                style = "duotone";
                baseName = (parts[2] || "").replace(/\.svg$/i, "");
            }
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
                    }
                    else if (style !== 'regular' && iconName.endsWith(`-${style}`)) {
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
                    }
                    else if (style !== 'regular' && iconName.endsWith(`-${style}`)) {
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
    }
    catch (error) {
        // Invalid URL, return as-is
        console.warn('[ui-icon] Invalid URL for phosphor rewrite:', url, error);
    }
    return url;
};
const isClientErrorStatus = (error) => {
    if (!(error instanceof Error)) {
        return false;
    }
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
const loadAsImageInternal = async (name, creator, attempt = 0) => {
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
                }
                catch {
                    /* cache miss or timeout */
                }
            }
            // Build a small, correct fallback list (sequential attempts).
            // If phosphor rewrite points to local proxy and it fails (e.g. 502),
            // we must still try original CDN source for first-time users.
            const candidates = [effectiveUrl];
            if (effectiveUrl !== resolvedUrl) {
                candidates.push(resolvedUrl);
            }
            // Add CDN mirrors for every candidate that points to jsDelivr.
            for (const candidate of [...candidates]) {
                // jsDelivr -> unpkg (correct path mapping for phosphor assets)
                if (candidate.startsWith("https://cdn.jsdelivr.net/npm/")) {
                    const unpkg = candidate.replace("https://cdn.jsdelivr.net/npm/", "https://unpkg.com/");
                    if (!candidates.includes(unpkg)) {
                        candidates.push(unpkg);
                    }
                }
                // Only attempt a second mirror if it’s an https URL and not already included.
                if (candidate.startsWith("https://") && candidate.includes("cdn.jsdelivr.net")) {
                    const mirror = candidate.replace("cdn.jsdelivr.net", "unpkg.com").replace("/npm/", "/");
                    if (!candidates.includes(mirror)) {
                        candidates.push(mirror);
                    }
                }
            }
            const errors = [];
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
                        cacheVectorIcon(effectiveUrl, blob).catch(() => { });
                    }
                    return dataUrl;
                }
                catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    errors.push(new Error(`${url}: ${err.message}`));
                }
            }
            throw new Error(`All icon sources failed: ${errors.map(e => e.message).join("; ")}`);
        }
        catch (error) {
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
    const doLoad = async () => {
        const element = await (creator ? creator?.(name) : name);
        if (isPathURL(element)) {
            // Recurse to get OPFS caching for path URLs
            return loadAsImageInternal(element, undefined, attempt);
        }
        let file = name;
        if (element instanceof Blob || element instanceof File) {
            file = element;
        }
        else {
            const text = typeof element == "string" ? element : element.outerHTML;
            file = new Blob([`<?xml version=\"1.0\" encoding=\"UTF-8\"?>`, text], { type: "image/svg+xml" });
        }
        return rasterizeSVG(file);
    };
    try {
        // First attempt with timeout
        return await withTimeout(doLoad(), FETCH_TIMEOUT_MS);
    }
    catch (error) {
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
export const loadAsImage = async (name, creator) => {
    if (isPathURL(name)) {
        name = resolveAssetUrl(name) || name;
    }
    // @ts-ignore // !experimental `getOrInsert` feature!
    return iconMap.getOrInsertComputed(name, () => loadAsImageInternal(name, creator, 0));
};
/**
 * Clears in-memory caches for icon loading
 * Useful when switching themes or when cache becomes stale
 */
export const clearIconCaches = () => {
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
export const invalidateIconCache = (iconName) => {
    if (!iconName)
        return;
    // Remove from in-memory caches
    resolvedUrlCache.delete(iconName);
    imageElementCache.delete(iconName);
    iconMap.delete(iconName);
    // Remove from OPFS cache (async, fire-and-forget)
    if (typeof import('./OPFSCache') !== 'undefined') {
        import('./OPFSCache').then(({ clearAllCache }) => {
            // For individual icons, we might want to implement selective clearing
            // For now, just clear problematic entries
            clearAllCache().catch(() => { });
        }).catch(() => { });
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
export const testIconRacing = async (iconUrl) => {
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
export const debugIconSystem = () => {
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
    ]).catch(() => { });
    // Check network status
    console.log('Network online:', navigator.onLine);
    console.log('Slow connection:', isSlowConnection());
    console.groupEnd();
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9hZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiTG9hZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFDSCxlQUFlLEVBQ2YsbUJBQW1CLEVBQ25CLGVBQWUsRUFDZixtQkFBbUIsRUFDbkIsZUFBZSxHQUNsQixNQUFNLGFBQWEsQ0FBQztBQUVyQixPQUFPLEVBQ0gsZ0JBQWdCLEdBRW5CLE1BQU0sbUJBQW1CLENBQUM7QUFFM0IsRUFBRTtBQUNGLGtDQUFrQztBQUNsQyxNQUFNLENBQUMsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLEVBQTJCLENBQUM7QUFFMUQsd0VBQXdFO0FBQ3hFLG9FQUFvRTtBQUNwRSxNQUFNLENBQUMsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsRUFBa0IsQ0FBQztBQUMxRCxNQUFNLENBQUMsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLEdBQUcsRUFBcUMsQ0FBQztBQUU5RSxnREFBZ0Q7QUFDaEQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLFdBQVcsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRWxFLE1BQU0sQ0FBQyxNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUFDbkMsTUFBTSxDQUFDLE1BQU0sZUFBZSxHQUFHLEVBQUUsQ0FBQztBQUVsQyx3Q0FBd0M7QUFDeEMsNkNBQTZDO0FBQzdDLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0FBQzlCLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxDQUFDLG9CQUFvQjtBQUNqRCxNQUFNLFdBQVcsR0FBRyxDQUFDLENBQUMsQ0FBQyx1Q0FBdUM7QUFFOUQsOEJBQThCO0FBQzlCLE1BQU0sUUFBUSxHQUFHLEdBQVksRUFBRTtJQUMzQixJQUFJLENBQUM7UUFDRCxPQUFPLFNBQVMsQ0FBQyxNQUFNLEtBQUssS0FBSyxDQUFDO0lBQ3RDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxPQUFPLElBQUksQ0FBQyxDQUFDLGdDQUFnQztJQUNqRCxDQUFD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RUFBRSxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDckUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUV0RCxNQUFNLENBQUMsYUFBYSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxlQUFlLEVBQUUsYUFBYSxFQUFFLEVBQUUsRUFBRTtZQUM5RCxPQUFPLENBQUMsR0FBRyxDQUFDLGlCQUFpQixFQUFFLGVBQWUsRUFBRSxDQUFDLENBQUM7WUFDbEQsT0FBTyxhQUFhLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUU7Z0JBQ2hDLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDNUMsQ0FBQyxDQUFDLENBQUM7UUFDUCxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLG1CQUFtQixFQUFFLENBQUMsQ0FBQyxDQUFDO0tBQ3ZELENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLEdBQWMsQ0FBQyxDQUFDLENBQUM7SUFFL0IsdUJBQXVCO0lBQ3ZCLE9BQU8sQ0FBQyxHQUFHLENBQUMsaUJBQWlCLEVBQUUsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2pELE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCLEVBQUUsZ0JBQWdCLEVBQUUsQ0FBQyxDQUFDO0lBRXBELE9BQU8sQ0FBQyxRQUFRLEVBQUUsQ0FBQztBQUN2QixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICAgIGlzT1BGU1N1cHBvcnRlZCxcbiAgICBnZXRDYWNoZWRWZWN0b3JJY29uLFxuICAgIGNhY2hlVmVjdG9ySWNvbixcbiAgICBnZXRDYWNoZWRSYXN0ZXJJY29uLFxuICAgIGNhY2hlUmFzdGVySWNvbixcbn0gZnJvbSBcIi4vT1BGU0NhY2hlXCI7XG5cbmltcG9ydCB7XG4gICAgcmVnaXN0ZXJJY29uUnVsZSxcbiAgICBoYXNJY29uUnVsZSxcbn0gZnJvbSBcIi4vQ1NTSWNvblJlZ2lzdHJ5XCI7XG5cbi8vXG4vL2ltcG9ydCAqIGFzIGljb25zIGZyb20gXCJsdWNpZGVcIjtcbmV4cG9ydCBjb25zdCBpY29uTWFwID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8c3RyaW5nPj4oKTtcblxuLy8gTWluaW1hbCBjYWNoZXMgLSBvbmx5IGZvciBpbi1mbGlnaHQgb3BlcmF0aW9ucywgbm90IGxvbmctdGVybSBzdG9yYWdlXG4vLyBDU1Mgc3R5bGVzaGVldCBoYW5kbGVzIHRoZSBhY3R1YWwgY2FjaGluZyB2aWEgYXR0cmlidXRlIHNlbGVjdG9yc1xuZXhwb3J0IGNvbnN0IHJlc29sdmVkVXJsQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuZXhwb3J0IGNvbnN0IGltYWdlRWxlbWVudENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8SFRNTEltYWdlRWxlbWVudD4+KCk7XG5cbi8vIFJlLWV4cG9ydCByZWdpc3RyeSBmdW5jdGlvbnMgZm9yIGV4dGVybmFsIHVzZVxuZXhwb3J0IHsgcmVnaXN0ZXJJY29uUnVsZSwgaGFzSWNvblJ1bGUgfSBmcm9tIFwiLi9DU1NJY29uUmVnaXN0cnlcIjtcblxuZXhwb3J0IGNvbnN0IE1BWF9SQVNURVJfU0laRSA9IDUxMjtcbmV4cG9ydCBjb25zdCBNSU5fUkFTVEVSX1NJWkUgPSAzMjtcblxuLy8gVGltZW91dCBhbmQgcmV0cnkgcXVldWUgY29uZmlndXJhdGlvblxuLy8gSW5jcmVhc2VkIHRpbWVvdXQgZm9yIG1vYmlsZS9zbG93IG5ldHdvcmtzXG5jb25zdCBGRVRDSF9USU1FT1VUX01TID0gNTAwMDtcbmNvbnN0IFJFVFJZX0RFTEFZX01TID0gMTAwMDsgLy8gUHJvZ3Jlc3NpdmUgZGVsYXlcbmNvbnN0IE1BWF9SRVRSSUVTID0gNTsgLy8gTW9yZSByZXRyaWVzIGZvciB1bnJlbGlhYmxlIG5ldHdvcmtzXG5cbi8vIE5ldHdvcmsgZGV0ZWN0aW9uIHV0aWxpdGllc1xuY29uc3QgaXNPbmxpbmUgPSAoKTogYm9vbGVhbiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIG5hdmlnYXRvci5vbkxpbmUgIT09IGZhbHNlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gdHJ1ZTsgLy8gQXNzdW1lIG9ubGluZSBpZiBjYW4ndCBkZXRlY3RcbiAgICB9XG59O1xuXG5jb25zdCBpc1Nsb3dDb25uZWN0aW9uID0gKCk6IGJvb2xlYW4gPT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNvbm5lY3Rpb24gPSAobmF2aWdhdG9yIGFzIGFueSkuY29ubmVjdGlvbiB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAobmF2aWdhdG9yIGFzIGFueSkubW96Q29ubmVjdGlvbiB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAobmF2aWdhdG9yIGFzIGFueSkud2Via2l0Q29ubmVjdGlvbjtcbiAgICAgICAgaWYgKCFjb25uZWN0aW9uKSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgLy8gQ2hlY2sgZm9yIHNsb3cgY29ubmVjdGlvbiB0eXBlc1xuICAgICAgICBjb25zdCBzbG93VHlwZXMgPSBbJ3Nsb3ctMmcnLCAnMmcnLCAnM2cnXTtcbiAgICAgICAgcmV0dXJuIHNsb3dUeXBlcy5pbmNsdWRlcyhjb25uZWN0aW9uLmVmZmVjdGl2ZVR5cGUpIHx8XG4gICAgICAgICAgICAgICBjb25uZWN0aW9uLnNhdmVEYXRhID09PSB0cnVlIHx8XG4gICAgICAgICAgICAgICBjb25uZWN0aW9uLmRvd25saW5rIDwgMS41OyAvLyBMZXNzIHRoYW4gMS41IE1icHNcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn07XG5cbi8vIERlbGF5ZWQgcmV0cnkgcXVldWVcbnR5cGUgUXVldWVkSXRlbSA9IHsgbmFtZTogc3RyaW5nOyBjcmVhdG9yPzogKG5hbWU6IGFueSkgPT4gYW55OyByZXNvbHZlOiAodjogc3RyaW5nKSA9PiB2b2lkOyByZWplY3Q6IChlOiBFcnJvcikgPT4gdm9pZDsgcmV0cmllczogbnVtYmVyIH07XG5jb25zdCByZXRyeVF1ZXVlOiBRdWV1ZWRJdGVtW10gPSBbXTtcbmxldCByZXRyeVNjaGVkdWxlZCA9IGZhbHNlO1xuXG5jb25zdCBzY2hlZHVsZVJldHJ5UXVldWUgPSAoKSA9PiB7XG4gICAgaWYgKHJldHJ5U2NoZWR1bGVkIHx8IHJldHJ5UXVldWUubGVuZ3RoID09PSAwKSB7IHJldHVybjsgfVxuICAgIHJldHJ5U2NoZWR1bGVkID0gdHJ1ZTtcbiAgICBzZXRUaW1lb3V0KHByb2Nlc3NSZXRyeVF1ZXVlLCBSRVRSWV9ERUxBWV9NUyk7XG59O1xuXG5jb25zdCBwcm9jZXNzUmV0cnlRdWV1ZSA9ICgpID0+IHtcbiAgICByZXRyeVNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgLy8gU2tpcCByZXRyaWVzIGlmIG9mZmxpbmVcbiAgICBpZiAoIWlzT25saW5lKCkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZz8uKFwiW2ljb24tbG9hZGVyXSBTa2lwcGluZyByZXRyaWVzIC0gZGV2aWNlIGlzIG9mZmxpbmVcIik7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQ2xlYXIgcXVldWUgdG8gcHJldmVudCBhY2N1bXVsYXRpb25cbiAgICAgICAgcmV0cnlRdWV1ZS5sZW5ndGggPSAwO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgYmF0Y2ggPSByZXRyeVF1ZXVlLnNwbGljZSgwLCBNYXRoLm1pbigyLCByZXRyeVF1ZXVlLmxlbmd0aCkpOyAvLyBFdmVuIHNtYWxsZXIgYmF0Y2hlc1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBiYXRjaCkge1xuICAgICAgICAvLyBBZGQgcHJvZ3Jlc3NpdmUgZGVsYXkgZm9yIHJldHJpZXNcbiAgICAgICAgY29uc3QgZGVsYXkgPSBSRVRSWV9ERUxBWV9NUyAqIE1hdGgucG93KDEuNSwgaXRlbS5yZXRyaWVzIC0gMSk7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgbG9hZEFzSW1hZ2VJbnRlcm5hbChpdGVtLm5hbWUsIGl0ZW0uY3JlYXRvciwgaXRlbS5yZXRyaWVzKVxuICAgICAgICAgICAgICAgIC50aGVuKGl0ZW0ucmVzb2x2ZSlcbiAgICAgICAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEVuaGFuY2VkIGVycm9yIGxvZ2dpbmcgZm9yIGRlYnVnZ2luZ1xuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUud2Fybj8uKGBbaWNvbi1sb2FkZXJdIFJldHJ5ICR7aXRlbS5yZXRyaWVzfS8ke01BWF9SRVRSSUVTfSBmYWlsZWQgZm9yICR7aXRlbS5uYW1lfTpgLCBlcnJvcj8ubWVzc2FnZSB8fCBlcnJvcik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaXRlbS5yZWplY3QoZXJyb3IpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9LCBkZWxheSk7XG4gICAgfVxuXG4gICAgLy8gU2NoZWR1bGUgbmV4dCBiYXRjaCB3aXRoIGxvbmdlciBkZWxheSBpZiB3ZSBoYXZlIG1vcmUgaXRlbXNcbiAgICBpZiAocmV0cnlRdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IG5leHREZWxheSA9IGlzU2xvd0Nvbm5lY3Rpb24oKSA/IFJFVFJZX0RFTEFZX01TICogMiA6IFJFVFJZX0RFTEFZX01TO1xuICAgICAgICBzZXRUaW1lb3V0KHByb2Nlc3NSZXRyeVF1ZXVlLCBuZXh0RGVsYXkpO1xuICAgIH1cbn07XG5cbmNvbnN0IHdpdGhUaW1lb3V0ID0gPFQ+KHByb21pc2U6IFByb21pc2U8VD4sIG1zOiBudW1iZXIpOiBQcm9taXNlPFQ+ID0+IHtcbiAgICBsZXQgdGltZW91dElkOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PjtcbiAgICBjb25zdCB0aW1lb3V0UHJvbWlzZSA9IG5ldyBQcm9taXNlPG5ldmVyPigoXywgcmVqZWN0KSA9PiB7XG4gICAgICAgIHRpbWVvdXRJZCA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcIlRpbWVvdXRcIikpLCBtcyk7XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UucmFjZShbcHJvbWlzZSwgdGltZW91dFByb21pc2VdKS5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lb3V0SWQpKTtcbn07XG5cbmV4cG9ydCB0eXBlIERldmljZVBpeGVsU2l6ZSA9IHsgaW5saW5lOiBudW1iZXI7IGJsb2NrOiBudW1iZXIgfTtcblxuY29uc3QgZ2xvYmFsU2NvcGUgPSB0eXBlb2YgZ2xvYmFsVGhpcyAhPT0gXCJ1bmRlZmluZWRcIiA/IChnbG9iYWxUaGlzIGFzIHsgbG9jYXRpb24/OiBMb2NhdGlvbiB9KSA6IHt9O1xuY29uc3QgaGFzQ2hyb21lUnVudGltZSA9ICgpOiBib29sZWFuID0+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBjaHJvbWVSdW50aW1lID0gKGdsb2JhbFRoaXMgYXMgYW55KT8uY2hyb21lPy5ydW50aW1lO1xuICAgICAgICByZXR1cm4gISFjaHJvbWVSdW50aW1lPy5pZDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn07XG5cbmNvbnN0IHBpY2tCYXNlVXJsID0gKCk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBkb2N1bWVudCAhPT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2YgZG9jdW1lbnQuYmFzZVVSSSA9PT0gXCJzdHJpbmdcIiAmJiBkb2N1bWVudC5iYXNlVVJJICE9PSBcImFib3V0OmJsYW5rXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBkb2N1bWVudC5iYXNlVVJJO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vb3AgKi9cbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCB7IGxvY2F0aW9uIH0gPSBnbG9iYWxTY29wZTtcbiAgICAgICAgaWYgKGxvY2F0aW9uPy5ocmVmICYmIGxvY2F0aW9uLmhyZWYgIT09IFwiYWJvdXQ6YmxhbmtcIikge1xuICAgICAgICAgICAgcmV0dXJuIGxvY2F0aW9uLmhyZWY7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGxvY2F0aW9uPy5vcmlnaW4pIHtcbiAgICAgICAgICAgIHJldHVybiBsb2NhdGlvbi5vcmlnaW47XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm9vcCAqL1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufTtcblxuY29uc3QgREVGQVVMVF9CQVNFX1VSTCA9IHBpY2tCYXNlVXJsKCk7XG5cbmV4cG9ydCBjb25zdCBmYWxsYmFja01hc2tWYWx1ZSA9ICh1cmw6IHN0cmluZykgPT4gKCF1cmwgPyBcIm5vbmVcIiA6IGB1cmwoXCIke3VybH1cIilgKTtcblxuZXhwb3J0IGNvbnN0IHJlc29sdmVBc3NldFVybCA9IChpbnB1dDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBpZiAoIWlucHV0IHx8IHR5cGVvZiBpbnB1dCAhPT0gXCJzdHJpbmdcIikgeyByZXR1cm4gXCJcIjsgfVxuICAgIGNvbnN0IGNhY2hlZCA9IHJlc29sdmVkVXJsQ2FjaGUuZ2V0KGlucHV0KTtcbiAgICBpZiAoY2FjaGVkKSB7IHJldHVybiBjYWNoZWQ7IH1cblxuICAgIGxldCByZXNvbHZlZCA9IGlucHV0O1xuICAgIGlmICh0eXBlb2YgVVJMID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJlc29sdmVkID0gREVGQVVMVF9CQVNFX1VSTCA/IG5ldyBVUkwoaW5wdXQsIERFRkFVTFRfQkFTRV9VUkwpLmhyZWYgOiBuZXcgVVJMKGlucHV0KS5ocmVmO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZWQgPSBuZXcgVVJMKGlucHV0LCBnbG9iYWxTY29wZS5sb2NhdGlvbj8ub3JpZ2luID8/IHVuZGVmaW5lZCkuaHJlZjtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHJlc29sdmVkID0gaW5wdXQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXNvbHZlZFVybENhY2hlLnNldChpbnB1dCwgcmVzb2x2ZWQpO1xuICAgIGlmICghcmVzb2x2ZWRVcmxDYWNoZS5oYXMocmVzb2x2ZWQpKSB7XG4gICAgICAgIHJlc29sdmVkVXJsQ2FjaGUuc2V0KHJlc29sdmVkLCByZXNvbHZlZCk7XG4gICAgfVxuICAgIHJldHVybiByZXNvbHZlZDtcbn07XG5cbi8vIEluLWZsaWdodCBwcm9taXNlIHRyYWNraW5nIHRvIHByZXZlbnQgZHVwbGljYXRlIGxvYWRzXG5jb25zdCBpbmZsaWdodFByb21pc2VzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8c3RyaW5nPj4oKTtcblxuY29uc3QgaXNTYWZlQ3NzTWFza1VybCA9ICh1cmw6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xuICAgIGlmICghdXJsIHx8IHR5cGVvZiB1cmwgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCB0cmltbWVkID0gdXJsLnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBmYWxzZTtcbiAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiZGF0YTpcIikgfHwgdHJpbW1lZC5zdGFydHNXaXRoKFwiYmxvYjpcIikpIHJldHVybiB0cnVlO1xuXG4gICAgLy8gQWxsb3cgcmVsYXRpdmUgYW5kIHJvb3QtcmVsYXRpdmUgcGF0aHMgKHNhbWUtb3JpZ2luKS5cbiAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiL1wiKSB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCIuL1wiKSB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCIuLi9cIikpIHJldHVybiB0cnVlO1xuXG4gICAgLy8gRm9yIGFic29sdXRlIFVSTHMsIG9ubHkgYWxsb3cgc2FtZS1vcmlnaW4gdG8gYXZvaWQgQ1NTIGNyb3NzLW9yaWdpbiBmZXRjaCArIGNyZWRlbnRpYWxzIGlzc3Vlcy5cbiAgICBpZiAodHlwZW9mIFVSTCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBiYXNlID0gZ2xvYmFsU2NvcGUubG9jYXRpb24/Lm9yaWdpbiA/PyBERUZBVUxUX0JBU0VfVVJMO1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTCh0cmltbWVkLCBiYXNlKTtcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbiA9IGdsb2JhbFNjb3BlLmxvY2F0aW9uPy5vcmlnaW47XG4gICAgICAgICAgICBpZiAob3JpZ2luICYmIHBhcnNlZC5vcmlnaW4gPT09IG9yaWdpbikgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xufTtcblxuLyoqXG4gKiBHZW5lcmF0ZXMgY2FjaGUga2V5IGZvciBpY29uIGxvb2t1cFxuICovXG5jb25zdCBtYWtlQ2FjaGVLZXkgPSAoY2FjaGVLZXk6IHN0cmluZyB8IHVuZGVmaW5lZCwgbm9ybWFsaXplZFVybDogc3RyaW5nLCBidWNrZXQ6IG51bWJlcik6IHN0cmluZyA9PiB7XG4gICAgY29uc3Qgc2FuaXRpemVkS2V5ID0gKGNhY2hlS2V5ID8/IFwiXCIpLnRyaW0oKTtcbiAgICByZXR1cm4gc2FuaXRpemVkS2V5ID8gYCR7c2FuaXRpemVkS2V5fUAke2J1Y2tldH1gIDogYCR7bm9ybWFsaXplZFVybH1AJHtidWNrZXR9YDtcbn07XG5cbmV4cG9ydCBjb25zdCBxdWFudGl6ZVRvQnVja2V0ID0gKHZhbHVlOiBudW1iZXIpOiBudW1iZXIgPT4ge1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7IHZhbHVlID0gTUlOX1JBU1RFUl9TSVpFOyB9XG4gICAgY29uc3Qgc2FmZSA9IE1hdGgubWF4KHZhbHVlLCBNSU5fUkFTVEVSX1NJWkUpO1xuICAgIGNvbnN0IGJ1Y2tldCA9IDIgKiogTWF0aC5jZWlsKE1hdGgubG9nMihzYWZlKSk7XG4gICAgcmV0dXJuIE1hdGgubWluKE1BWF9SQVNURVJfU0laRSwgYnVja2V0KTtcbn07XG5cbmV4cG9ydCBjb25zdCBsb2FkSW1hZ2VFbGVtZW50ID0gKHVybDogc3RyaW5nKTogUHJvbWlzZTxIVE1MSW1hZ2VFbGVtZW50PiA9PiB7XG4gICAgY29uc3QgcmVzb2x2ZWRVcmwgPSByZXNvbHZlQXNzZXRVcmwodXJsKTtcbiAgICBpZiAoIXJlc29sdmVkVXJsKSB7IHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoXCJJbnZhbGlkIGljb24gVVJMXCIpKTsgfVxuICAgIGlmICghaW1hZ2VFbGVtZW50Q2FjaGUuaGFzKHJlc29sdmVkVXJsKSkge1xuICAgICAgICBjb25zdCBwcm9taXNlID0gKGFzeW5jICgpOiBQcm9taXNlPEhUTUxJbWFnZUVsZW1lbnQ+ID0+IHtcbiAgICAgICAgICAgIC8vIFRyeSBPUEZTIGNhY2hlIGZpcnN0IGZvciBibG9iIFVSTFxuICAgICAgICAgICAgbGV0IGVmZmVjdGl2ZVVybCA9IHJlc29sdmVkVXJsO1xuICAgICAgICAgICAgaWYgKGlzT1BGU1N1cHBvcnRlZCgpKSB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FjaGVkVXJsID0gYXdhaXQgZ2V0Q2FjaGVkVmVjdG9ySWNvbihyZXNvbHZlZFVybCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWNoZWRVcmwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVmZmVjdGl2ZVVybCA9IGNhY2hlZFVybDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAvKiBjYWNoZSBtaXNzICovXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gbmV3IFByb21pc2U8SFRNTEltYWdlRWxlbWVudD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGltZyA9IG5ldyBJbWFnZSgpO1xuICAgICAgICAgICAgICAgIGxldCBzZXR0bGVkID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAvLyBUaW1lb3V0IGZvciBpbWFnZSBsb2FkaW5nIHRvIHByZXZlbnQgc3R1Y2sgcHJlbG9hZGluZ1xuICAgICAgICAgICAgICAgIGNvbnN0IHRpbWVvdXRJZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXNldHRsZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgaW1nLm9ubG9hZCA9IGltZy5vbmVycm9yID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVvdXQgbG9hZGluZyBpY29uOiAke3VybH1gKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LCBGRVRDSF9USU1FT1VUX01TKTtcblxuICAgICAgICAgICAgICAgIC8vIENvbmZpZ3VyZSBpbWFnZSBwcm9wZXJ0aWVzXG4gICAgICAgICAgICAgICAgdHJ5IHsgaW1nLmRlY29kaW5nID0gXCJhc3luY1wiOyB9IGNhdGNoIChfKSB7IC8qIG5vb3AgKi8gfVxuICAgICAgICAgICAgICAgIHRyeSB7IGltZy5jcm9zc09yaWdpbiA9IFwiYW5vbnltb3VzXCI7IH0gY2F0Y2ggKF8pIHsgLyogbm9vcCAqLyB9XG5cbiAgICAgICAgICAgICAgICAvLyBQcmV2ZW50IGltYWdlIGZyb20gYmVpbmcgZGlzcGxheWVkIGlmIGl0IGFjY2lkZW50YWxseSBnZXRzIGFkZGVkIHRvIERPTVxuICAgICAgICAgICAgICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgICAgICAgICAgIGltZy5zdHlsZS5wb3NpdGlvbiA9ICdhYnNvbHV0ZSc7XG4gICAgICAgICAgICAgICAgaW1nLnN0eWxlLnZpc2liaWxpdHkgPSAnaGlkZGVuJztcblxuICAgICAgICAgICAgICAgIGltZy5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzZXR0bGVkKSB7IHJldHVybjsgfVxuICAgICAgICAgICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXRJZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gVmFsaWRhdGUgbG9hZGVkIGltYWdlXG4gICAgICAgICAgICAgICAgICAgIGlmIChpbWcubmF0dXJhbFdpZHRoID09PSAwIHx8IGltZy5uYXR1cmFsSGVpZ2h0ID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBJbnZhbGlkIGltYWdlIGRpbWVuc2lvbnMgZm9yOiAke3VybH1gKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXNvbHZlKGltZyk7XG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGltZy5vbmVycm9yID0gKF9ldmVudCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc2V0dGxlZCkgeyByZXR1cm47IH1cbiAgICAgICAgICAgICAgICAgICAgc2V0dGxlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SWQpO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIElmIGNhY2hlZCBVUkwgZmFpbGVkLCB0cnkgb3JpZ2luYWwgVVJMXG4gICAgICAgICAgICAgICAgICAgIGlmIChlZmZlY3RpdmVVcmwgIT09IHJlc29sdmVkVXJsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXRyeUltZyA9IG5ldyBJbWFnZSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcmV0cnlJbWcuZGVjb2RpbmcgPSBcImFzeW5jXCI7IH0gY2F0Y2ggKF8pIHsgLyogbm9vcCAqLyB9XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyByZXRyeUltZy5jcm9zc09yaWdpbiA9IFwiYW5vbnltb3VzXCI7IH0gY2F0Y2ggKF8pIHsgLyogbm9vcCAqLyB9XG4gICAgICAgICAgICAgICAgICAgICAgICByZXRyeUltZy5zdHlsZS5kaXNwbGF5ID0gcmV0cnlJbWcuc3R5bGUucG9zaXRpb24gPSByZXRyeUltZy5zdHlsZS52aXNpYmlsaXR5ID0gJ25vbmUnO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXRyeUltZy5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJldHJ5SW1nLm5hdHVyYWxXaWR0aCA9PT0gMCB8fCByZXRyeUltZy5uYXR1cmFsSGVpZ2h0ID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYEludmFsaWQgcmV0cnkgaW1hZ2UgZGltZW5zaW9ucyBmb3I6ICR7dXJsfWApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXNvbHZlKHJldHJ5SW1nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICByZXRyeUltZy5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgaWNvbjogJHt1cmx9YCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0cnlJbWcuc3JjID0gcmVzb2x2ZWRVcmw7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgaWNvbjogJHt1cmx9YCkpO1xuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpbWcuc3JjID0gZWZmZWN0aXZlVXJsO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pKCkudGhlbihhc3luYyAoaW1nKSA9PiB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGltZy5kZWNvZGUgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgICAgIHRyeSB7IGF3YWl0IGltZy5kZWNvZGUoKTsgfSBjYXRjaCAoXykgeyAvKiBpZ25vcmUgZGVjb2RlIGVycm9ycyAqLyB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIENhY2hlIFNWRyB0byBPUEZTIGlmIGxvYWRlZCBmcm9tIG5ldHdvcmtcbiAgICAgICAgICAgIGlmIChpc09QRlNTdXBwb3J0ZWQoKSAmJiBpbWcuc3JjID09PSByZXNvbHZlZFVybCkge1xuICAgICAgICAgICAgICAgIC8vIEZldGNoIGFuZCBjYWNoZSBpbiBiYWNrZ3JvdW5kXG4gICAgICAgICAgICAgICAgZmV0Y2gocmVzb2x2ZWRVcmwpXG4gICAgICAgICAgICAgICAgICAgIC50aGVuKHIgPT4gci5ibG9iKCkpXG4gICAgICAgICAgICAgICAgICAgIC50aGVuKGJsb2IgPT4gY2FjaGVWZWN0b3JJY29uKHJlc29sdmVkVXJsLCBibG9iKSlcbiAgICAgICAgICAgICAgICAgICAgLmNhdGNoKCgpID0+IHsgLyogc2lsZW50ICovIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gaW1nO1xuICAgICAgICB9KS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIC8vIFJlbW92ZSBmcm9tIGNhY2hlIG9uIGZhaWx1cmUgdG8gYWxsb3cgcmV0cnlcbiAgICAgICAgICAgIGltYWdlRWxlbWVudENhY2hlLmRlbGV0ZShyZXNvbHZlZFVybCk7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSk7XG4gICAgICAgIGltYWdlRWxlbWVudENhY2hlLnNldChyZXNvbHZlZFVybCwgcHJvbWlzZSk7XG4gICAgfVxuICAgIHJldHVybiBpbWFnZUVsZW1lbnRDYWNoZS5nZXQocmVzb2x2ZWRVcmwpITtcbn07XG5cbmV4cG9ydCBjb25zdCBjcmVhdGVDYW52YXMgPSAoc2l6ZTogbnVtYmVyKTogT2Zmc2NyZWVuQ2FudmFzIHwgSFRNTENhbnZhc0VsZW1lbnQgPT4ge1xuICAgIGNvbnN0IGRpbWVuc2lvbiA9IE1hdGgubWF4KHNpemUsIE1JTl9SQVNURVJfU0laRSk7XG4gICAgaWYgKHR5cGVvZiBPZmZzY3JlZW5DYW52YXMgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBPZmZzY3JlZW5DYW52YXMoZGltZW5zaW9uLCBkaW1lbnNpb24pO1xuICAgIH1cbiAgICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY2FudmFzXCIpO1xuICAgIGNhbnZhcy53aWR0aCA9IGRpbWVuc2lvbjtcbiAgICBjYW52YXMuaGVpZ2h0ID0gZGltZW5zaW9uO1xuICAgIHJldHVybiBjYW52YXM7XG59O1xuXG5leHBvcnQgY29uc3QgY2FudmFzVG9JbWFnZVVybCA9IGFzeW5jIChjYW52YXM6IE9mZnNjcmVlbkNhbnZhcyB8IEhUTUxDYW52YXNFbGVtZW50KTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBpZiAoXCJjb252ZXJ0VG9CbG9iXCIgaW4gY2FudmFzKSB7XG4gICAgICAgIGNvbnN0IGJsb2IgPSBhd2FpdCAoY2FudmFzIGFzIE9mZnNjcmVlbkNhbnZhcykuY29udmVydFRvQmxvYih7IHR5cGU6IFwiaW1hZ2UvcG5nXCIgfSk7XG4gICAgICAgIHJldHVybiBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpO1xuICAgIH1cbiAgICBjb25zdCBodG1sQ2FudmFzID0gY2FudmFzIGFzIEhUTUxDYW52YXNFbGVtZW50O1xuICAgIGlmICh0eXBlb2YgaHRtbENhbnZhcy50b0Jsb2IgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICBjb25zdCBibG9iID0gYXdhaXQgbmV3IFByb21pc2U8QmxvYj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgaHRtbENhbnZhcy50b0Jsb2IoKGJsb2JWYWx1ZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChibG9iVmFsdWUpIHsgcmVzb2x2ZShibG9iVmFsdWUpOyB9XG4gICAgICAgICAgICAgICAgZWxzZSB7IHJlamVjdChuZXcgRXJyb3IoXCJDYW52YXMgdG9CbG9iIHJldHVybmVkIG51bGxcIikpOyB9XG4gICAgICAgICAgICB9LCBcImltYWdlL3BuZ1wiKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpO1xuICAgIH1cbiAgICByZXR1cm4gaHRtbENhbnZhcy50b0RhdGFVUkwoXCJpbWFnZS9wbmdcIik7XG59O1xuXG4vKipcbiAqIENvbnZlcnRzIGNhbnZhcyB0byBibG9iIGZvciBPUEZTIGNhY2hpbmdcbiAqL1xuY29uc3QgY2FudmFzVG9CbG9iID0gYXN5bmMgKGNhbnZhczogT2Zmc2NyZWVuQ2FudmFzIHwgSFRNTENhbnZhc0VsZW1lbnQpOiBQcm9taXNlPEJsb2IgfCBudWxsPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKFwiY29udmVydFRvQmxvYlwiIGluIGNhbnZhcykge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChjYW52YXMgYXMgT2Zmc2NyZWVuQ2FudmFzKS5jb252ZXJ0VG9CbG9iKHsgdHlwZTogXCJpbWFnZS9wbmdcIiB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBodG1sQ2FudmFzID0gY2FudmFzIGFzIEhUTUxDYW52YXNFbGVtZW50O1xuICAgICAgICBpZiAodHlwZW9mIGh0bWxDYW52YXMudG9CbG9iID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxCbG9iIHwgbnVsbD4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgICAgICBodG1sQ2FudmFzLnRvQmxvYigoYmxvYikgPT4gcmVzb2x2ZShibG9iKSwgXCJpbWFnZS9wbmdcIik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBub29wICovXG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufTtcblxuZXhwb3J0IGNvbnN0IHJhc3Rlcml6ZVN2Z1RvTWFzayA9IGFzeW5jICh1cmw6IHN0cmluZywgYnVja2V0OiBudW1iZXIsIGNhY2hlS2V5Pzogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBzaXplID0gTWF0aC5tYXgoYnVja2V0LCBNSU5fUkFTVEVSX1NJWkUpO1xuICAgIGNvbnN0IG9wZnNDYWNoZUtleSA9IGNhY2hlS2V5IHx8IHVybDtcblxuICAgIC8vIENoZWNrIE9QRlMgY2FjaGUgZmlyc3QgZm9yIHJhc3RlciB2ZXJzaW9uXG4gICAgaWYgKGlzT1BGU1N1cHBvcnRlZCgpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZWRSYXN0ZXIgPSBhd2FpdCBnZXRDYWNoZWRSYXN0ZXJJY29uKG9wZnNDYWNoZUtleSwgc2l6ZSk7XG4gICAgICAgICAgICBpZiAoY2FjaGVkUmFzdGVyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbGxiYWNrTWFza1ZhbHVlKGNhY2hlZFJhc3Rlcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oJ1t1aS1pY29uXSBPUEZTIGNhY2hlIHJlYWQgZmFpbGVkOicsIGVycm9yKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGltZyA9IGF3YWl0IGxvYWRJbWFnZUVsZW1lbnQodXJsKTtcbiAgICBjb25zdCBjYW52YXMgPSBjcmVhdGVDYW52YXMoc2l6ZSk7XG4gICAgY29uc3QgY29udGV4dCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIiwge1xuICAgICAgICBhbHBoYTogdHJ1ZSxcbiAgICAgICAgZGVzeW5jaHJvbml6ZWQ6IHRydWUsXG4gICAgICAgIHdpbGxSZWFkRnJlcXVlbnRseTogZmFsc2VcbiAgICB9KSBhcyBDYW52YXNSZW5kZXJpbmdDb250ZXh0MkQ7XG5cbiAgICBpZiAoIWNvbnRleHQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5hYmxlIHRvIGFjcXVpcmUgMmQgY29udGV4dCBmb3IgcmFzdGVyaXphdGlvblwiKTtcbiAgICB9XG5cbiAgICAvLyBDb25maWd1cmUgY2FudmFzIGZvciBoaWdoLXF1YWxpdHkgcmVuZGVyaW5nXG4gICAgY29udGV4dC5jbGVhclJlY3QoMCwgMCwgc2l6ZSwgc2l6ZSk7XG4gICAgY29udGV4dC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSB0cnVlO1xuICAgIGNvbnRleHQuaW1hZ2VTbW9vdGhpbmdRdWFsaXR5ID0gJ2hpZ2gnO1xuICAgIGNvbnRleHQuZ2xvYmFsQ29tcG9zaXRlT3BlcmF0aW9uID0gJ3NvdXJjZS1vdmVyJztcblxuICAgIGNvbnN0IG5hdHVyYWxXaWR0aCA9IGltZy5uYXR1cmFsV2lkdGggfHwgaW1nLndpZHRoIHx8IHNpemU7XG4gICAgY29uc3QgbmF0dXJhbEhlaWdodCA9IGltZy5uYXR1cmFsSGVpZ2h0IHx8IGltZy5oZWlnaHQgfHwgc2l6ZTtcblxuICAgIC8vIEVuc3VyZSB3ZSBoYXZlIHZhbGlkIGRpbWVuc2lvbnNcbiAgICBjb25zdCBzYWZlV2lkdGggPSBNYXRoLm1heCgxLCBuYXR1cmFsV2lkdGgpO1xuICAgIGNvbnN0IHNhZmVIZWlnaHQgPSBNYXRoLm1heCgxLCBuYXR1cmFsSGVpZ2h0KTtcblxuICAgIC8vIENhbGN1bGF0ZSBzY2FsZSB0byBmaXQgd2l0aGluIGNhbnZhcyB3aGlsZSBtYWludGFpbmluZyBhc3BlY3QgcmF0aW9cbiAgICBjb25zdCBzY2FsZSA9IE1hdGgubWluKHNpemUgLyBzYWZlV2lkdGgsIHNpemUgLyBzYWZlSGVpZ2h0KTtcbiAgICBjb25zdCBkcmF3V2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHNhZmVXaWR0aCAqIHNjYWxlKSk7XG4gICAgY29uc3QgZHJhd0hlaWdodCA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3Ioc2FmZUhlaWdodCAqIHNjYWxlKSk7XG5cbiAgICAvLyBDZW50ZXIgdGhlIGltYWdlIG9uIHRoZSBjYW52YXNcbiAgICBjb25zdCBvZmZzZXRYID0gTWF0aC5mbG9vcigoc2l6ZSAtIGRyYXdXaWR0aCkgLyAyKTtcbiAgICBjb25zdCBvZmZzZXRZID0gTWF0aC5mbG9vcigoc2l6ZSAtIGRyYXdIZWlnaHQpIC8gMik7XG5cbiAgICAvLyBDbGVhciBjYW52YXMgd2l0aCB0cmFuc3BhcmVudCBiYWNrZ3JvdW5kXG4gICAgY29udGV4dC5jbGVhclJlY3QoMCwgMCwgc2l6ZSwgc2l6ZSk7XG5cbiAgICAvLyBEcmF3IHRoZSBpbWFnZSB3aXRoIHByb3BlciBzY2FsaW5nIGFuZCBlcnJvciBoYW5kbGluZ1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnRleHQuZHJhd0ltYWdlKGltZywgb2Zmc2V0WCwgb2Zmc2V0WSwgZHJhd1dpZHRoLCBkcmF3SGVpZ2h0KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLndhcm4oJ1t1aS1pY29uXSBGYWlsZWQgdG8gZHJhdyBpbWFnZSBvbiBjYW52YXM6JywgZXJyb3IpO1xuICAgICAgICAvLyBGYWxsYmFjazogY3JlYXRlIGEgc2ltcGxlIGNvbG9yZWQgcmVjdGFuZ2xlIGFzIHBsYWNlaG9sZGVyXG4gICAgICAgIGNvbnRleHQuZmlsbFN0eWxlID0gJ3JnYmEoMTI4LCAxMjgsIDEyOCwgMC41KSc7XG4gICAgICAgIGNvbnRleHQuZmlsbFJlY3Qob2Zmc2V0WCwgb2Zmc2V0WSwgZHJhd1dpZHRoLCBkcmF3SGVpZ2h0KTtcbiAgICB9XG5cbiAgICAvLyBDYWNoZSByYXN0ZXIgdG8gT1BGUyBpbiBiYWNrZ3JvdW5kIHdpdGggZXJyb3IgaGFuZGxpbmdcbiAgICBpZiAoaXNPUEZTU3VwcG9ydGVkKCkpIHtcbiAgICAgICAgY2FudmFzVG9CbG9iKGNhbnZhcykudGhlbigoYmxvYikgPT4ge1xuICAgICAgICAgICAgaWYgKGJsb2IgJiYgYmxvYi5zaXplID4gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZVJhc3Rlckljb24ob3Bmc0NhY2hlS2V5LCBzaXplLCBibG9iKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oJ1t1aS1pY29uXSBPUEZTIGNhY2hlIHdyaXRlIGZhaWxlZDonLCBlcnJvcik7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHJhc3RlclVybCA9IGF3YWl0IGNhbnZhc1RvSW1hZ2VVcmwoY2FudmFzKTtcbiAgICByZXR1cm4gZmFsbGJhY2tNYXNrVmFsdWUocmFzdGVyVXJsKTtcbn07XG5cbi8qKlxuICogRW5zdXJlcyBhIG1hc2sgdmFsdWUgaXMgYXZhaWxhYmxlIGZvciBhbiBpY29uLlxuICogVXNlcyBDU1MgcmVnaXN0cnkgZm9yIGNhY2hpbmcgLSB0aGUgcmVzdWx0IGlzIHJlZ2lzdGVyZWQgYXMgYSBDU1MgcnVsZVxuICogd2l0aCBhdHRyaWJ1dGUgc2VsZWN0b3JzLCBzbyB0aGUgYnJvd3NlciBoYW5kbGVzIGNhY2hpbmcuXG4gKi9cbmV4cG9ydCBjb25zdCBlbnN1cmVNYXNrVmFsdWUgPSAodXJsOiBzdHJpbmcsIGNhY2hlS2V5OiBzdHJpbmcgfCB1bmRlZmluZWQsIGJ1Y2tldDogbnVtYmVyKTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBzYWZlVXJsID0gdHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIiA/IHVybCA6IFwiXCI7XG4gICAgY29uc3Qgbm9ybWFsaXplZFVybCA9IHJlc29sdmVBc3NldFVybChzYWZlVXJsKTtcbiAgICBjb25zdCBlZmZlY3RpdmVVcmwgPSBub3JtYWxpemVkVXJsIHx8IHNhZmVVcmw7XG4gICAgY29uc3Qga2V5ID0gbWFrZUNhY2hlS2V5KGNhY2hlS2V5LCBub3JtYWxpemVkVXJsLCBidWNrZXQpO1xuXG4gICAgaWYgKCFlZmZlY3RpdmVVcmwpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxsYmFja01hc2tWYWx1ZShcIlwiKSk7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgYWxyZWFkeSBpbi1mbGlnaHRcbiAgICBjb25zdCBpbmZsaWdodCA9IGluZmxpZ2h0UHJvbWlzZXMuZ2V0KGtleSk7XG4gICAgaWYgKGluZmxpZ2h0KSB7IHJldHVybiBpbmZsaWdodDsgfVxuXG4gICAgY29uc3QgcHJvbWlzZSA9IGxvYWRBc0ltYWdlKGVmZmVjdGl2ZVVybCwgLypidWNrZXQsIGNhY2hlS2V5Ki8pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmIChlZmZlY3RpdmVVcmwgJiYgdHlwZW9mIGNvbnNvbGUgIT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4/LihcIlt1aS1pY29uXSBNYXNrIGdlbmVyYXRpb24gZmFpbGVkOyByZWZ1c2luZyB0byB1c2UgY3Jvc3Mtb3JpZ2luIENTUyB1cmwoKSBmYWxsYmFja1wiLCBlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBJTVBPUlRBTlQ6XG4gICAgICAgICAgICAvLyBEbyBub3QgZmFsbCBiYWNrIHRvIGB1cmwoXCJodHRwczovLy4uLlwiKWAgZm9yIGNyb3NzLW9yaWdpbiBDRE5zLCBiZWNhdXNlIENTUyBmZXRjaGVzIHVzZVxuICAgICAgICAgICAgLy8gY3JlZGVudGlhbHM9aW5jbHVkZSBhbmQgbWFueSBDRE5zIHJlc3BvbmQgd2l0aCBBQ0FPPVwiKlwiLCB3aGljaCBpcyBibG9ja2VkIGluIHRoYXQgbW9kZS5cbiAgICAgICAgICAgIHJldHVybiBmYWxsYmFja01hc2tWYWx1ZShpc1NhZmVDc3NNYXNrVXJsKGVmZmVjdGl2ZVVybCkgPyBlZmZlY3RpdmVVcmwgOiBcIlwiKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgICAgaW5mbGlnaHRQcm9taXNlcy5kZWxldGUoa2V5KTtcbiAgICAgICAgfSk7XG5cbiAgICBpbmZsaWdodFByb21pc2VzLnNldChrZXksIHByb21pc2UpO1xuICAgIHJldHVybiBwcm9taXNlO1xufTtcblxuZXhwb3J0IGNvbnN0IGNhbWVsVG9LZWJhYiA9IChjYW1lbDogc3RyaW5nKSA9PiB7XG4gICAgaWYgKHR5cGVvZiBjYW1lbCAhPT0gXCJzdHJpbmdcIikgeyByZXR1cm4gXCJcIjsgfVxuICAgIHJldHVybiBjYW1lbFxuICAgICAgICAucmVwbGFjZSgvW19cXHNdKy9nLCBcIi1cIilcbiAgICAgICAgLnJlcGxhY2UoLyhbYS16MC05XSkoW0EtWl0pL2csIFwiJDEtJDJcIilcbiAgICAgICAgLnJlcGxhY2UoLyhbQS1aXSkoW0EtWl1bYS16XSkvZywgXCIkMS0kMlwiKVxuICAgICAgICAudG9Mb3dlckNhc2UoKTtcbn07XG5cbi8qKlxuICogQ3JlYXRlcyBhbiBpbWFnZS1zZXQgQ1NTIHZhbHVlIGZvciByZXNvbHV0aW9uLWF3YXJlIGljb25zLlxuICogVXNlZCBieSB0aGUgQ1NTIHJlZ2lzdHJ5IGZvciBnZW5lcmF0aW5nIHJ1bGVzLlxuICovXG5leHBvcnQgY29uc3QgY3JlYXRlSW1hZ2VTZXRWYWx1ZSA9ICh1cmw6IHN0cmluZywgcmVzb2x1dGlvbnM6IEFycmF5PHsgc2NhbGU6IG51bWJlcjsgc2l6ZTogbnVtYmVyIH0+ID0gW10pOiBzdHJpbmcgPT4ge1xuICAgIGlmICghdXJsKSB7IHJldHVybiBcImxpbmVhci1ncmFkaWVudCgjMDAwMCwgIzAwMDApXCI7IH1cblxuICAgIGNvbnN0IGJhc2VTZXQgPSBbYHVybChcIiR7dXJsfVwiKSAxeGBdO1xuXG4gICAgZm9yIChjb25zdCB7IHNjYWxlIH0gb2YgcmVzb2x1dGlvbnMpIHtcbiAgICAgICAgaWYgKHNjYWxlID4gMSkge1xuICAgICAgICAgICAgYmFzZVNldC5wdXNoKGB1cmwoXCIke3VybH1cIikgJHtzY2FsZX14YCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gYGltYWdlLXNldCgke2Jhc2VTZXQuam9pbihcIiwgXCIpfSlgO1xufTtcblxuLyoqXG4gKiBSZWdpc3RlcnMgYW4gaWNvbiBpbiB0aGUgQ1NTIHJlZ2lzdHJ5LlxuICogVGhpcyBnZW5lcmF0ZXMgYSBDU1MgcnVsZSB3aXRoIGF0dHJpYnV0ZSBzZWxlY3RvcnMgYW5kIGltYWdlLXNldC5cbiAqXG4gKiBAcGFyYW0gaWNvbk5hbWUgLSBUaGUgaWNvbiBuYW1lIChlLmcuLCBcImhvdXNlXCIsIFwiYXJyb3ctcmlnaHRcIilcbiAqIEBwYXJhbSBpY29uU3R5bGUgLSBUaGUgaWNvbiBzdHlsZSAoZS5nLiwgXCJkdW90b25lXCIsIFwiZmlsbFwiKVxuICogQHBhcmFtIHVybCAtIFRoZSByZXNvbHZlZCBpY29uIFVSTFxuICogQHBhcmFtIGJ1Y2tldCAtIFRoZSBzaXplIGJ1Y2tldCBmb3IgdGhlIGljb25cbiAqL1xuZXhwb3J0IGNvbnN0IGdlbmVyYXRlSWNvbkltYWdlVmFyaWFibGUgPSAoXG4gICAgaWNvbk5hbWU6IHN0cmluZyxcbiAgICB1cmw6IHN0cmluZyxcbiAgICBidWNrZXQ6IG51bWJlclxuKTogdm9pZCA9PiB7XG4gICAgLy8gUGFyc2UgaWNvbk5hbWUgdG8gZXh0cmFjdCB0aGUgc3R5bGUgaWYgaXQncyBpbiBcInN0eWxlOm5hbWVcIiBmb3JtYXRcbiAgICBjb25zdCBwYXJ0cyA9IGljb25OYW1lLnNwbGl0KFwiOlwiKTtcbiAgICBjb25zdCBbaWNvblN0eWxlLCBuYW1lXSA9IHBhcnRzLmxlbmd0aCA9PT0gMiA/IHBhcnRzIDogW1wiZHVvdG9uZVwiLCBpY29uTmFtZV07XG5cbiAgICAvLyBSZWdpc3RlciBpbiB0aGUgQ1NTIHN0eWxlc2hlZXQgdmlhIHJlZ2lzdHJ5XG4gICAgcmVnaXN0ZXJJY29uUnVsZShuYW1lLCBpY29uU3R5bGUsIHVybCwgYnVja2V0KTtcbn07XG5cbmV4cG9ydCBjb25zdCBpc1BhdGhVUkwgPSAodXJsOiB1bmtub3duKTogdXJsIGlzIHN0cmluZyA9PiB7XG4gICAgaWYgKHR5cGVvZiB1cmwgIT09IFwic3RyaW5nXCIgfHwgIXVybCkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICBpZiAodHlwZW9mIFVSTCA9PT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICByZXR1cm4gL14oW2Etel0rOik/XFwvXFwvL2kudGVzdCh1cmwpIHx8IHVybC5zdGFydHNXaXRoKFwiL1wiKSB8fCB1cmwuc3RhcnRzV2l0aChcIi4vXCIpIHx8IHVybC5zdGFydHNXaXRoKFwiLi4vXCIpO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgVVJMLmNhblBhcnNlID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChVUkwuY2FuUGFyc2UodXJsLCBERUZBVUxUX0JBU0VfVVJMKSkgeyByZXR1cm4gdHJ1ZTsgfVxuICAgICAgICAgICAgaWYgKGdsb2JhbFNjb3BlLmxvY2F0aW9uPy5vcmlnaW4gJiYgVVJMLmNhblBhcnNlKHVybCwgZ2xvYmFsU2NvcGUubG9jYXRpb24ub3JpZ2luKSkgeyByZXR1cm4gdHJ1ZTsgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8qIG5vb3AgKi9cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAgIG5ldyBVUkwodXJsLCBERUZBVUxUX0JBU0VfVVJMID8/IGdsb2JhbFNjb3BlLmxvY2F0aW9uPy5vcmlnaW4gPz8gdW5kZWZpbmVkKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG59O1xuZXhwb3J0IGNvbnN0IHJhc3Rlcml6ZVNWRyA9IChibG9iOiBCbG9iIHwgc3RyaW5nKT0+eyByZXR1cm4gaXNQYXRoVVJMKGJsb2IpID8gcmVzb2x2ZUFzc2V0VXJsKGJsb2IpIDogVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsgfVxuXG4vKipcbiAqIEZldGNoZXMgU1ZHIGNvbnRlbnQgd2l0aCBhIGhhcmQgdGltZW91dCBhbmQgYWJvcnQgc3VwcG9ydC5cbiAqIFRoaXMgcHJldmVudHMg4oCcZmV0Y2ggc3Rvcm1z4oCdIGZyb20gcGlsaW5nIHVwIGFuZCB0aW1pbmcgb3V0IGxhdGVyLlxuICovXG5jb25zdCBmZXRjaFN2Z0Jsb2IgPSBhc3luYyAodXJsOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTxCbG9iPiA9PiB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IHR5cGVvZiBBYm9ydENvbnRyb2xsZXIgIT09IFwidW5kZWZpbmVkXCIgPyBuZXcgQWJvcnRDb250cm9sbGVyKCkgOiBudWxsO1xuICAgIGNvbnN0IHRpbWVvdXRJZCA9IGNvbnRyb2xsZXIgPyBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgdGltZW91dE1zKSA6IG51bGw7XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgICAgICAgICAgY3JlZGVudGlhbHM6IFwib21pdFwiLFxuICAgICAgICAgICAgbW9kZTogXCJjb3JzXCIsXG4gICAgICAgICAgICBzaWduYWw6IGNvbnRyb2xsZXI/LnNpZ25hbCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfSAke3Jlc3BvbnNlLnN0YXR1c1RleHR9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBibG9iID0gYXdhaXQgcmVzcG9uc2UuYmxvYigpO1xuICAgICAgICBpZiAoIWJsb2IgfHwgYmxvYi5zaXplID09PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJFbXB0eSBTVkcgcmVzcG9uc2VcIik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGJsb2I7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiBlLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaW1lb3V0XCIpO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGU7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHRpbWVvdXRJZCkgeyBjbGVhclRpbWVvdXQodGltZW91dElkKTsgfVxuICAgIH1cbn07XG5cbmNvbnN0IHRyeUxvYWRGcm9tVmVjdG9yQ2FjaGUgPSBhc3luYyAoY2Fub25pY2FsVXJsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+ID0+IHtcbiAgICBpZiAoIWNhbm9uaWNhbFVybCkgcmV0dXJuIG51bGw7XG4gICAgaWYgKCFpc09QRlNTdXBwb3J0ZWQoKSkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkVmVjdG9ySWNvbihjYW5vbmljYWxVcmwpO1xuICAgICAgICBpZiAoIWNhY2hlZCkgcmV0dXJuIG51bGw7XG5cbiAgICAgICAgY29uc3QgYmxvYiA9IGF3YWl0IGZldGNoU3ZnQmxvYihjYWNoZWQsIEZFVENIX1RJTUVPVVRfTVMpO1xuICAgICAgICBjb25zdCBzdmdUZXh0ID0gYXdhaXQgYmxvYi50ZXh0KCk7XG4gICAgICAgIGlmICghc3ZnVGV4dCB8fCBzdmdUZXh0LnRyaW0oKS5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gdG9TdmdEYXRhVXJsKHN2Z1RleHQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59O1xuXG4vKipcbiAqIEZhbGxiYWNrIGljb24gU1ZHICh1c2VkIHdoZW4gYWxsIGljb24gc291cmNlcyBmYWlsKS5cbiAqXG4gKiBOb3RlOiBUaGlzIGlzIHVzZWQgYXMgYSBDU1MgbWFzaywgc28gd2UgcHJlZmVyIHNvbGlkIGZpbGxlZCBzaGFwZXMgYW5kIGF2b2lkXG4gKiBvZGQgc2VsZi1pbnRlcnNlY3Rpb25zIHRoYXQgY2FuIGxvb2sgbGlrZSDigJxhcnRpZmFjdHPigJ0gYXQgc21hbGwgc2l6ZXMuXG4gKi9cbmNvbnN0IEZBTExCQUNLX1NWR19URVhUID0gYDxzdmcgd2lkdGg9XCIyNFwiIGhlaWdodD1cIjI0XCIgdmlld0JveD1cIjAgMCAyNCAyNFwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIj5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGZpbGwtcnVsZT1cImV2ZW5vZGRcIiBkPVwiTTYgMmE0IDQgMCAwIDAtNCA0djEyYTQgNCAwIDAgMCA0IDRoMTJhNCA0IDAgMCAwIDQtNFY2YTQgNCAwIDAgMC00LTRINnptMCAyaDEyYTIgMiAwIDAgMSAyIDJ2MTJhMiAyIDAgMCAxLTIgMkg2YTIgMiAwIDAgMS0yLTJWNmEyIDIgMCAwIDEgMi0yelwiIGNsaXAtcnVsZT1cImV2ZW5vZGRcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTExIDdoMnY3aC0yelwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTEgMTZoMnYyaC0yelwiLz5cbjwvc3ZnPmA7XG5cbi8qKlxuICogVmFsaWRhdGVzIGFuZCBjb252ZXJ0cyBTVkcgdGV4dCB0byBkYXRhIFVSTFxuICovXG5jb25zdCB0b1N2Z0RhdGFVcmwgPSAoc3ZnVGV4dDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBpZiAoIXN2Z1RleHQgfHwgdHlwZW9mIHN2Z1RleHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBTVkcgdGV4dDogZW1wdHkgb3Igbm90IGEgc3RyaW5nJyk7XG4gICAgfVxuXG4gICAgLy8gQmFzaWMgdmFsaWRhdGlvbiAtIGNoZWNrIGZvciBTVkcgdGFnXG4gICAgY29uc3QgdHJpbW1lZCA9IHN2Z1RleHQudHJpbSgpO1xuICAgIGlmICghdHJpbW1lZC5pbmNsdWRlcygnPHN2ZycpIHx8ICF0cmltbWVkLmluY2x1ZGVzKCc8L3N2Zz4nKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgU1ZHOiBtaXNzaW5nIHN2ZyB0YWdzJyk7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgZm9yIHJlYXNvbmFibGUgc2l6ZSAobm90IGVtcHR5LCBub3QgdG9vIGxhcmdlKVxuICAgIGlmICh0cmltbWVkLmxlbmd0aCA8IDUwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBTVkc6IGNvbnRlbnQgdG9vIHNtYWxsJyk7XG4gICAgfVxuXG4gICAgaWYgKHRyaW1tZWQubGVuZ3RoID4gMTAyNCAqIDEwMjQpIHsgLy8gMU1CIGxpbWl0XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBTVkc6IGNvbnRlbnQgdG9vIGxhcmdlJyk7XG4gICAgfVxuXG4gICAgLy8gQmFzaWMgWE1MIHN0cnVjdHVyZSBjaGVja1xuICAgIGNvbnN0IG9wZW5UYWdzID0gdHJpbW1lZC5tYXRjaCgvPFteLz9dW14+XSo+L2cpIHx8IFtdO1xuICAgIGNvbnN0IGNsb3NlVGFncyA9IHRyaW1tZWQubWF0Y2goLzxcXC9bXj5dKz4vZykgfHwgW107XG4gICAgY29uc3Qgc2VsZkNsb3NpbmdUYWdzID0gdHJpbW1lZC5tYXRjaCgvPFtePl0rXFwvPi9nKSB8fCBbXTtcblxuICAgIC8vIFJvdWdoIGNoZWNrIHRoYXQgd2UgaGF2ZSBiYWxhbmNlZCB0YWdzXG4gICAgaWYgKG9wZW5UYWdzLmxlbmd0aCArIHNlbGZDbG9zaW5nVGFncy5sZW5ndGggPCBjbG9zZVRhZ3MubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBTVkc6IHVuYmFsYW5jZWQgdGFncycpO1xuICAgIH1cblxuICAgIC8vIEVuc3VyZSBwcm9wZXIgVVRGLTggZW5jb2RpbmcgZm9yIFNWRyBkYXRhIFVSTHNcbiAgICB0cnkge1xuICAgICAgICAvLyBVc2UgVGV4dEVuY29kZXIgZm9yIHByb3BlciBVVEYtOCBoYW5kbGluZ1xuICAgICAgICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gICAgICAgIGNvbnN0IHV0ZjhCeXRlcyA9IGVuY29kZXIuZW5jb2RlKHN2Z1RleHQpO1xuICAgICAgICBjb25zdCBiaW5hcnlTdHJpbmcgPSBBcnJheS5mcm9tKHV0ZjhCeXRlcywgYnl0ZSA9PiBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGUpKS5qb2luKCcnKTtcbiAgICAgICAgcmV0dXJuIGBkYXRhOmltYWdlL3N2Zyt4bWw7YmFzZTY0LCR7YnRvYShiaW5hcnlTdHJpbmcpfWA7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSBvcmlnaW5hbCBtZXRob2QgaWYgVGV4dEVuY29kZXIgZmFpbHNcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBgZGF0YTppbWFnZS9zdmcreG1sO2Jhc2U2NCwke2J0b2EodW5lc2NhcGUoZW5jb2RlVVJJQ29tcG9uZW50KHN2Z1RleHQpKSl9YDtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBGaW5hbCBmYWxsYmFjazogcmV0dXJuIFNWRyBhcy1pcyB3aXRob3V0IGJhc2U2NCBlbmNvZGluZ1xuICAgICAgICAgICAgcmV0dXJuIGBkYXRhOmltYWdlL3N2Zyt4bWw7Y2hhcnNldD11dGYtOCwke2VuY29kZVVSSUNvbXBvbmVudChzdmdUZXh0KX1gO1xuICAgICAgICB9XG4gICAgfVxufTtcblxuY29uc3QgRkFMTEJBQ0tfU1ZHX0RBVEFfVVJMID0gKCgpID0+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gdG9TdmdEYXRhVXJsKEZBTExCQUNLX1NWR19URVhUKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGBkYXRhOmltYWdlL3N2Zyt4bWw7Y2hhcnNldD11dGYtOCwke2VuY29kZVVSSUNvbXBvbmVudChGQUxMQkFDS19TVkdfVEVYVCl9YDtcbiAgICB9XG59KSgpO1xuXG5leHBvcnQgY29uc3QgRkFMTEJBQ0tfSUNPTl9EQVRBX1VSTCA9IEZBTExCQUNLX1NWR19EQVRBX1VSTDtcblxuY29uc3QgcmV3cml0ZVBob3NwaG9yVXJsID0gKHVybDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICAvLyBMZWdhY3kgKGJyb2tlbikgZm9ybWF0IHVzZWQgcHJldmlvdXNseTpcbiAgICAvLyAtIGh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9naC9waG9zcGhvci1pY29ucy9waG9zcGhvci1pY29ucy9zcmMve3N0eWxlfS97bmFtZX0uc3ZnXG4gICAgLy9cbiAgICAvLyBDb3JyZWN0L3N0YWJsZSBmb3JtYXQgKG5wbSBwYWNrYWdlIGFzc2V0cyk6XG4gICAgLy8gLSBodHRwczovL2Nkbi5qc2RlbGl2ci5uZXQvbnBtL0BwaG9zcGhvci1pY29ucy9jb3JlQDIvYXNzZXRzL3tzdHlsZX0ve25hbWV9LnN2Z1xuICAgIC8vXG4gICAgLy8gS2VlcCB0aGlzIHJld3JpdGUgY29uc2VydmF0aXZlOiBvbmx5IHJld3JpdGUga25vd24gcGhvc3Bob3IgcGF0dGVybnMuXG4gICAgaWYgKCF1cmwgfHwgdHlwZW9mIHVybCAhPT0gJ3N0cmluZycpIHJldHVybiB1cmw7XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBpc0h0dHBPcmlnaW4gPSAoKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcHJvdG8gPSAoZ2xvYmFsU2NvcGUubG9jYXRpb24gYXMgYW55KT8ucHJvdG9jb2wgfHwgXCJcIjtcbiAgICAgICAgICAgIHJldHVybiBwcm90byA9PT0gXCJodHRwOlwiIHx8IHByb3RvID09PSBcImh0dHBzOlwiO1xuICAgICAgICB9KSgpO1xuICAgICAgICBjb25zdCBpc0V4dGVuc2lvblJ1bnRpbWUgPSBoYXNDaHJvbWVSdW50aW1lKCk7XG5cbiAgICAgICAgY29uc3QgdG9OcG1Bc3NldFVybCA9IChzdHlsZTogc3RyaW5nLCBiYXNlTmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICAvLyBGb3IgZHVvdG9uZSBpY29ucywgYXBwZW5kICctZHVvdG9uZScgdG8gdGhlIGZpbGVuYW1lXG4gICAgICAgICAgICAvLyBGb3Igb3RoZXIgc3R5bGVzIGxpa2UgJ2ZpbGwnLCAnYm9sZCcsIGV0Yy4sIGFwcGVuZCAnLXtzdHlsZX0nXG4gICAgICAgICAgICBjb25zdCBpY29uRmlsZU5hbWUgPSBzdHlsZSA9PT0gXCJkdW90b25lXCJcbiAgICAgICAgICAgICAgICA/IGAke2Jhc2VOYW1lfS1kdW90b25lYFxuICAgICAgICAgICAgICAgIDogc3R5bGUgIT09IFwicmVndWxhclwiXG4gICAgICAgICAgICAgICAgICAgID8gYCR7YmFzZU5hbWV9LSR7c3R5bGV9YFxuICAgICAgICAgICAgICAgICAgICA6IGJhc2VOYW1lO1xuICAgICAgICAgICAgcmV0dXJuIGBodHRwczovL2Nkbi5qc2RlbGl2ci5uZXQvbnBtL0BwaG9zcGhvci1pY29ucy9jb3JlQDIvYXNzZXRzLyR7c3R5bGV9LyR7aWNvbkZpbGVOYW1lfS5zdmdgO1xuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnN0IHVybE9iaiA9IG5ldyBVUkwodXJsKTtcblxuICAgICAgICAvLyBJbiBleHRlbnNpb24gcnVudGltZXMgKGluY2x1ZGluZyBjb250ZW50IHNjcmlwdHMgb24gaHR0cChzKSBwYWdlcyksXG4gICAgICAgIC8vIGAvYXNzZXRzL2ljb25zLypgIGFsaWFzZXMgbWF5IG5vdCBleGlzdC4gUmV3cml0ZSB0byBzdGFibGUgQ0ROIFVSTC5cbiAgICAgICAgaWYgKChpc0V4dGVuc2lvblJ1bnRpbWUgfHwgIWlzSHR0cE9yaWdpbikgJiYgdXJsT2JqLnBhdGhuYW1lLnN0YXJ0c1dpdGgoXCIvYXNzZXRzL2ljb25zL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFydHMgPSB1cmxPYmoucGF0aG5hbWUuc3BsaXQoXCIvXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbGlkU3R5bGVzID0gW1widGhpblwiLCBcImxpZ2h0XCIsIFwicmVndWxhclwiLCBcImJvbGRcIiwgXCJmaWxsXCIsIFwiZHVvdG9uZVwiXTtcblxuICAgICAgICAgICAgbGV0IHN0eWxlID0gXCJkdW90b25lXCI7XG4gICAgICAgICAgICBsZXQgYmFzZU5hbWUgPSBcIlwiO1xuXG4gICAgICAgICAgICAvLyAvYXNzZXRzL2ljb25zL3Bob3NwaG9yLzpzdHlsZS86aWNvblxuICAgICAgICAgICAgaWYgKHBhcnRzWzJdID09PSBcInBob3NwaG9yXCIpIHtcbiAgICAgICAgICAgICAgICBzdHlsZSA9IChwYXJ0c1szXSB8fCBcImR1b3RvbmVcIikudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgICBiYXNlTmFtZSA9IChwYXJ0c1s0XSB8fCBcIlwiKS5yZXBsYWNlKC9cXC5zdmckL2ksIFwiXCIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwYXJ0c1syXSA9PT0gXCJkdW90b25lXCIpIHtcbiAgICAgICAgICAgICAgICAvLyAvYXNzZXRzL2ljb25zL2R1b3RvbmUvOmljb25cbiAgICAgICAgICAgICAgICBzdHlsZSA9IFwiZHVvdG9uZVwiO1xuICAgICAgICAgICAgICAgIGJhc2VOYW1lID0gKHBhcnRzWzNdIHx8IFwiXCIpLnJlcGxhY2UoL1xcLnN2ZyQvaSwgXCJcIik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBhcnRzLmxlbmd0aCA+PSA0KSB7XG4gICAgICAgICAgICAgICAgLy8gL2Fzc2V0cy9pY29ucy86c3R5bGUvOmljb25cbiAgICAgICAgICAgICAgICBzdHlsZSA9IChwYXJ0c1syXSB8fCBcImR1b3RvbmVcIikudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgICBiYXNlTmFtZSA9IChwYXJ0c1szXSB8fCBcIlwiKS5yZXBsYWNlKC9cXC5zdmckL2ksIFwiXCIpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwYXJ0cy5sZW5ndGggPT09IDMpIHtcbiAgICAgICAgICAgICAgICAvLyAvYXNzZXRzL2ljb25zLzppY29uIChkZWZhdWx0IHN0eWxlKVxuICAgICAgICAgICAgICAgIHN0eWxlID0gXCJkdW90b25lXCI7XG4gICAgICAgICAgICAgICAgYmFzZU5hbWUgPSAocGFydHNbMl0gfHwgXCJcIikucmVwbGFjZSgvXFwuc3ZnJC9pLCBcIlwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHZhbGlkU3R5bGVzLmluY2x1ZGVzKHN0eWxlKSAmJiBiYXNlTmFtZSAmJiAvXlthLXowLTktXSskLy50ZXN0KGJhc2VOYW1lKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0b05wbUFzc2V0VXJsKHN0eWxlLCBiYXNlTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdXJsO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gT25seSByZXdyaXRlIEdpdEh1YiBwaG9zcGhvciBVUkxzXG4gICAgICAgIGlmICh1cmxPYmouaG9zdG5hbWUgPT09ICdjZG4uanNkZWxpdnIubmV0JyAmJlxuICAgICAgICAgICAgdXJsT2JqLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9naC9waG9zcGhvci1pY29ucy9waG9zcGhvci1pY29ucy8nKSkge1xuXG4gICAgICAgICAgICBjb25zdCBwYXRoUGFydHMgPSB1cmxPYmoucGF0aG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICAgICAgICBjb25zdCBzcmNJbmRleCA9IHBhdGhQYXJ0cy5pbmRleE9mKCdzcmMnKTtcblxuICAgICAgICAgICAgaWYgKHNyY0luZGV4ID49IDAgJiYgcGF0aFBhcnRzLmxlbmd0aCA+PSBzcmNJbmRleCArIDMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzdHlsZSA9IHBhdGhQYXJ0c1tzcmNJbmRleCArIDFdO1xuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVOYW1lID0gcGF0aFBhcnRzW3NyY0luZGV4ICsgMl07XG5cbiAgICAgICAgICAgICAgICBpZiAoc3R5bGUgJiYgZmlsZU5hbWUgJiYgZmlsZU5hbWUuZW5kc1dpdGgoJy5zdmcnKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgaWNvbk5hbWUgPSBmaWxlTmFtZS5yZXBsYWNlKC9cXC5zdmckL2ksICcnKTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBSZW1vdmUgc3R5bGUgc3VmZml4IGZyb20gaWNvbiBuYW1lIGlmIHByZXNlbnQgKGUuZy4sIFwiZm9sZGVyLW9wZW4tZHVvdG9uZVwiIC0+IFwiZm9sZGVyLW9wZW5cIilcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN0eWxlID09PSAnZHVvdG9uZScgJiYgaWNvbk5hbWUuZW5kc1dpdGgoJy1kdW90b25lJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGljb25OYW1lID0gaWNvbk5hbWUucmVwbGFjZSgvLWR1b3RvbmUkLywgJycpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN0eWxlICE9PSAncmVndWxhcicgJiYgaWNvbk5hbWUuZW5kc1dpdGgoYC0ke3N0eWxlfWApKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpY29uTmFtZSA9IGljb25OYW1lLnJlcGxhY2UobmV3IFJlZ0V4cChgLSR7c3R5bGV9JGApLCAnJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvLyBWYWxpZGF0ZSBzdHlsZSBhbmQgaWNvbiBuYW1lXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbGlkU3R5bGVzID0gWyd0aGluJywgJ2xpZ2h0JywgJ3JlZ3VsYXInLCAnYm9sZCcsICdmaWxsJywgJ2R1b3RvbmUnXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHZhbGlkU3R5bGVzLmluY2x1ZGVzKHN0eWxlKSAmJiBpY29uTmFtZSAmJiAvXlthLXowLTktXSskLy50ZXN0KGljb25OYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gUHJlZmVyIHByb3h5IG9ubHkgb24gbm9uLWV4dGVuc2lvbiBodHRwKHMpIG9yaWdpbnMgd2hlcmUgL2FwaSBleGlzdHMuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKGlzSHR0cE9yaWdpbiAmJiAhaXNFeHRlbnNpb25SdW50aW1lKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gYC9hc3NldHMvaWNvbnMvcGhvc3Bob3IvJHtzdHlsZX0vJHtpY29uTmFtZX0uc3ZnYFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdG9OcG1Bc3NldFVybChzdHlsZSwgaWNvbk5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWxzbyBoYW5kbGUgZGlyZWN0IG5wbSBwYWNrYWdlIFVSTHMgdGhhdCBtaWdodCBiZSB1c2VkXG4gICAgICAgIGlmICh1cmxPYmouaG9zdG5hbWUgPT09ICdjZG4uanNkZWxpdnIubmV0JyAmJlxuICAgICAgICAgICAgdXJsT2JqLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9ucG0vQHBob3NwaG9yLWljb25zLycpKSB7XG4gICAgICAgICAgICAvLyBFeHRyYWN0IHN0eWxlIGFuZCBpY29uIG5hbWUgZnJvbSBucG0gVVJMXG4gICAgICAgICAgICBjb25zdCBwYXRoUGFydHMgPSB1cmxPYmoucGF0aG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICAgICAgICBjb25zdCBhc3NldHNJbmRleCA9IHBhdGhQYXJ0cy5pbmRleE9mKCdhc3NldHMnKTtcblxuICAgICAgICAgICAgaWYgKGFzc2V0c0luZGV4ID49IDAgJiYgcGF0aFBhcnRzLmxlbmd0aCA+PSBhc3NldHNJbmRleCArIDMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzdHlsZSA9IHBhdGhQYXJ0c1thc3NldHNJbmRleCArIDFdO1xuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVOYW1lID0gcGF0aFBhcnRzW2Fzc2V0c0luZGV4ICsgMl07XG5cbiAgICAgICAgICAgICAgICBpZiAoc3R5bGUgJiYgZmlsZU5hbWUgJiYgZmlsZU5hbWUuZW5kc1dpdGgoJy5zdmcnKSkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgaWNvbk5hbWUgPSBmaWxlTmFtZS5yZXBsYWNlKC9cXC5zdmckL2ksICcnKTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBSZW1vdmUgc3R5bGUgc3VmZml4IGZyb20gaWNvbiBuYW1lIGlmIHByZXNlbnQgKGUuZy4sIFwiZm9sZGVyLW9wZW4tZHVvdG9uZVwiIC0+IFwiZm9sZGVyLW9wZW5cIilcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN0eWxlID09PSAnZHVvdG9uZScgJiYgaWNvbk5hbWUuZW5kc1dpdGgoJy1kdW90b25lJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGljb25OYW1lID0gaWNvbk5hbWUucmVwbGFjZSgvLWR1b3RvbmUkLywgJycpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN0eWxlICE9PSAncmVndWxhcicgJiYgaWNvbk5hbWUuZW5kc1dpdGgoYC0ke3N0eWxlfWApKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpY29uTmFtZSA9IGljb25OYW1lLnJlcGxhY2UobmV3IFJlZ0V4cChgLSR7c3R5bGV9JGApLCAnJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvLyBWYWxpZGF0ZSBzdHlsZSBhbmQgaWNvbiBuYW1lXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbGlkU3R5bGVzID0gWyd0aGluJywgJ2xpZ2h0JywgJ3JlZ3VsYXInLCAnYm9sZCcsICdmaWxsJywgJ2R1b3RvbmUnXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHZhbGlkU3R5bGVzLmluY2x1ZGVzKHN0eWxlKSAmJiBpY29uTmFtZSAmJiAvXlthLXowLTktXSskLy50ZXN0KGljb25OYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gUHJlZmVyIHByb3h5IG9ubHkgb24gbm9uLWV4dGVuc2lvbiBodHRwKHMpIG9yaWdpbnMgd2hlcmUgL2FwaSBleGlzdHMuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKGlzSHR0cE9yaWdpbiAmJiAhaXNFeHRlbnNpb25SdW50aW1lKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gYC9hc3NldHMvaWNvbnMvcGhvc3Bob3IvJHtzdHlsZX0vJHtpY29uTmFtZX0uc3ZnYFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogdG9OcG1Bc3NldFVybChzdHlsZSwgaWNvbk5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gSW52YWxpZCBVUkwsIHJldHVybiBhcy1pc1xuICAgICAgICBjb25zb2xlLndhcm4oJ1t1aS1pY29uXSBJbnZhbGlkIFVSTCBmb3IgcGhvc3Bob3IgcmV3cml0ZTonLCB1cmwsIGVycm9yKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdXJsO1xufTtcblxuY29uc3QgaXNDbGllbnRFcnJvclN0YXR1cyA9IChlcnJvcjogdW5rbm93bik6IGJvb2xlYW4gPT4ge1xuICAgIGlmICghKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgLy8gRG9uJ3QgcmV0cnkgNHh4IGNsaWVudCBlcnJvcnMgKGV4Y2VwdCA0MDggUmVxdWVzdCBUaW1lb3V0IHdoaWNoIG1pZ2h0IGJlIG5ldHdvcmsgcmVsYXRlZClcbiAgICBpZiAoL1xcYkhUVFBcXHMqNFxcZFxcZFxcYi8udGVzdChlcnJvci5tZXNzYWdlKSB8fCAvXFxiNFxcZFxcZFxcYi8udGVzdChlcnJvci5tZXNzYWdlKSkge1xuICAgICAgICByZXR1cm4gIS80MDgvLnRlc3QoZXJyb3IubWVzc2FnZSk7IC8vIEFsbG93IHJldHJ5IGZvciA0MDhcbiAgICB9XG5cbiAgICAvLyBSZXRyeSBvbiBuZXR3b3JrLXJlbGF0ZWQgZXJyb3JzIHRoYXQgbWlnaHQgYmUgdGVtcG9yYXJ5XG4gICAgcmV0dXJuIC9uZXR3b3JrfHRpbWVvdXR8b2ZmbGluZXxjb25uZWN0aW9ufGFib3J0ZWQvaS50ZXN0KGVycm9yLm1lc3NhZ2UpIHx8XG4gICAgICAgICAgIGVycm9yLm5hbWUgPT09ICdUeXBlRXJyb3InICYmIC9mZXRjaC9pLnRlc3QoZXJyb3IubWVzc2FnZSk7XG59O1xuXG4vLyBJbnRlcm5hbCBsb2FkZXIgd2l0aCByZXRyeSBzdXBwb3J0XG4vLyBJbnRlcm5hbCBsb2FkZXIgd2l0aCByZXRyeSBzdXBwb3J0XG5cbmNvbnN0IGxvYWRBc0ltYWdlSW50ZXJuYWwgPSBhc3luYyAobmFtZTogYW55LCBjcmVhdG9yPzogKG5hbWU6IGFueSkgPT4gYW55LCBhdHRlbXB0ID0gMCk6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgaWYgKGlzUGF0aFVSTChuYW1lKSkge1xuICAgICAgICBjb25zdCByZXNvbHZlZFVybCA9IHJlc29sdmVBc3NldFVybChuYW1lKTtcblxuICAgICAgICAvLyBTa2lwIGlmIHRoaXMgaXMgYWxyZWFkeSBhIGRhdGEgVVJMIChmcm9tIGNhY2hlIG9yIHByZXZpb3VzIHByb2Nlc3NpbmcpXG4gICAgICAgIGlmIChyZXNvbHZlZFVybC5zdGFydHNXaXRoKFwiZGF0YTpcIikpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gQWxyZWFkeSBhIGRhdGEgVVJMLCByZXR1cm5pbmcgYXMtaXNgKTtcbiAgICAgICAgICAgIHJldHVybiByZXNvbHZlZFVybDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZVVybCA9IHJld3JpdGVQaG9zcGhvclVybChyZXNvbHZlZFVybCk7XG4gICAgICAgIGlmIChlZmZlY3RpdmVVcmwgIT09IHJlc29sdmVkVXJsKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW3VpLWljb25dIFJld3JvdGUgcGhvc3Bob3IgVVJMOiAke3Jlc29sdmVkVXJsfSAtPiAke2VmZmVjdGl2ZVVybH1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBUcnkgT1BGUyBjYWNoZSBmaXJzdCAoZmFzdCwgbG9jYWwsIGF2b2lkcyBuZXR3b3JrIHN0b3JtcykuXG4gICAgICAgICAgICBpZiAoaXNPUEZTU3VwcG9ydGVkKCkpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCB3aXRoVGltZW91dChnZXRDYWNoZWRWZWN0b3JJY29uKGVmZmVjdGl2ZVVybCksIDUwKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhY2hlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYmxvYiA9IGF3YWl0IGZldGNoU3ZnQmxvYihjYWNoZWQsIEZFVENIX1RJTUVPVVRfTVMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3ZnVGV4dCA9IGF3YWl0IGJsb2IudGV4dCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRvU3ZnRGF0YVVybChzdmdUZXh0KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgICAgICAvKiBjYWNoZSBtaXNzIG9yIHRpbWVvdXQgKi9cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEJ1aWxkIGEgc21hbGwsIGNvcnJlY3QgZmFsbGJhY2sgbGlzdCAoc2VxdWVudGlhbCBhdHRlbXB0cykuXG4gICAgICAgICAgICAvLyBJZiBwaG9zcGhvciByZXdyaXRlIHBvaW50cyB0byBsb2NhbCBwcm94eSBhbmQgaXQgZmFpbHMgKGUuZy4gNTAyKSxcbiAgICAgICAgICAgIC8vIHdlIG11c3Qgc3RpbGwgdHJ5IG9yaWdpbmFsIENETiBzb3VyY2UgZm9yIGZpcnN0LXRpbWUgdXNlcnMuXG4gICAgICAgICAgICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtlZmZlY3RpdmVVcmxdO1xuXG4gICAgICAgICAgICBpZiAoZWZmZWN0aXZlVXJsICE9PSByZXNvbHZlZFVybCkge1xuICAgICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaChyZXNvbHZlZFVybCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEFkZCBDRE4gbWlycm9ycyBmb3IgZXZlcnkgY2FuZGlkYXRlIHRoYXQgcG9pbnRzIHRvIGpzRGVsaXZyLlxuICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgWy4uLmNhbmRpZGF0ZXNdKSB7XG4gICAgICAgICAgICAgICAgLy8ganNEZWxpdnIgLT4gdW5wa2cgKGNvcnJlY3QgcGF0aCBtYXBwaW5nIGZvciBwaG9zcGhvciBhc3NldHMpXG4gICAgICAgICAgICAgICAgaWYgKGNhbmRpZGF0ZS5zdGFydHNXaXRoKFwiaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS9cIikpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdW5wa2cgPSBjYW5kaWRhdGUucmVwbGFjZShcImh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vXCIsIFwiaHR0cHM6Ly91bnBrZy5jb20vXCIpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNhbmRpZGF0ZXMuaW5jbHVkZXModW5wa2cpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYW5kaWRhdGVzLnB1c2godW5wa2cpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gT25seSBhdHRlbXB0IGEgc2Vjb25kIG1pcnJvciBpZiBpdOKAmXMgYW4gaHR0cHMgVVJMIGFuZCBub3QgYWxyZWFkeSBpbmNsdWRlZC5cbiAgICAgICAgICAgICAgICBpZiAoY2FuZGlkYXRlLnN0YXJ0c1dpdGgoXCJodHRwczovL1wiKSAmJiBjYW5kaWRhdGUuaW5jbHVkZXMoXCJjZG4uanNkZWxpdnIubmV0XCIpKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1pcnJvciA9IGNhbmRpZGF0ZS5yZXBsYWNlKFwiY2RuLmpzZGVsaXZyLm5ldFwiLCBcInVucGtnLmNvbVwiKS5yZXBsYWNlKFwiL25wbS9cIiwgXCIvXCIpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNhbmRpZGF0ZXMuaW5jbHVkZXMobWlycm9yKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKG1pcnJvcik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGVycm9yczogRXJyb3JbXSA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCB1cmwgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGJsb2IgPSBhd2FpdCBmZXRjaFN2Z0Jsb2IodXJsLCBGRVRDSF9USU1FT1VUX01TKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJsb2Iuc2l6ZSA+IDEwMjQgKiAxMDI0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEJsb2IgdG9vIGxhcmdlICgke2Jsb2Iuc2l6ZX0gYnl0ZXMpYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3ZnVGV4dCA9IGF3YWl0IGJsb2IudGV4dCgpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhVXJsID0gdG9TdmdEYXRhVXJsKHN2Z1RleHQpO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIENhY2hlIHZlY3RvciBTVkcgZm9yIHRoZSBjYW5vbmljYWwgVVJMIGluIGJhY2tncm91bmQgKGJlc3QtZWZmb3J0KSxcbiAgICAgICAgICAgICAgICAgICAgLy8gZXZlbiBpZiB3ZSBzdWNjZWVkZWQgdmlhIGEgbWlycm9yLlxuICAgICAgICAgICAgICAgICAgICBpZiAoaXNPUEZTU3VwcG9ydGVkKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlVmVjdG9ySWNvbihlZmZlY3RpdmVVcmwsIGJsb2IpLmNhdGNoKCgpID0+IHsgLyogc2lsZW50ICovIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRhdGFVcmw7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBlcnIgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlIDogbmV3IEVycm9yKFN0cmluZyhlKSk7XG4gICAgICAgICAgICAgICAgICAgIGVycm9ycy5wdXNoKG5ldyBFcnJvcihgJHt1cmx9OiAke2Vyci5tZXNzYWdlfWApKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQWxsIGljb24gc291cmNlcyBmYWlsZWQ6ICR7ZXJyb3JzLm1hcChlID0+IGUubWVzc2FnZSkuam9pbihcIjsgXCIpfWApO1xuXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFt1aS1pY29uXSBGYWlsZWQgdG8gbG9hZCBpY29uOiAke2VmZmVjdGl2ZVVybH1gLCBlcnJvcik7XG5cbiAgICAgICAgICAgIC8vIERvbid0IHNwYW0gcmV0cmllcyBvbiA0MDQvNHh4OiBpdCdzIGEgZGV0ZXJtaW5pc3RpYyBmYWlsdXJlLlxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCBNQVhfUkVUUklFUyAmJiAhaXNDbGllbnRFcnJvclN0YXR1cyhlcnJvcikpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW3VpLWljb25dIFF1ZXVlaW5nIHJldHJ5ICR7YXR0ZW1wdCArIDF9IGZvciAke2VmZmVjdGl2ZVVybH1gKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXRyeVF1ZXVlLnB1c2goeyBuYW1lLCBjcmVhdG9yLCByZXNvbHZlLCByZWplY3QsIHJldHJpZXM6IGF0dGVtcHQgKyAxIH0pO1xuICAgICAgICAgICAgICAgICAgICBzY2hlZHVsZVJldHJ5UXVldWUoKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gSWYgZXZlcnl0aGluZyBmYWlsZWQgKENPUlMvb2ZmbGluZS9ldGMpLCBwcmVmZXIgcmV0dXJuaW5nIGEgY2FjaGVkIHZlY3RvciBpY29uIGlmIHByZXNlbnQuXG4gICAgICAgICAgICBjb25zdCBjYWNoZWREYXRhVXJsID0gYXdhaXQgdHJ5TG9hZEZyb21WZWN0b3JDYWNoZShlZmZlY3RpdmVVcmwpO1xuICAgICAgICAgICAgaWYgKGNhY2hlZERhdGFVcmwpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFt1aS1pY29uXSBVc2luZyBPUEZTIGNhY2hlZCBpY29uIGFmdGVyIGZhaWx1cmVzOiAke2VmZmVjdGl2ZVVybH1gKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YVVybDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gRmluYWwgZmFsbGJhY2s6IHJldHVybiBhIHNpbXBsZSBwbGFjZWhvbGRlciBTVkdcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgW3VpLWljb25dIEFsbCBsb2FkaW5nIG1ldGhvZHMgZmFpbGVkLCB1c2luZyBmYWxsYmFjayBTVkcgZm9yOiAke2VmZmVjdGl2ZVVybH1gLCBlcnJvcik7XG4gICAgICAgICAgICByZXR1cm4gRkFMTEJBQ0tfU1ZHX0RBVEFfVVJMO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgZG9Mb2FkID0gYXN5bmMgKCk6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgICAgIGNvbnN0IGVsZW1lbnQgPSBhd2FpdCAoY3JlYXRvciA/IGNyZWF0b3I/LihuYW1lKSA6IG5hbWUpO1xuICAgICAgICBpZiAoaXNQYXRoVVJMKGVsZW1lbnQpKSB7XG4gICAgICAgICAgICAvLyBSZWN1cnNlIHRvIGdldCBPUEZTIGNhY2hpbmcgZm9yIHBhdGggVVJMc1xuICAgICAgICAgICAgcmV0dXJuIGxvYWRBc0ltYWdlSW50ZXJuYWwoZWxlbWVudCwgdW5kZWZpbmVkLCBhdHRlbXB0KTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgZmlsZTogYW55ID0gbmFtZTtcbiAgICAgICAgaWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBCbG9iIHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBGaWxlKSB7IGZpbGUgPSBlbGVtZW50OyB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBlbGVtZW50ID09IFwic3RyaW5nXCIgPyBlbGVtZW50IDogZWxlbWVudC5vdXRlckhUTUw7XG4gICAgICAgICAgICBmaWxlID0gbmV3IEJsb2IoW2A8P3htbCB2ZXJzaW9uPVxcXCIxLjBcXFwiIGVuY29kaW5nPVxcXCJVVEYtOFxcXCI/PmAsIHRleHRdLCB7IHR5cGU6IFwiaW1hZ2Uvc3ZnK3htbFwiIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByYXN0ZXJpemVTVkcoZmlsZSk7XG4gICAgfTtcblxuICAgIHRyeSB7XG4gICAgICAgIC8vIEZpcnN0IGF0dGVtcHQgd2l0aCB0aW1lb3V0XG4gICAgICAgIHJldHVybiBhd2FpdCB3aXRoVGltZW91dChkb0xvYWQoKSwgRkVUQ0hfVElNRU9VVF9NUyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gT24gdGltZW91dCwgcXVldWUgZm9yIHJldHJ5IGlmIG5vdCBleGNlZWRlZCBtYXggcmV0cmllc1xuICAgICAgICBpZiAoYXR0ZW1wdCA8IE1BWF9SRVRSSUVTICYmIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyb3IubWVzc2FnZSA9PT0gXCJUaW1lb3V0XCIpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgICAgcmV0cnlRdWV1ZS5wdXNoKHsgbmFtZSwgY3JlYXRvciwgcmVzb2x2ZSwgcmVqZWN0LCByZXRyaWVzOiBhdHRlbXB0ICsgMSB9KTtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZVJldHJ5UXVldWUoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbn07XG5cbmV4cG9ydCBjb25zdCBsb2FkQXNJbWFnZSA9IGFzeW5jIChuYW1lOiBhbnksIGNyZWF0b3I/OiAobmFtZTogYW55KSA9PiBhbnkpOiBQcm9taXNlPHN0cmluZz4gPT4ge1xuICAgIGlmIChpc1BhdGhVUkwobmFtZSkpIHsgbmFtZSA9IHJlc29sdmVBc3NldFVybChuYW1lKSB8fCBuYW1lOyB9XG4gICAgLy8gQHRzLWlnbm9yZSAvLyAhZXhwZXJpbWVudGFsIGBnZXRPckluc2VydGAgZmVhdHVyZSFcbiAgICByZXR1cm4gaWNvbk1hcC5nZXRPckluc2VydENvbXB1dGVkKG5hbWUsICgpID0+IGxvYWRBc0ltYWdlSW50ZXJuYWwobmFtZSwgY3JlYXRvciwgMCkpO1xufTtcblxuLyoqXG4gKiBDbGVhcnMgaW4tbWVtb3J5IGNhY2hlcyBmb3IgaWNvbiBsb2FkaW5nXG4gKiBVc2VmdWwgd2hlbiBzd2l0Y2hpbmcgdGhlbWVzIG9yIHdoZW4gY2FjaGUgYmVjb21lcyBzdGFsZVxuICovXG5leHBvcnQgY29uc3QgY2xlYXJJY29uQ2FjaGVzID0gKCk6IHZvaWQgPT4ge1xuICAgIHJlc29sdmVkVXJsQ2FjaGUuY2xlYXIoKTtcbiAgICBpbWFnZUVsZW1lbnRDYWNoZS5jbGVhcigpO1xuICAgIGljb25NYXAuY2xlYXIoKTtcbiAgICByZXRyeVF1ZXVlLmxlbmd0aCA9IDA7IC8vIENsZWFyIHBlbmRpbmcgcmV0cmllc1xuXG4gICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgIGNvbnNvbGUubG9nPy4oXCJbaWNvbi1sb2FkZXJdIENsZWFyZWQgYWxsIGluLW1lbW9yeSBjYWNoZXNcIik7XG4gICAgfVxufTtcblxuLyoqXG4gKiBGb3JjZXMgY2FjaGUgaW52YWxpZGF0aW9uIGZvciBhIHNwZWNpZmljIGljb25cbiAqIEBwYXJhbSBpY29uTmFtZSBUaGUgaWNvbiBuYW1lL1VSTCB0byBpbnZhbGlkYXRlXG4gKi9cbmV4cG9ydCBjb25zdCBpbnZhbGlkYXRlSWNvbkNhY2hlID0gKGljb25OYW1lOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAoIWljb25OYW1lKSByZXR1cm47XG5cbiAgICAvLyBSZW1vdmUgZnJvbSBpbi1tZW1vcnkgY2FjaGVzXG4gICAgcmVzb2x2ZWRVcmxDYWNoZS5kZWxldGUoaWNvbk5hbWUpO1xuICAgIGltYWdlRWxlbWVudENhY2hlLmRlbGV0ZShpY29uTmFtZSk7XG4gICAgaWNvbk1hcC5kZWxldGUoaWNvbk5hbWUpO1xuXG4gICAgLy8gUmVtb3ZlIGZyb20gT1BGUyBjYWNoZSAoYXN5bmMsIGZpcmUtYW5kLWZvcmdldClcbiAgICBpZiAodHlwZW9mIGltcG9ydCgnLi9PUEZTQ2FjaGUnKSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgaW1wb3J0KCcuL09QRlNDYWNoZScpLnRoZW4oKHsgY2xlYXJBbGxDYWNoZSB9KSA9PiB7XG4gICAgICAgICAgICAvLyBGb3IgaW5kaXZpZHVhbCBpY29ucywgd2UgbWlnaHQgd2FudCB0byBpbXBsZW1lbnQgc2VsZWN0aXZlIGNsZWFyaW5nXG4gICAgICAgICAgICAvLyBGb3Igbm93LCBqdXN0IGNsZWFyIHByb2JsZW1hdGljIGVudHJpZXNcbiAgICAgICAgICAgIGNsZWFyQWxsQ2FjaGUoKS5jYXRjaCgoKSA9PiB7IC8qIHNpbGVudCAqLyB9KTtcbiAgICAgICAgfSkuY2F0Y2goKCkgPT4geyAvKiBzaWxlbnQgKi8gfSk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgIGNvbnNvbGUubG9nPy4oYFtpY29uLWxvYWRlcl0gSW52YWxpZGF0ZWQgY2FjaGUgZm9yOiAke2ljb25OYW1lfWApO1xuICAgIH1cbn07XG5cbi8qKlxuICogVGVzdHMgdGhlIHJhY2luZyBsb2FkaW5nIGZ1bmN0aW9uYWxpdHkgYnkgbG9hZGluZyBhbiBpY29uIHdpdGggdmVyYm9zZSBsb2dnaW5nXG4gKiBAcGFyYW0gaWNvblVybCBUaGUgaWNvbiBVUkwgdG8gdGVzdFxuICogQHJldHVybnMgUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIHRoZSBsb2FkZWQgZGF0YSBVUkxcbiAqL1xuZXhwb3J0IGNvbnN0IHRlc3RJY29uUmFjaW5nID0gYXN5bmMgKGljb25Vcmw6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiA9PiB7XG4gICAgY29uc29sZS5sb2coYFtpY29uLXRlc3RdIFRlc3RpbmcgcmFjaW5nIGZvcjogJHtpY29uVXJsfWApO1xuXG4gICAgLy8gQ2xlYXIgY2FjaGVzIHRvIGZvcmNlIGZyZXNoIGxvYWRcbiAgICBjbGVhckljb25DYWNoZXMoKTtcblxuICAgIGNvbnN0IHN0YXJ0VGltZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGxvYWRBc0ltYWdlKGljb25VcmwpO1xuICAgIGNvbnN0IGVuZFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcblxuICAgIGNvbnNvbGUubG9nKGBbaWNvbi10ZXN0XSBSYWNpbmcgdGVzdCBjb21wbGV0ZWQgaW4gJHsoZW5kVGltZSAtIHN0YXJ0VGltZSkudG9GaXhlZCgyKX1tc2ApO1xuICAgIGNvbnNvbGUubG9nKGBbaWNvbi10ZXN0XSBSZXN1bHQ6YCwgcmVzdWx0LnN1YnN0cmluZygwLCAxMDApICsgJy4uLicpO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbi8qKlxuICogRGVidWcgZnVuY3Rpb24gdG8gY2hlY2sgaWNvbiBzeXN0ZW0gc3RhdHVzXG4gKi9cbmV4cG9ydCBjb25zdCBkZWJ1Z0ljb25TeXN0ZW0gPSAoKTogdm9pZCA9PiB7XG4gICAgY29uc29sZS5ncm91cCgnW2ljb24tZGVidWddIEljb24gU3lzdGVtIFN0YXR1cycpO1xuXG4gICAgLy8gQ2hlY2sgY2FjaGVzIGZpcnN0IChhbHdheXMgYXZhaWxhYmxlKVxuICAgIGNvbnNvbGUubG9nKCdSZXNvbHZlZCBVUkwgY2FjaGUgc2l6ZTonLCByZXNvbHZlZFVybENhY2hlLnNpemUpO1xuICAgIGNvbnNvbGUubG9nKCdJbWFnZSBlbGVtZW50IGNhY2hlIHNpemU6JywgaW1hZ2VFbGVtZW50Q2FjaGUuc2l6ZSk7XG4gICAgY29uc29sZS5sb2coJ0ljb24gbWFwIHNpemU6JywgaWNvbk1hcC5zaXplKTtcbiAgICBjb25zb2xlLmxvZygnUmV0cnkgcXVldWUgbGVuZ3RoOicsIHJldHJ5UXVldWUubGVuZ3RoKTtcblxuICAgIC8vIENoZWNrIENTUyByZWdpc3RyeSBhbmQgT1BGUyBhc3luY2hyb25vdXNseVxuICAgIFByb21pc2UuYWxsKFtcbiAgICAgICAgaW1wb3J0KCcuL0NTU0ljb25SZWdpc3RyeScpLnRoZW4oKHsgZ2V0UmVnaXN0cnlTdGF0cywgZW5zdXJlU3R5bGVTaGVldCB9KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBzaGVldCA9IGVuc3VyZVN0eWxlU2hlZXQoKTtcbiAgICAgICAgICAgIGNvbnN0IHN0YXRzID0gZ2V0UmVnaXN0cnlTdGF0cygpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ0NTUyBSZWdpc3RyeTonLCBzdGF0cyk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnU3R5bGVTaGVldCBleGlzdHM6JywgISFzaGVldCk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnQWRvcHRlZCBzaGVldHM6JywgZG9jdW1lbnQuYWRvcHRlZFN0eWxlU2hlZXRzPy5sZW5ndGggfHwgMCk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnQ1NTIHJ1bGVzIGluIHNoZWV0OicsIHNoZWV0Py5jc3NSdWxlcz8ubGVuZ3RoIHx8IDApO1xuICAgICAgICB9KS5jYXRjaChlID0+IGNvbnNvbGUuZXJyb3IoJ0NTUyBSZWdpc3RyeSBlcnJvcjonLCBlKSksXG5cbiAgICAgICAgaW1wb3J0KCcuL09QRlNDYWNoZScpLnRoZW4oKHsgaXNPUEZTU3VwcG9ydGVkLCBnZXRDYWNoZVN0YXRzIH0pID0+IHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdPUEZTIHN1cHBvcnRlZDonLCBpc09QRlNTdXBwb3J0ZWQoKSk7XG4gICAgICAgICAgICByZXR1cm4gZ2V0Q2FjaGVTdGF0cygpLnRoZW4oc3RhdHMgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdPUEZTIGNhY2hlIHN0YXRzOicsIHN0YXRzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KS5jYXRjaChlID0+IGNvbnNvbGUuZXJyb3IoJ09QRlMgY2hlY2sgZXJyb3I6JywgZSkpXG4gICAgXSkuY2F0Y2goKCkgPT4gey8qIGlnbm9yZSAqL30pO1xuXG4gICAgLy8gQ2hlY2sgbmV0d29yayBzdGF0dXNcbiAgICBjb25zb2xlLmxvZygnTmV0d29yayBvbmxpbmU6JywgbmF2aWdhdG9yLm9uTGluZSk7XG4gICAgY29uc29sZS5sb2coJ1Nsb3cgY29ubmVjdGlvbjonLCBpc1Nsb3dDb25uZWN0aW9uKCkpO1xuXG4gICAgY29uc29sZS5ncm91cEVuZCgpO1xufTtcbiJdfQ==