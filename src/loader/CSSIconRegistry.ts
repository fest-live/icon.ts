/**
 * CSS-based Icon Registry
 *
 * Instead of caching URLs in JavaScript Maps and setting inline styles,
 * this registry manages a shared stylesheet with attribute-based selectors
 * and image-set() for resolution-aware icon loading.
 *
 * CSS rules are generated lazily when icons are first requested.
 * Multiple icon instances share the same CSS rule automatically.
 */

// Constants inlined to avoid circular dependency with Loader.ts
const MAX_RASTER_SIZE = 512;
const MIN_RASTER_SIZE = 32;

// Icon style element reference
let iconStyleSheet: CSSStyleSheet | null = null;
let styleElement: HTMLStyleElement | null = null;

// Track which icon+style+bucket combinations have rules
const registeredRules = new Set<string>();

// Pending rule insertions (batched for performance)
let pendingRules: Array<{ selector: string; cssText: string; key: string }> = [];
let flushScheduled = false;

/**
 * Gets or creates the shared icon stylesheet
 */
export const ensureStyleSheet = (): CSSStyleSheet | null => {
    if (iconStyleSheet) return iconStyleSheet as CSSStyleSheet;
    if (typeof document === "undefined") return null;

    // Check for existing style element
    /*styleElement = document.querySelector<HTMLStyleElement>("style[data-icon-registry]");

    if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.setAttribute("data-icon-registry", "true");
        // Insert early in head for lower specificity
        const head = document.head || document.documentElement;
        head.insertBefore(styleElement, head.firstChild);
    }*/

    iconStyleSheet = new CSSStyleSheet() as CSSStyleSheet;//styleElement.sheet;
    document.adoptedStyleSheets?.push?.((iconStyleSheet as unknown as CSSStyleSheet));

    //
    iconStyleSheet.insertRule(`@property --icon-image { syntax: "<image>"; inherits: true; initial-value: linear-gradient(#0000, #0000); }`, iconStyleSheet.cssRules.length);
    iconStyleSheet.insertRule(`:where(ui-icon), :host(ui-icon) { --icon-image: linear-gradient(#0000, #0000); }`, iconStyleSheet.cssRules.length);
    iconStyleSheet.insertRule(`:where(ui-icon:not([icon])), :where(ui-icon[icon=""]), :host(ui-icon:not([icon])), :host(ui-icon[icon=""]) { background-color: transparent; }`, iconStyleSheet.cssRules.length);
    return iconStyleSheet as CSSStyleSheet;
};

/**
 * Generates the CSS rule key for deduplication
 */
const makeRuleKey = (iconName: string, iconStyle: string, bucket: number): string => {
    return `${iconStyle}:${iconName}@${bucket}`;
};

/**
 * Creates image-set value for different resolutions
 * Uses the resolved URL with appropriate resolution descriptors
 */
const createImageSetCSS = (
    url: string,
    bucket: number,
): string => {
    if (!url) return "linear-gradient(#0000, #0000)";

    // Build image-set with 1x and 2x variants
    // The browser will pick the best resolution based on device pixel ratio
    /*const parts: string[] = [];

    // Base resolution
    parts.push((url.startsWith("url(") ? url : `url("${url}")`) + " 1x");

    // Higher density hint (same URL, browser handles scaling)
    if (bucket <= MAX_RASTER_SIZE / 2) {
        parts.push((url.startsWith("url(") ? url : `url("${url}")`) + " 2x");
    }

    return `image-set(${parts.join(", ")})`;*/
    return (url.startsWith("url(") ? url : `url("${url}")`);
};

/**
 * Generates the CSS selector for an icon
 * Uses attribute selectors for icon name and style
 */
const makeSelector = (iconName: string, iconStyle: string): string => {
    // Escape special characters in attribute values
    const escapedName = CSS.escape(iconName);
    const escapedStyle = CSS.escape(iconStyle) || "duotone";

    return `ui-icon[icon="${escapedName}"][icon-style="${escapedStyle}"], :host(ui-icon[icon="${escapedName}"][icon-style="${escapedStyle}"])`;
};

/**
 * Flushes pending CSS rules in a single batch
 */
