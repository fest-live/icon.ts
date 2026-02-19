/**
 * OPFS (Origin Private File System) Icon Cache
 *
 * Provides persistent caching for:
 * - Vector SVG icon files (reduces network fetches)
 * - Rasterized mask images (reduces canvas operations)
 */

const CACHE_VERSION = 2; // Increment to invalidate old caches
const ROOT_DIR_NAME = "icon-cache";
const VECTOR_DIR = "vector";
const RASTER_DIR = "raster";
const META_FILE = ".cache-meta.json";
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

type CacheMeta = {
    version: number;
    created: number;
    lastAccess: number;
};

let rootHandle: FileSystemDirectoryHandle | null = null;
let vectorDirHandle: FileSystemDirectoryHandle | null = null;
let rasterDirHandle: FileSystemDirectoryHandle | null = null;
let isSupported: boolean | null = null;
let initPromise: Promise<boolean> | null = null;

/**
 * Checks if OPFS is supported in current environment
 */
export const isOPFSSupported = (): boolean => {
    if (isSupported !== null) return isSupported;

    try {
        isSupported = !!(
            typeof navigator !== "undefined" &&
            "storage" in navigator &&
            typeof navigator.storage?.getDirectory === "function" &&
            typeof FileSystemFileHandle !== "undefined" &&
            typeof FileSystemDirectoryHandle !== "undefined"
        );
    } catch {
        isSupported = false;
    }

    return isSupported;
};

/**
 * Sanitizes a cache key to be a valid filename
 */
const sanitizeKey = (key: string): string => {
    if (!key || typeof key !== "string") return "_empty_";
    return key
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\.{2,}/g, "_")
        .replace(/^\./, "_")
        .slice(0, 200);
};

/**
 * Initializes the OPFS cache directories
 */
export const initOPFSCache = async (): Promise<boolean> => {
    if (initPromise) return initPromise;

    initPromise = (async (): Promise<boolean> => {
        if (!isOPFSSupported()) return false;

        try {
            const storageRoot = await navigator.storage.getDirectory();
            rootHandle = await storageRoot.getDirectoryHandle(ROOT_DIR_NAME, { create: true });

            // Check cache version and clear if outdated
            const meta = await readCacheMeta();
            const now = Date.now();

            if (meta && meta.version !== CACHE_VERSION) {
                if (typeof console !== "undefined") {
                    console.log?.("[icon-cache] Cache version mismatch, clearing cache");
                }
                await clearAllCache();
            } else if (meta && (now - meta.lastAccess) > MAX_CACHE_AGE_MS) {
                if (typeof console !== "undefined") {
                    console.log?.("[icon-cache] Cache expired, clearing cache");
                }
                await clearAllCache();
            } else {
                // Check cache size and clean up if too large
                const stats = await getCacheStats();
                if (stats && stats.totalSize > MAX_CACHE_SIZE_BYTES) {
                    if (typeof console !== "undefined") {
                        console.log?.("[icon-cache] Cache size exceeded, clearing cache");
                    }
                    await clearAllCache();
                }
            }

            // Create/get subdirectories
            vectorDirHandle = await rootHandle.getDirectoryHandle(VECTOR_DIR, { create: true });
            rasterDirHandle = await rootHandle.getDirectoryHandle(RASTER_DIR, { create: true });

            // Write/update metadata
            await writeCacheMeta();

            return true;
        } catch (error) {
            if (typeof console !== "undefined") {
                console.warn?.("[icon-cache] OPFS init failed:", error);
            }
            rootHandle = null;
            vectorDirHandle = null;
            rasterDirHandle = null;
            return false;
        }
    })();

    return initPromise;
};

/**
 * Reads cache metadata
 */
const readCacheMeta = async (): Promise<CacheMeta | null> => {
    if (!rootHandle) return null;

    try {
        const fileHandle = await rootHandle.getFileHandle(META_FILE);
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text) as CacheMeta;
    } catch {
        return null;
    }
};

/**
 * Writes cache metadata
 */
