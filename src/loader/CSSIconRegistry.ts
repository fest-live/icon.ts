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

// Store actual rule data for persistence across refreshes
const registeredRuleData = new Map<string, { selector: string; cssText: string }>();

// Persistent registry storage - survives page refreshes via localStorage
const PERSISTENT_REGISTRY_KEY = 'ui-icon-registry-state.v2';
const LEGACY_PERSISTENT_KEYS = ['ui-icon-registry-state'];

const extractFirstCssUrl = (cssText: string): string | null => {
    if (!cssText || typeof cssText !== "string") return null;
    const match = cssText.match(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/i);
    return match?.[2] ?? null;
};

const isPersistableRuleCssText = (cssText: string): boolean => {
    const url = extractFirstCssUrl(cssText);
    if (!url) { return false; }

    // blob: URLs are not stable across refreshes
    if (/^blob:/i.test(url)) { return false; }

    // data: URLs are safe to persist
    if (/^data:/i.test(url)) { return true; }

    // For http(s), only persist if same-origin (cross-origin will trigger CORS issues in CSS fetch)
    if (/^https?:/i.test(url)) {
        try {
            if (typeof location !== "undefined" && typeof URL === "function") {
                return new URL(url).origin === location.origin;
            }
        } catch {
            return false;
        }
        return false;
    }

    // Relative/same-origin paths are OK
    return true;
};

// Pending rule insertions (batched for performance)
let pendingRules: Array<{ selector: string; cssText: string; key: string }> = [];
let flushScheduled = false;

const ICON_PROXY_PATH = "/api/icon-proxy";
const isChromeExtensionRuntime = (): boolean => {
    try {
        const chromeRuntime = (globalThis as any)?.chrome?.runtime;
        return !!chromeRuntime?.id;
    } catch {
        return false;
    }
};

