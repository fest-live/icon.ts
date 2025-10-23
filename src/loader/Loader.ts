
//
//import * as icons from "lucide";
export const iconMap = new Map<string, Promise<string>>();
export const maskCache = new Map<string, string>();

export const rasterPromiseCache = new Map<string, Promise<string>>();
export const imageElementCache = new Map<string, Promise<HTMLImageElement>>();
export const MAX_RASTER_SIZE = 512;
export const MIN_RASTER_SIZE = 32;

export type DevicePixelSize = { inline: number; block: number };

export const fallbackMaskValue = (url: string) => (!url ? "none" : `url("${url}")`);

export const quantizeToBucket = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) { value = MIN_RASTER_SIZE; }
    const safe = Math.max(value, MIN_RASTER_SIZE);
    const bucket = 2 ** Math.ceil(Math.log2(safe));
    return Math.min(MAX_RASTER_SIZE, bucket);
};

export const loadImageElement = (url: string): Promise<HTMLImageElement> => {
    if (!url) { return Promise.reject(new Error("Invalid icon URL")); }
    if (!imageElementCache.has(url)) {
        const promise = new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            try { img.decoding = "async"; } catch (_) { /* noop */ }
            try { img.crossOrigin = "anonymous"; } catch (_) { /* noop */ }
            img.onload = () => resolve(img);
            img.onerror = (_event) => reject(new Error(`Failed to load icon: ${url}`));
            img.src = new URL(url, location.origin)?.href ?? url;
        }).then(async (img) => {
            if (typeof img.decode === "function") {
                try { await img.decode(); } catch (_) { /* ignore decode errors */ }
            }
            return img;
        });
        imageElementCache.set(url, promise);
    }
    return imageElementCache.get(url)!;
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

export const rasterizeSvgToMask = async (url: string, bucket: number): Promise<string> => {
    const img = await loadImageElement(url);
    const size = Math.max(bucket, MIN_RASTER_SIZE);
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

    const rasterUrl = await canvasToImageUrl(canvas);
    return fallbackMaskValue(rasterUrl);
};

export const ensureMaskValue = (url: string, cacheKey: string, bucket: number): Promise<string> => {
    const safeUrl = url || "";
    const key = `${cacheKey}@${bucket}`;
    const cached = maskCache.get(key);
    if (cached) { return Promise.resolve(cached); }
    const pending = rasterPromiseCache.get(key);
    if (pending) { return pending; }

    const promise = rasterizeSvgToMask(safeUrl, bucket)
        .then((maskValue) => {
            maskCache.set(key, maskValue);
            rasterPromiseCache.delete(key);
            return maskValue;
        })
        .catch((error) => {
            rasterPromiseCache.delete(key);
            const fallback = fallbackMaskValue(safeUrl);
            if (safeUrl && typeof console !== "undefined") {
                console.warn?.("[ui-icon] Rasterization failed, using SVG mask", error);
            }
            maskCache.set(key, fallback);
            return fallback;
        });

    rasterPromiseCache.set(key, promise);
    return promise;
};

//
export const isPathURL = (url: string)=>{ return URL.canParse(url, location.origin) || URL.canParse(url, "localhost"); }
export const rasterizeSVG = (blob)=>{ return isPathURL(blob) ? blob : URL.createObjectURL(blob); }
export const loadAsImage  = async (name: any, creator?: (name: any)=>any)=>{
    if (isPathURL(name)) { return name; }
    // @ts-ignore // !experimental `getOrInsert` feature!
    return iconMap.getOrInsertComputed(name, async ()=>{
        const element = await (creator ? creator?.(name) : name);
        if (isPathURL(element)) { return element; }
        let file: any = name;
        if (element instanceof Blob || element instanceof File) { file = element; }
        else { const text = typeof element == "string" ? element : element.outerHTML; file = new Blob([`<?xml version=\"1.0\" encoding=\"UTF-8\"?>`, text], { type: "image/svg+xml" }); }
        return rasterizeSVG(file);
    });
};