const writeCacheMeta = async (): Promise<void> => {
    if (!rootHandle) return;

    try {
        const fileHandle = await rootHandle.getFileHandle(META_FILE, { create: true });
        const writable = await fileHandle.createWritable();
        const meta: CacheMeta = {
            version: CACHE_VERSION,
            created: Date.now(),
            lastAccess: Date.now(),
        };
        await writable.write(JSON.stringify(meta));
        await writable.close();
    } catch {
        /* silently fail */
    }
};

/**
 * Stores a vector (SVG) icon in cache
 */
export const cacheVectorIcon = async (key: string, svgContent: string | Blob): Promise<boolean> => {
    if (!vectorDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !vectorDirHandle) return false;
    }

    try {
        const filename = sanitizeKey(key) + ".svg";
        const fileHandle = await vectorDirHandle!.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();

        if (svgContent instanceof Blob) {
            await writable.write(svgContent);
        } else {
            await writable.write(new Blob([svgContent], { type: "image/svg+xml" }));
        }

        await writable.close();
        return true;
    } catch (error) {
        if (typeof console !== "undefined") {
            console.warn?.("[icon-cache] Failed to cache vector:", key, error);
        }
        return false;
    }
};

/**
 * Retrieves a vector (SVG) icon from cache
 * Returns blob URL if found, null otherwise
 */
export const getCachedVectorIcon = async (key: string): Promise<string | null> => {
    if (!vectorDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !vectorDirHandle) return null;
    }

    try {
        const filename = sanitizeKey(key) + ".svg";
        const fileHandle = await vectorDirHandle!.getFileHandle(filename);
        const file = await fileHandle.getFile();
        return URL.createObjectURL(file);
    } catch {
        return null;
    }
};

/**
 * Checks if a vector icon exists in cache
 */
export const hasVectorIcon = async (key: string): Promise<boolean> => {
    if (!vectorDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !vectorDirHandle) return false;
    }

    try {
        const filename = sanitizeKey(key) + ".svg";
        await vectorDirHandle!.getFileHandle(filename);
        return true;
    } catch {
        return false;
    }
};

/**
 * Stores a rasterized icon (PNG blob) in cache
 */
export const cacheRasterIcon = async (key: string, bucket: number, blob: Blob): Promise<boolean> => {
    if (!rasterDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !rasterDirHandle) return false;
    }

    try {
        const filename = `${sanitizeKey(key)}@${bucket}.png`;
        const fileHandle = await rasterDirHandle!.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    } catch (error) {
        if (typeof console !== "undefined") {
            console.warn?.("[icon-cache] Failed to cache raster:", key, error);
        }
        return false;
    }
};

/**
 * Retrieves a rasterized icon from cache
 * Returns blob URL if found, null otherwise
 */
export const getCachedRasterIcon = async (key: string, bucket: number): Promise<string | null> => {
    if (!rasterDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !rasterDirHandle) return null;
    }

    try {
        const filename = `${sanitizeKey(key)}@${bucket}.png`;
        const fileHandle = await rasterDirHandle!.getFileHandle(filename);
        const file = await fileHandle.getFile();
        return URL.createObjectURL(file);
    } catch {
        return null;
    }
};

/**
 * Checks if a raster icon exists in cache
 */
export const hasRasterIcon = async (key: string, bucket: number): Promise<boolean> => {
    if (!rasterDirHandle) {
        const ready = await initOPFSCache();
        if (!ready || !rasterDirHandle) return false;
    }

    try {
        const filename = `${sanitizeKey(key)}@${bucket}.png`;
        await rasterDirHandle!.getFileHandle(filename);
        return true;
    } catch {
        return false;
    }
};

/**
 * Removes a specific vector icon from cache
 */
export const removeVectorIcon = async (key: string): Promise<boolean> => {
    if (!vectorDirHandle) return false;

    try {
        const filename = sanitizeKey(key) + ".svg";
        await vectorDirHandle.removeEntry(filename);
        return true;
    } catch {
        return false;
    }
};

/**
 * Removes a specific raster icon from cache
 */
export const removeRasterIcon = async (key: string, bucket: number): Promise<boolean> => {
    if (!rasterDirHandle) return false;

    try {
        const filename = `${sanitizeKey(key)}@${bucket}.png`;
        await rasterDirHandle.removeEntry(filename);
        return true;
    } catch {
        return false;
    }
};

/**
 * Clears all cached icons
 */