const flushPendingRules = () => {
    flushScheduled = false;
    if (pendingRules.length === 0) return;

    const sheet = ensureStyleSheet();
    if (!sheet) {
        // Retry later if document not ready
        pendingRules = [];
        return;
    }

    const rulesToInsert = pendingRules.slice();
    pendingRules = [];

    for (const { selector, cssText, key } of rulesToInsert) {
        if (registeredRules.has(key)) continue;

        try {
            const ruleText = `${selector} { ${cssText} }`;
            sheet.insertRule(ruleText, sheet.cssRules.length);
            registeredRules.add(key);
        } catch (e) {
            if (typeof console !== "undefined") {
                console.warn?.("[icon-registry] Failed to insert rule:", e);
            }
        }
    }
};

/**
 * Schedules a batch flush of pending rules
 */
const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flushPendingRules);
};

/**
 * Registers an icon rule in the stylesheet
 * Rules are batched and deduplicated automatically
 */
export const registerIconRule = (
    iconName: string,
    iconStyle: string,
    imageUrl: string,
    bucket: number = MIN_RASTER_SIZE,
): void => {
    const key = makeRuleKey(iconName, iconStyle, bucket);

    // Skip if already registered
    if (registeredRules.has(key)) return;

    // Skip if already pending
    if (pendingRules.some(r => r.key === key)) return;

    const selector = makeSelector(iconName, iconStyle);
    const imageSetValue = createImageSetCSS(imageUrl, bucket);

    // Queue the rule for batch insertion
    pendingRules.push({
        selector,
        cssText: `--icon-image: ${imageSetValue};`,
        key,
    });

    scheduleFlush();
};

/**
 * Registers multiple bucket sizes for an icon
 * Useful for responsive icons that need different resolutions
 */
export const registerIconRuleWithBuckets = (
    iconName: string,
    iconStyle: string,
    imageUrl: string,
    buckets: number[] = [32, 64, 128, 256],
): void => {
    for (const bucket of buckets) {
        registerIconRule(iconName, iconStyle, imageUrl, bucket);
    }
};

/**
 * Checks if an icon rule is already registered
 */
export const hasIconRule = (
    iconName: string,
    iconStyle: string,
    bucket: number = MIN_RASTER_SIZE,
): boolean => {
    const key = makeRuleKey(iconName, iconStyle, bucket);
    return registeredRules.has(key) || pendingRules.some(r => r.key === key);
};

/**
 * Generates a container query based rule for bucket sizing
 * This allows icons to automatically use the right resolution based on their size
 */
export const registerResponsiveIconRule = (
    iconName: string,
    iconStyle: string,
    baseUrl: string,
    bucketUrls: Map<number, string>,
): void => {
    const selector = makeSelector(iconName, iconStyle);

    // Register base rule
    registerIconRule(iconName, iconStyle, baseUrl, MIN_RASTER_SIZE);

    // Add container-query based rules for different sizes
    // Note: This requires the icon container to have container-type set
    for (const [bucket, url] of bucketUrls) {
        const key = `${makeRuleKey(iconName, iconStyle, bucket)}-cq`;
        if (registeredRules.has(key)) continue;

        const sheet = ensureStyleSheet();
        if (!sheet) continue;

        try {
            // Use @container query for responsive sizing (logical property)
            const cqRule = `
                @container (min-inline-size: ${bucket}px) {
                    ${selector} {
                        --icon-image: ${createImageSetCSS(url, bucket)};
                    }
                }
            `;
            sheet.insertRule(cqRule, sheet.cssRules.length);
            registeredRules.add(key);
        } catch {
            // Container queries might not be supported
        }
    }
};

/**
 * Clears all registered icon rules
 * Useful for hot reload or cache invalidation
 */
export const clearIconRules = (): void => {
    registeredRules.clear();
    pendingRules = [];

    if (styleElement?.sheet) {
        // Remove all rules
        const sheet = styleElement.sheet;
        while (sheet.cssRules.length > 0) {
            sheet.deleteRule(0);
        }
    }
};

/**
 * Gets statistics about registered rules
 */
export const getRegistryStats = (): {
    ruleCount: number;
    pendingCount: number;
    hasStyleSheet: boolean;
} => {
    return {
        ruleCount: registeredRules.size,
        pendingCount: pendingRules.length,
        hasStyleSheet: iconStyleSheet !== null,
    };
};

/**
 * Pre-registers common icon styles to reduce layout shifts
 * Call this early in app initialization if you know which icons will be used
 */
export const preregisterIcons = (
    icons: Array<{ name: string; style: string; url: string }>,
): void => {
    for (const { name, style, url } of icons) {
        registerIconRule(name, style, url);
    }
};