const tryRewriteCrossOriginUrlToProxy = (rawUrl: string): string | null => {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    // data/blob are already safe in CSS.
    if (/^(data:|blob:)/i.test(trimmed)) return trimmed;

    // Relative URLs are same-origin.
    if (/^(\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed;

    // Only rewrite absolute cross-origin URLs.
    if (!/^https?:/i.test(trimmed)) return trimmed;

    // In extension runtimes (popup/options/content-script), don't rewrite to /api.
    // Such endpoint is app-specific and usually unavailable there.
    if (isChromeExtensionRuntime()) return trimmed;

    try {
        if (typeof location === "undefined" || typeof URL !== "function") return trimmed;
        const u = new URL(trimmed);
        if (u.origin === location.origin) return trimmed;
        return `${ICON_PROXY_PATH}?url=${encodeURIComponent(trimmed)}`;
    } catch {
        return null;
    }
};

const rewriteCssUrlFunctionValue = (cssValue: string): string | null => {
    if (!cssValue || typeof cssValue !== "string") return null;
    const match = cssValue.match(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/i);
    if (!match) return cssValue;
    const rewritten = tryRewriteCrossOriginUrlToProxy(match[2]);
    if (!rewritten) return null;
    return `url("${rewritten}")`;
};

/**
 * Saves the registry state to localStorage for persistence across refreshes
 */
const saveRegistryState = (): void => {
    if (typeof localStorage === 'undefined') return;

    try {
        const ruleData = Array.from(registeredRuleData.entries())
            .filter(([, data]) => isPersistableRuleCssText(data.cssText))
            .map(([key, data]) => ({
                key,
                selector: data.selector,
                cssText: data.cssText
            }));

        const state = {
            rules: ruleData,
            timestamp: Date.now()
        };
        localStorage.setItem(PERSISTENT_REGISTRY_KEY, JSON.stringify(state));
    } catch {
        // Ignore localStorage errors
    }
};

// Store pending rule restorations until stylesheet is available
let pendingRuleRestorations: Array<{ key: string; selector: string; cssText: string }> | null = null;

/**
 * Loads the registry state from localStorage and prepares rules for restoration
 */
const loadRegistryState = (): void => {
    if (typeof localStorage === 'undefined') return;

    try {
        // Clean legacy keys eagerly to avoid restoring unsafe old rules.
        for (const legacyKey of LEGACY_PERSISTENT_KEYS) {
            if (legacyKey !== PERSISTENT_REGISTRY_KEY) {
                try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
            }
        }

        const stored = localStorage.getItem(PERSISTENT_REGISTRY_KEY);
        if (!stored) return;

        const state = JSON.parse(stored);
        if (state.rules && Array.isArray(state.rules)) {
            // Only restore rules from the last 24 hours to avoid stale data
            const age = Date.now() - (state.timestamp || 0);
            if (age < 24 * 60 * 60 * 1000) {
                // Store for later restoration when stylesheet is available
                pendingRuleRestorations = state.rules.filter((r: any) => isPersistableRuleCssText(r?.cssText));
                if (typeof console !== 'undefined') {
                    console.log?.(`[icon-registry] Prepared ${pendingRuleRestorations.length} rules for restoration from cache`);
                }
            } else {
                // Clear expired state
                localStorage.removeItem(PERSISTENT_REGISTRY_KEY);
            }
        }
    } catch {
        // Ignore localStorage errors
    }
};

/**
 * Restores pending rules to the stylesheet when it becomes available
 */
const restorePendingRules = (sheet: CSSStyleSheet): void => {
    if (!pendingRuleRestorations) return;

    let restoredCount = 0;
    let skippedCount = 0;
    pendingRuleRestorations.forEach((ruleData) => {
        if (ruleData.key && ruleData.selector && ruleData.cssText && !registeredRules.has(ruleData.key)) {
            if (!isPersistableRuleCssText(ruleData.cssText)) {
                skippedCount++;
                return;
            }
            try {
                // Re-insert the rule into the stylesheet
                const ruleText = `${ruleData.selector} { ${ruleData.cssText} }`;
                sheet.insertRule(ruleText, sheet.cssRules.length);

                // Restore the tracking data
                registeredRules.add(ruleData.key);
                registeredRuleData.set(ruleData.key, {
                    selector: ruleData.selector,
                    cssText: ruleData.cssText
                });
                restoredCount++;
            } catch (e) {
                if (typeof console !== 'undefined') {
                    console.warn?.(`[icon-registry] Failed to restore rule ${ruleData.key}:`, e);
                }
            }
        }
    });

    if (typeof console !== 'undefined' && (restoredCount > 0 || skippedCount > 0)) {
        console.log?.(`[icon-registry] Restored ${restoredCount} CSS rules to stylesheet (skipped ${skippedCount} unsafe/unstable rules)`);
    }

    pendingRuleRestorations = null; // Clear after restoration
};

/**
 * Clears the persistent registry state
 */
export const clearRegistryState = (): void => {
    registeredRules.clear();
    registeredRuleData.clear();
    pendingRules.length = 0;
    flushScheduled = false;

    // Reset stylesheet
    if (iconStyleSheet && document.adoptedStyleSheets) {
        const index = document.adoptedStyleSheets.indexOf(iconStyleSheet as CSSStyleSheet);
        if (index !== -1) {
            document.adoptedStyleSheets.splice(index, 1);
        }
    }
    iconStyleSheet = null;
    styleElement = null;

    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(PERSISTENT_REGISTRY_KEY);
    }

    if (typeof console !== 'undefined') {
        console.log?.('[icon-registry] Registry state cleared');
    }
};

/**
 * Reinitializes the registry - useful for page refreshes or when needing to reload all rules
 */
export const reinitializeRegistry = (): void => {
    clearRegistryState();
    ensureStyleSheet();

    if (typeof console !== 'undefined') {
        console.log?.('[icon-registry] Registry reinitialized');
    }
};

/**
 * Gets or creates the shared icon stylesheet
 */
export const ensureStyleSheet = (): CSSStyleSheet | null => {
    if (iconStyleSheet) return iconStyleSheet as CSSStyleSheet;
    if (typeof document === "undefined") return null;

    // Load persistent registry state on first access
    if (registeredRules.size === 0) {
        loadRegistryState();
    }

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

    // Restore any pending rules from localStorage
    restorePendingRules(iconStyleSheet);

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
    // Ensure the CSS doesn't directly reference cross-origin https://... URLs,
    // because CSS fetches are credentialed and many CDNs respond with ACAO="*".
    if (url.startsWith("url(")) {
        return rewriteCssUrlFunctionValue(url) ?? "linear-gradient(#0000, #0000)";
    }
    const rewritten = tryRewriteCrossOriginUrlToProxy(url);
    return rewritten ? `url("${rewritten}")` : "linear-gradient(#0000, #0000)";
};

/**
 * Generates the CSS selector for an icon
 * Uses attribute selectors for icon name and style
 */
const makeSelector = (iconName: string, iconStyle: string): string => {
    // Validate and sanitize inputs
    const safeName = (iconName || '').trim();
    const safeStyle = (iconStyle || 'duotone').trim().toLowerCase();

    if (!safeName) {
        return ''; // Invalid selector
    }

    // Escape special characters in attribute values
    const escapedName = CSS.escape(safeName);
    const escapedStyle = CSS.escape(safeStyle);

    // Match both class selector (.ui-icon) and :host selector for shadow DOM
    return `.ui-icon[icon="${escapedName}"][icon-style="${escapedStyle}"], :host(.ui-icon[icon="${escapedName}"][icon-style="${escapedStyle}"])`;
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

            // Store the rule data for persistence
            registeredRuleData.set(key, { selector, cssText });

            // Save registry state after successful rule insertion
            saveRegistryState();
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

/**
 * Pre-initializes registry on module load (non-blocking)
 */
if (typeof document !== "undefined" && typeof window !== "undefined") {
    // Load persisted state immediately (doesn't require DOM)
    loadRegistryState();

    // Initialize stylesheet on next tick to ensure DOM is ready
    queueMicrotask(() => {
        ensureStyleSheet();

        // Listen for page visibility changes to reinitialize if needed
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && !iconStyleSheet) {
                // Page became visible and we don't have a stylesheet - reinitialize
                reinitializeRegistry();
            }
        });

        // Also reinitialize on focus to handle tab switching
        window.addEventListener('focus', () => {
            if (!iconStyleSheet) {
                reinitializeRegistry();
            }
        });
    });
}