export const clearAllCache = async (): Promise<void> => {
    if (!rootHandle) {
        const ready = await initOPFSCache();
        if (!ready || !rootHandle) return;
    }

    try {
        // Remove subdirectories recursively
        for await (const [name] of (rootHandle as any).entries()) {
            if (name !== META_FILE) {
                await rootHandle!.removeEntry(name, { recursive: true });
            }
        }

        // Reset handles
        vectorDirHandle = null;
        rasterDirHandle = null;

        // Reinitialize
        initPromise = null;
        await initOPFSCache();
    } catch (error) {
        if (typeof console !== "undefined") {
            console.warn?.("[icon-cache] Failed to clear cache:", error);
        }
    }
};

/**
 * Gets cache statistics
 */
export const getCacheStats = async (): Promise<{
    vectorCount: number;
    rasterCount: number;
    totalSize: number;
} | null> => {
    if (!vectorDirHandle || !rasterDirHandle) {
        const ready = await initOPFSCache();
        if (!ready) return null;
    }

    try {
        let vectorCount = 0;
        let rasterCount = 0;
        let totalSize = 0;

        for await (const [, handle] of (vectorDirHandle as any).entries()) {
            if (handle.kind === "file") {
                vectorCount++;
                const file = await (handle as FileSystemFileHandle).getFile();
                totalSize += file.size;
            }
        }

        for await (const [, handle] of (rasterDirHandle as any).entries()) {
            if (handle.kind === "file") {
                rasterCount++;
                const file = await (handle as FileSystemFileHandle).getFile();
                totalSize += file.size;
            }
        }

        return { vectorCount, rasterCount, totalSize };
    } catch {
        return null;
    }
};

/**
 * Validates and cleans up corrupted cache entries
 */
export const validateAndCleanCache = async (): Promise<void> => {
    if (!vectorDirHandle || !rasterDirHandle) {
        const ready = await initOPFSCache();
        if (!ready) return;
    }

    const corruptedKeys: string[] = [];

    try {
        // Check vector icons
        for await (const [name, handle] of (vectorDirHandle as any).entries()) {
            if (handle.kind === "file" && name.endsWith('.svg')) {
                try {
                    const file = await (handle as FileSystemFileHandle).getFile();
                    // Basic validation - check if file has content and starts with SVG tag
                    if (file.size === 0) {
                        corruptedKeys.push(`vector:${name}`);
                        continue;
                    }

                    const text = await file.text();
                    if (!text.trim().startsWith('<svg')) {
                        corruptedKeys.push(`vector:${name}`);
                    }
                } catch {
                    corruptedKeys.push(`vector:${name}`);
                }
            }
        }

        // Check raster icons
        for await (const [name, handle] of (rasterDirHandle as any).entries()) {
            if (handle.kind === "file" && (name.endsWith('.png') || name.endsWith('.webp'))) {
                try {
                    const file = await (handle as FileSystemFileHandle).getFile();
                    if (file.size === 0) {
                        corruptedKeys.push(`raster:${name}`);
                    }
                } catch {
                    corruptedKeys.push(`raster:${name}`);
                }
            }
        }

        // Remove corrupted entries
        for (const key of corruptedKeys) {
            try {
                const [type, filename] = key.split(':');
                if (type === 'vector' && vectorDirHandle) {
                    await vectorDirHandle.removeEntry(filename);
                } else if (type === 'raster' && rasterDirHandle) {
                    await rasterDirHandle.removeEntry(filename);
                }
            } catch {
                /* ignore removal errors */
            }
        }

        if (corruptedKeys.length > 0 && typeof console !== "undefined") {
            console.log?.(`[icon-cache] Cleaned up ${corruptedKeys.length} corrupted cache entries`);
        }
    } catch (error) {
        if (typeof console !== "undefined") {
            console.warn?.("[icon-cache] Cache validation failed:", error);
        }
    }
};

/**
 * Pre-initializes cache on module load (non-blocking)
 */
if (isOPFSSupported()) {
    initOPFSCache().then(() => {
        // Validate cache after initialization
        validateAndCleanCache().catch(() => {
            /* silent validation failure */
        });
    }).catch(() => {
        /* silent init failure */
    });
}

