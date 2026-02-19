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
let iconStyleSheet = null;
let styleElement = null;
// Track which icon+style+bucket combinations have rules
const registeredRules = new Set();
// Store actual rule data for persistence across refreshes
const registeredRuleData = new Map();
// Persistent registry storage - survives page refreshes via localStorage
const PERSISTENT_REGISTRY_KEY = 'ui-icon-registry-state.v2';
const LEGACY_PERSISTENT_KEYS = ['ui-icon-registry-state'];
const extractFirstCssUrl = (cssText) => {
    if (!cssText || typeof cssText !== "string")
        return null;
    const match = cssText.match(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/i);
    return match?.[2] ?? null;
};
const isPersistableRuleCssText = (cssText) => {
    const url = extractFirstCssUrl(cssText);
    if (!url) {
        return false;
    }
    // blob: URLs are not stable across refreshes
    if (/^blob:/i.test(url)) {
        return false;
    }
    // data: URLs are safe to persist
    if (/^data:/i.test(url)) {
        return true;
    }
    // For http(s), only persist if same-origin (cross-origin will trigger CORS issues in CSS fetch)
    if (/^https?:/i.test(url)) {
        try {
            if (typeof location !== "undefined" && typeof URL === "function") {
                return new URL(url).origin === location.origin;
            }
        }
        catch {
            return false;
        }
        return false;
    }
    // Relative/same-origin paths are OK
    return true;
};
// Pending rule insertions (batched for performance)
let pendingRules = [];
let flushScheduled = false;
const ICON_PROXY_PATH = "/api/icon-proxy";
const isChromeExtensionRuntime = () => {
    try {
        const chromeRuntime = globalThis?.chrome?.runtime;
        return !!chromeRuntime?.id;
    }
    catch {
        return false;
    }
};
const tryRewriteCrossOriginUrlToProxy = (rawUrl) => {
    if (!rawUrl || typeof rawUrl !== "string")
        return null;
    const trimmed = rawUrl.trim();
    if (!trimmed)
        return null;
    // data/blob are already safe in CSS.
    if (/^(data:|blob:)/i.test(trimmed))
        return trimmed;
    // Relative URLs are same-origin.
    if (/^(\/|\.\/|\.\.\/)/.test(trimmed))
        return trimmed;
    // Only rewrite absolute cross-origin URLs.
    if (!/^https?:/i.test(trimmed))
        return trimmed;
    // In extension runtimes (popup/options/content-script), don't rewrite to /api.
    // Such endpoint is app-specific and usually unavailable there.
    if (isChromeExtensionRuntime())
        return trimmed;
    try {
        if (typeof location === "undefined" || typeof URL !== "function")
            return trimmed;
        const u = new URL(trimmed);
        if (u.origin === location.origin)
            return trimmed;
        return `${ICON_PROXY_PATH}?url=${encodeURIComponent(trimmed)}`;
    }
    catch {
        return null;
    }
};
const rewriteCssUrlFunctionValue = (cssValue) => {
    if (!cssValue || typeof cssValue !== "string")
        return null;
    const match = cssValue.match(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/i);
    if (!match)
        return cssValue;
    const rewritten = tryRewriteCrossOriginUrlToProxy(match[2]);
    if (!rewritten)
        return null;
    return `url("${rewritten}")`;
};
/**
 * Saves the registry state to localStorage for persistence across refreshes
 */
const saveRegistryState = () => {
    if (typeof localStorage === 'undefined')
        return;
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
    }
    catch {
        // Ignore localStorage errors
    }
};
// Store pending rule restorations until stylesheet is available
let pendingRuleRestorations = null;
/**
 * Loads the registry state from localStorage and prepares rules for restoration
 */
const loadRegistryState = () => {
    if (typeof localStorage === 'undefined')
        return;
    try {
        // Clean legacy keys eagerly to avoid restoring unsafe old rules.
        for (const legacyKey of LEGACY_PERSISTENT_KEYS) {
            if (legacyKey !== PERSISTENT_REGISTRY_KEY) {
                try {
                    localStorage.removeItem(legacyKey);
                }
                catch { /* ignore */ }
            }
        }
        const stored = localStorage.getItem(PERSISTENT_REGISTRY_KEY);
        if (!stored)
            return;
        const state = JSON.parse(stored);
        if (state.rules && Array.isArray(state.rules)) {
            // Only restore rules from the last 24 hours to avoid stale data
            const age = Date.now() - (state.timestamp || 0);
            if (age < 24 * 60 * 60 * 1000) {
                // Store for later restoration when stylesheet is available
                pendingRuleRestorations = state.rules.filter((r) => isPersistableRuleCssText(r?.cssText));
                if (typeof console !== 'undefined') {
                    console.log?.(`[icon-registry] Prepared ${pendingRuleRestorations.length} rules for restoration from cache`);
                }
            }
            else {
                // Clear expired state
                localStorage.removeItem(PERSISTENT_REGISTRY_KEY);
            }
        }
    }
    catch {
        // Ignore localStorage errors
    }
};
/**
 * Restores pending rules to the stylesheet when it becomes available
 */
const restorePendingRules = (sheet) => {
    if (!pendingRuleRestorations)
        return;
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
            }
            catch (e) {
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
export const clearRegistryState = () => {
    registeredRules.clear();
    registeredRuleData.clear();
    pendingRules.length = 0;
    flushScheduled = false;
    // Reset stylesheet
    if (iconStyleSheet && document.adoptedStyleSheets) {
        const index = document.adoptedStyleSheets.indexOf(iconStyleSheet);
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
export const reinitializeRegistry = () => {
    clearRegistryState();
    ensureStyleSheet();
    if (typeof console !== 'undefined') {
        console.log?.('[icon-registry] Registry reinitialized');
    }
};
/**
 * Gets or creates the shared icon stylesheet
 */
export const ensureStyleSheet = () => {
    if (iconStyleSheet)
        return iconStyleSheet;
    if (typeof document === "undefined")
        return null;
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
    iconStyleSheet = new CSSStyleSheet(); //styleElement.sheet;
    document.adoptedStyleSheets?.push?.(iconStyleSheet);
    //
    iconStyleSheet.insertRule(`@property --icon-image { syntax: "<image>"; inherits: true; initial-value: linear-gradient(#0000, #0000); }`, iconStyleSheet.cssRules.length);
    iconStyleSheet.insertRule(`:where(ui-icon), :host(ui-icon) { --icon-image: linear-gradient(#0000, #0000); }`, iconStyleSheet.cssRules.length);
    iconStyleSheet.insertRule(`:where(ui-icon:not([icon])), :where(ui-icon[icon=""]), :host(ui-icon:not([icon])), :host(ui-icon[icon=""]) { background-color: transparent; }`, iconStyleSheet.cssRules.length);
    // Restore any pending rules from localStorage
    restorePendingRules(iconStyleSheet);
    return iconStyleSheet;
};
/**
 * Generates the CSS rule key for deduplication
 */
const makeRuleKey = (iconName, iconStyle, bucket) => {
    return `${iconStyle}:${iconName}@${bucket}`;
};
/**
 * Creates image-set value for different resolutions
 * Uses the resolved URL with appropriate resolution descriptors
 */
const createImageSetCSS = (url, bucket) => {
    if (!url)
        return "linear-gradient(#0000, #0000)";
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
const makeSelector = (iconName, iconStyle) => {
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
    if (pendingRules.length === 0)
        return;
    const sheet = ensureStyleSheet();
    if (!sheet) {
        // Retry later if document not ready
        pendingRules = [];
        return;
    }
    const rulesToInsert = pendingRules.slice();
    pendingRules = [];
    for (const { selector, cssText, key } of rulesToInsert) {
        if (registeredRules.has(key))
            continue;
        try {
            const ruleText = `${selector} { ${cssText} }`;
            sheet.insertRule(ruleText, sheet.cssRules.length);
            registeredRules.add(key);
            // Store the rule data for persistence
            registeredRuleData.set(key, { selector, cssText });
            // Save registry state after successful rule insertion
            saveRegistryState();
        }
        catch (e) {
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
    if (flushScheduled)
        return;
    flushScheduled = true;
    queueMicrotask(flushPendingRules);
};
/**
 * Registers an icon rule in the stylesheet
 * Rules are batched and deduplicated automatically
 */
export const registerIconRule = (iconName, iconStyle, imageUrl, bucket = MIN_RASTER_SIZE) => {
    const key = makeRuleKey(iconName, iconStyle, bucket);
    // Skip if already registered
    if (registeredRules.has(key))
        return;
    // Skip if already pending
    if (pendingRules.some(r => r.key === key))
        return;
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
export const registerIconRuleWithBuckets = (iconName, iconStyle, imageUrl, buckets = [32, 64, 128, 256]) => {
    for (const bucket of buckets) {
        registerIconRule(iconName, iconStyle, imageUrl, bucket);
    }
};
/**
 * Checks if an icon rule is already registered
 */
export const hasIconRule = (iconName, iconStyle, bucket = MIN_RASTER_SIZE) => {
    const key = makeRuleKey(iconName, iconStyle, bucket);
    return registeredRules.has(key) || pendingRules.some(r => r.key === key);
};
/**
 * Generates a container query based rule for bucket sizing
 * This allows icons to automatically use the right resolution based on their size
 */
export const registerResponsiveIconRule = (iconName, iconStyle, baseUrl, bucketUrls) => {
    const selector = makeSelector(iconName, iconStyle);
    // Register base rule
    registerIconRule(iconName, iconStyle, baseUrl, MIN_RASTER_SIZE);
    // Add container-query based rules for different sizes
    // Note: This requires the icon container to have container-type set
    for (const [bucket, url] of bucketUrls) {
        const key = `${makeRuleKey(iconName, iconStyle, bucket)}-cq`;
        if (registeredRules.has(key))
            continue;
        const sheet = ensureStyleSheet();
        if (!sheet)
            continue;
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
        }
        catch {
            // Container queries might not be supported
        }
    }
};
/**
 * Clears all registered icon rules
 * Useful for hot reload or cache invalidation
 */
export const clearIconRules = () => {
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
export const getRegistryStats = () => {
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
export const preregisterIcons = (icons) => {
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
        globalThis.addEventListener('focus', () => {
            if (!iconStyleSheet) {
                reinitializeRegistry();
            }
        });
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ1NTSWNvblJlZ2lzdHJ5LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiQ1NTSWNvblJlZ2lzdHJ5LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7R0FTRztBQUVILGdFQUFnRTtBQUNoRSxNQUFNLGVBQWUsR0FBRyxHQUFHLENBQUM7QUFDNUIsTUFBTSxlQUFlLEdBQUcsRUFBRSxDQUFDO0FBRTNCLCtCQUErQjtBQUMvQixJQUFJLGNBQWMsR0FBeUIsSUFBSSxDQUFDO0FBQ2hELElBQUksWUFBWSxHQUE0QixJQUFJLENBQUM7QUFFakQsd0RBQXdEO0FBQ3hELE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7QUFFMUMsMERBQTBEO0FBQzFELE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxHQUFHLEVBQWlELENBQUM7QUFFcEYseUVBQXlFO0FBQ3pFLE1BQU0sdUJBQXVCLEdBQUcsMkJBQTJCLENBQUM7QUFDNUQsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLHdCQUF3QixDQUFDLENBQUM7QUFFMUQsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLE9BQWUsRUFBaUIsRUFBRTtJQUMxRCxJQUFJLENBQUMsT0FBTyxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN6RCxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLG9DQUFvQyxDQUFDLENBQUM7SUFDbEUsT0FBTyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUM7QUFDOUIsQ0FBQyxDQUFDO0FBRUYsTUFBTSx3QkFBd0IsR0FBRyxDQUFDLE9BQWUsRUFBVyxFQUFFO0lBQzFELE1BQU0sR0FBRyxHQUFHLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3hDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUFDLE9BQU8sS0FBSyxDQUFDO0lBQUMsQ0FBQztJQUUzQiw2Q0FBNkM7SUFDN0MsSUFBSSxTQUFT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QzVELGNBQWMsQ0FBQyxHQUFHLEVBQUU7UUFDaEIsZ0JBQWdCLEVBQUUsQ0FBQztRQUVuQiwrREFBK0Q7UUFDL0QsUUFBUSxDQUFDLGdCQUFnQixDQUFDLGtCQUFrQixFQUFFLEdBQUcsRUFBRTtZQUMvQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO2dCQUN0QyxvRUFBb0U7Z0JBQ3BFLG9CQUFvQixFQUFFLENBQUM7WUFDM0IsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgscURBQXFEO1FBQ3JELFVBQVUsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFO1lBQ3RDLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztnQkFDbEIsb0JBQW9CLEVBQUUsQ0FBQztZQUMzQixDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENTUy1iYXNlZCBJY29uIFJlZ2lzdHJ5XG4gKlxuICogSW5zdGVhZCBvZiBjYWNoaW5nIFVSTHMgaW4gSmF2YVNjcmlwdCBNYXBzIGFuZCBzZXR0aW5nIGlubGluZSBzdHlsZXMsXG4gKiB0aGlzIHJlZ2lzdHJ5IG1hbmFnZXMgYSBzaGFyZWQgc3R5bGVzaGVldCB3aXRoIGF0dHJpYnV0ZS1iYXNlZCBzZWxlY3RvcnNcbiAqIGFuZCBpbWFnZS1zZXQoKSBmb3IgcmVzb2x1dGlvbi1hd2FyZSBpY29uIGxvYWRpbmcuXG4gKlxuICogQ1NTIHJ1bGVzIGFyZSBnZW5lcmF0ZWQgbGF6aWx5IHdoZW4gaWNvbnMgYXJlIGZpcnN0IHJlcXVlc3RlZC5cbiAqIE11bHRpcGxlIGljb24gaW5zdGFuY2VzIHNoYXJlIHRoZSBzYW1lIENTUyBydWxlIGF1dG9tYXRpY2FsbHkuXG4gKi9cblxuLy8gQ29uc3RhbnRzIGlubGluZWQgdG8gYXZvaWQgY2lyY3VsYXIgZGVwZW5kZW5jeSB3aXRoIExvYWRlci50c1xuY29uc3QgTUFYX1JBU1RFUl9TSVpFID0gNTEyO1xuY29uc3QgTUlOX1JBU1RFUl9TSVpFID0gMzI7XG5cbi8vIEljb24gc3R5bGUgZWxlbWVudCByZWZlcmVuY2VcbmxldCBpY29uU3R5bGVTaGVldDogQ1NTU3R5bGVTaGVldCB8IG51bGwgPSBudWxsO1xubGV0IHN0eWxlRWxlbWVudDogSFRNTFN0eWxlRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXG4vLyBUcmFjayB3aGljaCBpY29uK3N0eWxlK2J1Y2tldCBjb21iaW5hdGlvbnMgaGF2ZSBydWxlc1xuY29uc3QgcmVnaXN0ZXJlZFJ1bGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbi8vIFN0b3JlIGFjdHVhbCBydWxlIGRhdGEgZm9yIHBlcnNpc3RlbmNlIGFjcm9zcyByZWZyZXNoZXNcbmNvbnN0IHJlZ2lzdGVyZWRSdWxlRGF0YSA9IG5ldyBNYXA8c3RyaW5nLCB7IHNlbGVjdG9yOiBzdHJpbmc7IGNzc1RleHQ6IHN0cmluZyB9PigpO1xuXG4vLyBQZXJzaXN0ZW50IHJlZ2lzdHJ5IHN0b3JhZ2UgLSBzdXJ2aXZlcyBwYWdlIHJlZnJlc2hlcyB2aWEgbG9jYWxTdG9yYWdlXG5jb25zdCBQRVJTSVNURU5UX1JFR0lTVFJZX0tFWSA9ICd1aS1pY29uLXJlZ2lzdHJ5LXN0YXRlLnYyJztcbmNvbnN0IExFR0FDWV9QRVJTSVNURU5UX0tFWVMgPSBbJ3VpLWljb24tcmVnaXN0cnktc3RhdGUnXTtcblxuY29uc3QgZXh0cmFjdEZpcnN0Q3NzVXJsID0gKGNzc1RleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwgPT4ge1xuICAgIGlmICghY3NzVGV4dCB8fCB0eXBlb2YgY3NzVGV4dCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgbWF0Y2ggPSBjc3NUZXh0Lm1hdGNoKC91cmxcXChcXHMqKFsnXCJdPykoW14nXCIpXFxzXSspXFwxXFxzKlxcKS9pKTtcbiAgICByZXR1cm4gbWF0Y2g/LlsyXSA/PyBudWxsO1xufTtcblxuY29uc3QgaXNQZXJzaXN0YWJsZVJ1bGVDc3NUZXh0ID0gKGNzc1RleHQ6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xuICAgIGNvbnN0IHVybCA9IGV4dHJhY3RGaXJzdENzc1VybChjc3NUZXh0KTtcbiAgICBpZiAoIXVybCkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgIC8vIGJsb2I6IFVSTHMgYXJlIG5vdCBzdGFibGUgYWNyb3NzIHJlZnJlc2hlc1xuICAgIGlmICgvXmJsb2I6L2kudGVzdCh1cmwpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgLy8gZGF0YTogVVJMcyBhcmUgc2FmZSB0byBwZXJzaXN0XG4gICAgaWYgKC9eZGF0YTovaS50ZXN0KHVybCkpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgIC8vIEZvciBodHRwKHMpLCBvbmx5IHBlcnNpc3QgaWYgc2FtZS1vcmlnaW4gKGNyb3NzLW9yaWdpbiB3aWxsIHRyaWdnZXIgQ09SUyBpc3N1ZXMgaW4gQ1NTIGZldGNoKVxuICAgIGlmICgvXmh0dHBzPzovaS50ZXN0KHVybCkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbG9jYXRpb24gIT09IFwidW5kZWZpbmVkXCIgJiYgdHlwZW9mIFVSTCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBVUkwodXJsKS5vcmlnaW4gPT09IGxvY2F0aW9uLm9yaWdpbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIFJlbGF0aXZlL3NhbWUtb3JpZ2luIHBhdGhzIGFyZSBPS1xuICAgIHJldHVybiB0cnVlO1xufTtcblxuLy8gUGVuZGluZyBydWxlIGluc2VydGlvbnMgKGJhdGNoZWQgZm9yIHBlcmZvcm1hbmNlKVxubGV0IHBlbmRpbmdSdWxlczogQXJyYXk8eyBzZWxlY3Rvcjogc3RyaW5nOyBjc3NUZXh0OiBzdHJpbmc7IGtleTogc3RyaW5nIH0+ID0gW107XG5sZXQgZmx1c2hTY2hlZHVsZWQgPSBmYWxzZTtcblxuY29uc3QgSUNPTl9QUk9YWV9QQVRIID0gXCIvYXBpL2ljb24tcHJveHlcIjtcbmNvbnN0IGlzQ2hyb21lRXh0ZW5zaW9uUnVudGltZSA9ICgpOiBib29sZWFuID0+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBjaHJvbWVSdW50aW1lID0gKGdsb2JhbFRoaXMgYXMgYW55KT8uY2hyb21lPy5ydW50aW1lO1xuICAgICAgICByZXR1cm4gISFjaHJvbWVSdW50aW1lPy5pZDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn07XG5cbmNvbnN0IHRyeVJld3JpdGVDcm9zc09yaWdpblVybFRvUHJveHkgPSAocmF3VXJsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+IHtcbiAgICBpZiAoIXJhd1VybCB8fCB0eXBlb2YgcmF3VXJsICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB0cmltbWVkID0gcmF3VXJsLnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBudWxsO1xuXG4gICAgLy8gZGF0YS9ibG9iIGFyZSBhbHJlYWR5IHNhZmUgaW4gQ1NTLlxuICAgIGlmICgvXihkYXRhOnxibG9iOikvaS50ZXN0KHRyaW1tZWQpKSByZXR1cm4gdHJpbW1lZDtcblxuICAgIC8vIFJlbGF0aXZlIFVSTHMgYXJlIHNhbWUtb3JpZ2luLlxuICAgIGlmICgvXihcXC98XFwuXFwvfFxcLlxcLlxcLykvLnRlc3QodHJpbW1lZCkpIHJldHVybiB0cmltbWVkO1xuXG4gICAgLy8gT25seSByZXdyaXRlIGFic29sdXRlIGNyb3NzLW9yaWdpbiBVUkxzLlxuICAgIGlmICghL15odHRwcz86L2kudGVzdCh0cmltbWVkKSkgcmV0dXJuIHRyaW1tZWQ7XG5cbiAgICAvLyBJbiBleHRlbnNpb24gcnVudGltZXMgKHBvcHVwL29wdGlvbnMvY29udGVudC1zY3JpcHQpLCBkb24ndCByZXdyaXRlIHRvIC9hcGkuXG4gICAgLy8gU3VjaCBlbmRwb2ludCBpcyBhcHAtc3BlY2lmaWMgYW5kIHVzdWFsbHkgdW5hdmFpbGFibGUgdGhlcmUuXG4gICAgaWYgKGlzQ2hyb21lRXh0ZW5zaW9uUnVudGltZSgpKSByZXR1cm4gdHJpbW1lZDtcblxuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgbG9jYXRpb24gPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIFVSTCAhPT0gXCJmdW5jdGlvblwiKSByZXR1cm4gdHJpbW1lZDtcbiAgICAgICAgY29uc3QgdSA9IG5ldyBVUkwodHJpbW1lZCk7XG4gICAgICAgIGlmICh1Lm9yaWdpbiA9PT0gbG9jYXRpb24ub3JpZ2luKSByZXR1cm4gdHJpbW1lZDtcbiAgICAgICAgcmV0dXJuIGAke0lDT05fUFJPWFlfUEFUSH0/dXJsPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHRyaW1tZWQpfWA7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbn07XG5cbmNvbnN0IHJld3JpdGVDc3NVcmxGdW5jdGlvblZhbHVlID0gKGNzc1ZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+IHtcbiAgICBpZiAoIWNzc1ZhbHVlIHx8IHR5cGVvZiBjc3NWYWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgbWF0Y2ggPSBjc3NWYWx1ZS5tYXRjaCgvdXJsXFwoXFxzKihbJ1wiXT8pKFteJ1wiKVxcc10rKVxcMVxccypcXCkvaSk7XG4gICAgaWYgKCFtYXRjaCkgcmV0dXJuIGNzc1ZhbHVlO1xuICAgIGNvbnN0IHJld3JpdHRlbiA9IHRyeVJld3JpdGVDcm9zc09yaWdpblVybFRvUHJveHkobWF0Y2hbMl0pO1xuICAgIGlmICghcmV3cml0dGVuKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gYHVybChcIiR7cmV3cml0dGVufVwiKWA7XG59O1xuXG4vKipcbiAqIFNhdmVzIHRoZSByZWdpc3RyeSBzdGF0ZSB0byBsb2NhbFN0b3JhZ2UgZm9yIHBlcnNpc3RlbmNlIGFjcm9zcyByZWZyZXNoZXNcbiAqL1xuY29uc3Qgc2F2ZVJlZ2lzdHJ5U3RhdGUgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHR5cGVvZiBsb2NhbFN0b3JhZ2UgPT09ICd1bmRlZmluZWQnKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBydWxlRGF0YSA9IEFycmF5LmZyb20ocmVnaXN0ZXJlZFJ1bGVEYXRhLmVudHJpZXMoKSlcbiAgICAgICAgICAgIC5maWx0ZXIoKFssIGRhdGFdKSA9PiBpc1BlcnNpc3RhYmxlUnVsZUNzc1RleHQoZGF0YS5jc3NUZXh0KSlcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGRhdGFdKSA9PiAoe1xuICAgICAgICAgICAgICAgIGtleSxcbiAgICAgICAgICAgICAgICBzZWxlY3RvcjogZGF0YS5zZWxlY3RvcixcbiAgICAgICAgICAgICAgICBjc3NUZXh0OiBkYXRhLmNzc1RleHRcbiAgICAgICAgICAgIH0pKTtcblxuICAgICAgICBjb25zdCBzdGF0ZSA9IHtcbiAgICAgICAgICAgIHJ1bGVzOiBydWxlRGF0YSxcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKVxuICAgICAgICB9O1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShQRVJTSVNURU5UX1JFR0lTVFJZX0tFWSwgSlNPTi5zdHJpbmdpZnkoc3RhdGUpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSWdub3JlIGxvY2FsU3RvcmFnZSBlcnJvcnNcbiAgICB9XG59O1xuXG4vLyBTdG9yZSBwZW5kaW5nIHJ1bGUgcmVzdG9yYXRpb25zIHVudGlsIHN0eWxlc2hlZXQgaXMgYXZhaWxhYmxlXG5sZXQgcGVuZGluZ1J1bGVSZXN0b3JhdGlvbnM6IEFycmF5PHsga2V5OiBzdHJpbmc7IHNlbGVjdG9yOiBzdHJpbmc7IGNzc1RleHQ6IHN0cmluZyB9PiB8IG51bGwgPSBudWxsO1xuXG4vKipcbiAqIExvYWRzIHRoZSByZWdpc3RyeSBzdGF0ZSBmcm9tIGxvY2FsU3RvcmFnZSBhbmQgcHJlcGFyZXMgcnVsZXMgZm9yIHJlc3RvcmF0aW9uXG4gKi9cbmNvbnN0IGxvYWRSZWdpc3RyeVN0YXRlID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICh0eXBlb2YgbG9jYWxTdG9yYWdlID09PSAndW5kZWZpbmVkJykgcmV0dXJuO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgLy8gQ2xlYW4gbGVnYWN5IGtleXMgZWFnZXJseSB0byBhdm9pZCByZXN0b3JpbmcgdW5zYWZlIG9sZCBydWxlcy5cbiAgICAgICAgZm9yIChjb25zdCBsZWdhY3lLZXkgb2YgTEVHQUNZX1BFUlNJU1RFTlRfS0VZUykge1xuICAgICAgICAgICAgaWYgKGxlZ2FjeUtleSAhPT0gUEVSU0lTVEVOVF9SRUdJU1RSWV9LRVkpIHtcbiAgICAgICAgICAgICAgICB0cnkgeyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShsZWdhY3lLZXkpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFBFUlNJU1RFTlRfUkVHSVNUUllfS0VZKTtcbiAgICAgICAgaWYgKCFzdG9yZWQpIHJldHVybjtcblxuICAgICAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RvcmVkKTtcbiAgICAgICAgaWYgKHN0YXRlLnJ1bGVzICYmIEFycmF5LmlzQXJyYXkoc3RhdGUucnVsZXMpKSB7XG4gICAgICAgICAgICAvLyBPbmx5IHJlc3RvcmUgcnVsZXMgZnJvbSB0aGUgbGFzdCAyNCBob3VycyB0byBhdm9pZCBzdGFsZSBkYXRhXG4gICAgICAgICAgICBjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gKHN0YXRlLnRpbWVzdGFtcCB8fCAwKTtcbiAgICAgICAgICAgIGlmIChhZ2UgPCAyNCAqIDYwICogNjAgKiAxMDAwKSB7XG4gICAgICAgICAgICAgICAgLy8gU3RvcmUgZm9yIGxhdGVyIHJlc3RvcmF0aW9uIHdoZW4gc3R5bGVzaGVldCBpcyBhdmFpbGFibGVcbiAgICAgICAgICAgICAgICBwZW5kaW5nUnVsZVJlc3RvcmF0aW9ucyA9IHN0YXRlLnJ1bGVzLmZpbHRlcigocjogYW55KSA9PiBpc1BlcnNpc3RhYmxlUnVsZUNzc1RleHQocj8uY3NzVGV4dCkpO1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2c/LihgW2ljb24tcmVnaXN0cnldIFByZXBhcmVkICR7cGVuZGluZ1J1bGVSZXN0b3JhdGlvbnMubGVuZ3RofSBydWxlcyBmb3IgcmVzdG9yYXRpb24gZnJvbSBjYWNoZWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gQ2xlYXIgZXhwaXJlZCBzdGF0ZVxuICAgICAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFBFUlNJU1RFTlRfUkVHSVNUUllfS0VZKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBJZ25vcmUgbG9jYWxTdG9yYWdlIGVycm9yc1xuICAgIH1cbn07XG5cbi8qKlxuICogUmVzdG9yZXMgcGVuZGluZyBydWxlcyB0byB0aGUgc3R5bGVzaGVldCB3aGVuIGl0IGJlY29tZXMgYXZhaWxhYmxlXG4gKi9cbmNvbnN0IHJlc3RvcmVQZW5kaW5nUnVsZXMgPSAoc2hlZXQ6IENTU1N0eWxlU2hlZXQpOiB2b2lkID0+IHtcbiAgICBpZiAoIXBlbmRpbmdSdWxlUmVzdG9yYXRpb25zKSByZXR1cm47XG5cbiAgICBsZXQgcmVzdG9yZWRDb3VudCA9IDA7XG4gICAgbGV0IHNraXBwZWRDb3VudCA9IDA7XG4gICAgcGVuZGluZ1J1bGVSZXN0b3JhdGlvbnMuZm9yRWFjaCgocnVsZURhdGEpID0+IHtcbiAgICAgICAgaWYgKHJ1bGVEYXRhLmtleSAmJiBydWxlRGF0YS5zZWxlY3RvciAmJiBydWxlRGF0YS5jc3NUZXh0ICYmICFyZWdpc3RlcmVkUnVsZXMuaGFzKHJ1bGVEYXRhLmtleSkpIHtcbiAgICAgICAgICAgIGlmICghaXNQZXJzaXN0YWJsZVJ1bGVDc3NUZXh0KHJ1bGVEYXRhLmNzc1RleHQpKSB7XG4gICAgICAgICAgICAgICAgc2tpcHBlZENvdW50Kys7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAvLyBSZS1pbnNlcnQgdGhlIHJ1bGUgaW50byB0aGUgc3R5bGVzaGVldFxuICAgICAgICAgICAgICAgIGNvbnN0IHJ1bGVUZXh0ID0gYCR7cnVsZURhdGEuc2VsZWN0b3J9IHsgJHtydWxlRGF0YS5jc3NUZXh0fSB9YDtcbiAgICAgICAgICAgICAgICBzaGVldC5pbnNlcnRSdWxlKHJ1bGVUZXh0LCBzaGVldC5jc3NSdWxlcy5sZW5ndGgpO1xuXG4gICAgICAgICAgICAgICAgLy8gUmVzdG9yZSB0aGUgdHJhY2tpbmcgZGF0YVxuICAgICAgICAgICAgICAgIHJlZ2lzdGVyZWRSdWxlcy5hZGQocnVsZURhdGEua2V5KTtcbiAgICAgICAgICAgICAgICByZWdpc3RlcmVkUnVsZURhdGEuc2V0KHJ1bGVEYXRhLmtleSwge1xuICAgICAgICAgICAgICAgICAgICBzZWxlY3RvcjogcnVsZURhdGEuc2VsZWN0b3IsXG4gICAgICAgICAgICAgICAgICAgIGNzc1RleHQ6IHJ1bGVEYXRhLmNzc1RleHRcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICByZXN0b3JlZENvdW50Kys7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4/LihgW2ljb24tcmVnaXN0cnldIEZhaWxlZCB0byByZXN0b3JlIHJ1bGUgJHtydWxlRGF0YS5rZXl9OmAsIGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSAndW5kZWZpbmVkJyAmJiAocmVzdG9yZWRDb3VudCA+IDAgfHwgc2tpcHBlZENvdW50ID4gMCkpIHtcbiAgICAgICAgY29uc29sZS5sb2c/LihgW2ljb24tcmVnaXN0cnldIFJlc3RvcmVkICR7cmVzdG9yZWRDb3VudH0gQ1NTIHJ1bGVzIHRvIHN0eWxlc2hlZXQgKHNraXBwZWQgJHtza2lwcGVkQ291bnR9IHVuc2FmZS91bnN0YWJsZSBydWxlcylgKTtcbiAgICB9XG5cbiAgICBwZW5kaW5nUnVsZVJlc3RvcmF0aW9ucyA9IG51bGw7IC8vIENsZWFyIGFmdGVyIHJlc3RvcmF0aW9uXG59O1xuXG4vKipcbiAqIENsZWFycyB0aGUgcGVyc2lzdGVudCByZWdpc3RyeSBzdGF0ZVxuICovXG5leHBvcnQgY29uc3QgY2xlYXJSZWdpc3RyeVN0YXRlID0gKCk6IHZvaWQgPT4ge1xuICAgIHJlZ2lzdGVyZWRSdWxlcy5jbGVhcigpO1xuICAgIHJlZ2lzdGVyZWRSdWxlRGF0YS5jbGVhcigpO1xuICAgIHBlbmRpbmdSdWxlcy5sZW5ndGggPSAwO1xuICAgIGZsdXNoU2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICAvLyBSZXNldCBzdHlsZXNoZWV0XG4gICAgaWYgKGljb25TdHlsZVNoZWV0ICYmIGRvY3VtZW50LmFkb3B0ZWRTdHlsZVNoZWV0cykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGRvY3VtZW50LmFkb3B0ZWRTdHlsZVNoZWV0cy5pbmRleE9mKGljb25TdHlsZVNoZWV0IGFzIENTU1N0eWxlU2hlZXQpO1xuICAgICAgICBpZiAoaW5kZXggIT09IC0xKSB7XG4gICAgICAgICAgICBkb2N1bWVudC5hZG9wdGVkU3R5bGVTaGVldHMuc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpY29uU3R5bGVTaGVldCA9IG51bGw7XG4gICAgc3R5bGVFbGVtZW50ID0gbnVsbDtcblxuICAgIGlmICh0eXBlb2YgbG9jYWxTdG9yYWdlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShQRVJTSVNURU5UX1JFR0lTVFJZX0tFWSk7XG4gICAgfVxuXG4gICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICBjb25zb2xlLmxvZz8uKCdbaWNvbi1yZWdpc3RyeV0gUmVnaXN0cnkgc3RhdGUgY2xlYXJlZCcpO1xuICAgIH1cbn07XG5cbi8qKlxuICogUmVpbml0aWFsaXplcyB0aGUgcmVnaXN0cnkgLSB1c2VmdWwgZm9yIHBhZ2UgcmVmcmVzaGVzIG9yIHdoZW4gbmVlZGluZyB0byByZWxvYWQgYWxsIHJ1bGVzXG4gKi9cbmV4cG9ydCBjb25zdCByZWluaXRpYWxpemVSZWdpc3RyeSA9ICgpOiB2b2lkID0+IHtcbiAgICBjbGVhclJlZ2lzdHJ5U3RhdGUoKTtcbiAgICBlbnN1cmVTdHlsZVNoZWV0KCk7XG5cbiAgICBpZiAodHlwZW9mIGNvbnNvbGUgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIGNvbnNvbGUubG9nPy4oJ1tpY29uLXJlZ2lzdHJ5XSBSZWdpc3RyeSByZWluaXRpYWxpemVkJyk7XG4gICAgfVxufTtcblxuLyoqXG4gKiBHZXRzIG9yIGNyZWF0ZXMgdGhlIHNoYXJlZCBpY29uIHN0eWxlc2hlZXRcbiAqL1xuZXhwb3J0IGNvbnN0IGVuc3VyZVN0eWxlU2hlZXQgPSAoKTogQ1NTU3R5bGVTaGVldCB8IG51bGwgPT4ge1xuICAgIGlmIChpY29uU3R5bGVTaGVldCkgcmV0dXJuIGljb25TdHlsZVNoZWV0IGFzIENTU1N0eWxlU2hlZXQ7XG4gICAgaWYgKHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuIG51bGw7XG5cbiAgICAvLyBMb2FkIHBlcnNpc3RlbnQgcmVnaXN0cnkgc3RhdGUgb24gZmlyc3QgYWNjZXNzXG4gICAgaWYgKHJlZ2lzdGVyZWRSdWxlcy5zaXplID09PSAwKSB7XG4gICAgICAgIGxvYWRSZWdpc3RyeVN0YXRlKCk7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgZm9yIGV4aXN0aW5nIHN0eWxlIGVsZW1lbnRcbiAgICAvKnN0eWxlRWxlbWVudCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTFN0eWxlRWxlbWVudD4oXCJzdHlsZVtkYXRhLWljb24tcmVnaXN0cnldXCIpO1xuXG4gICAgaWYgKCFzdHlsZUVsZW1lbnQpIHtcbiAgICAgICAgc3R5bGVFbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xuICAgICAgICBzdHlsZUVsZW1lbnQuc2V0QXR0cmlidXRlKFwiZGF0YS1pY29uLXJlZ2lzdHJ5XCIsIFwidHJ1ZVwiKTtcbiAgICAgICAgLy8gSW5zZXJ0IGVhcmx5IGluIGhlYWQgZm9yIGxvd2VyIHNwZWNpZmljaXR5XG4gICAgICAgIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5oZWFkIHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgICAgICAgaGVhZC5pbnNlcnRCZWZvcmUoc3R5bGVFbGVtZW50LCBoZWFkLmZpcnN0Q2hpbGQpO1xuICAgIH0qL1xuXG4gICAgaWNvblN0eWxlU2hlZXQgPSBuZXcgQ1NTU3R5bGVTaGVldCgpIGFzIENTU1N0eWxlU2hlZXQ7Ly9zdHlsZUVsZW1lbnQuc2hlZXQ7XG4gICAgZG9jdW1lbnQuYWRvcHRlZFN0eWxlU2hlZXRzPy5wdXNoPy4oKGljb25TdHlsZVNoZWV0IGFzIHVua25vd24gYXMgQ1NTU3R5bGVTaGVldCkpO1xuXG4gICAgLy9cbiAgICBpY29uU3R5bGVTaGVldC5pbnNlcnRSdWxlKGBAcHJvcGVydHkgLS1pY29uLWltYWdlIHsgc3ludGF4OiBcIjxpbWFnZT5cIjsgaW5oZXJpdHM6IHRydWU7IGluaXRpYWwtdmFsdWU6IGxpbmVhci1ncmFkaWVudCgjMDAwMCwgIzAwMDApOyB9YCwgaWNvblN0eWxlU2hlZXQuY3NzUnVsZXMubGVuZ3RoKTtcbiAgICBpY29uU3R5bGVTaGVldC5pbnNlcnRSdWxlKGA6d2hlcmUodWktaWNvbiksIDpob3N0KHVpLWljb24pIHsgLS1pY29uLWltYWdlOiBsaW5lYXItZ3JhZGllbnQoIzAwMDAsICMwMDAwKTsgfWAsIGljb25TdHlsZVNoZWV0LmNzc1J1bGVzLmxlbmd0aCk7XG4gICAgaWNvblN0eWxlU2hlZXQuaW5zZXJ0UnVsZShgOndoZXJlKHVpLWljb246bm90KFtpY29uXSkpLCA6d2hlcmUodWktaWNvbltpY29uPVwiXCJdKSwgOmhvc3QodWktaWNvbjpub3QoW2ljb25dKSksIDpob3N0KHVpLWljb25baWNvbj1cIlwiXSkgeyBiYWNrZ3JvdW5kLWNvbG9yOiB0cmFuc3BhcmVudDsgfWAsIGljb25TdHlsZVNoZWV0LmNzc1J1bGVzLmxlbmd0aCk7XG5cbiAgICAvLyBSZXN0b3JlIGFueSBwZW5kaW5nIHJ1bGVzIGZyb20gbG9jYWxTdG9yYWdlXG4gICAgcmVzdG9yZVBlbmRpbmdSdWxlcyhpY29uU3R5bGVTaGVldCk7XG5cbiAgICByZXR1cm4gaWNvblN0eWxlU2hlZXQgYXMgQ1NTU3R5bGVTaGVldDtcbn07XG5cbi8qKlxuICogR2VuZXJhdGVzIHRoZSBDU1MgcnVsZSBrZXkgZm9yIGRlZHVwbGljYXRpb25cbiAqL1xuY29uc3QgbWFrZVJ1bGVLZXkgPSAoaWNvbk5hbWU6IHN0cmluZywgaWNvblN0eWxlOiBzdHJpbmcsIGJ1Y2tldDogbnVtYmVyKTogc3RyaW5nID0+IHtcbiAgICByZXR1cm4gYCR7aWNvblN0eWxlfToke2ljb25OYW1lfUAke2J1Y2tldH1gO1xufTtcblxuLyoqXG4gKiBDcmVhdGVzIGltYWdlLXNldCB2YWx1ZSBmb3IgZGlmZmVyZW50IHJlc29sdXRpb25zXG4gKiBVc2VzIHRoZSByZXNvbHZlZCBVUkwgd2l0aCBhcHByb3ByaWF0ZSByZXNvbHV0aW9uIGRlc2NyaXB0b3JzXG4gKi9cbmNvbnN0IGNyZWF0ZUltYWdlU2V0Q1NTID0gKFxuICAgIHVybDogc3RyaW5nLFxuICAgIGJ1Y2tldDogbnVtYmVyLFxuKTogc3RyaW5nID0+IHtcbiAgICBpZiAoIXVybCkgcmV0dXJuIFwibGluZWFyLWdyYWRpZW50KCMwMDAwLCAjMDAwMClcIjtcblxuICAgIC8vIEJ1aWxkIGltYWdlLXNldCB3aXRoIDF4IGFuZCAyeCB2YXJpYW50c1xuICAgIC8vIFRoZSBicm93c2VyIHdpbGwgcGljayB0aGUgYmVzdCByZXNvbHV0aW9uIGJhc2VkIG9uIGRldmljZSBwaXhlbCByYXRpb1xuICAgIC8qY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG5cbiAgICAvLyBCYXNlIHJlc29sdXRpb25cbiAgICBwYXJ0cy5wdXNoKCh1cmwuc3RhcnRzV2l0aChcInVybChcIikgPyB1cmwgOiBgdXJsKFwiJHt1cmx9XCIpYCkgKyBcIiAxeFwiKTtcblxuICAgIC8vIEhpZ2hlciBkZW5zaXR5IGhpbnQgKHNhbWUgVVJMLCBicm93c2VyIGhhbmRsZXMgc2NhbGluZylcbiAgICBpZiAoYnVja2V0IDw9IE1BWF9SQVNURVJfU0laRSAvIDIpIHtcbiAgICAgICAgcGFydHMucHVzaCgodXJsLnN0YXJ0c1dpdGgoXCJ1cmwoXCIpID8gdXJsIDogYHVybChcIiR7dXJsfVwiKWApICsgXCIgMnhcIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIGBpbWFnZS1zZXQoJHtwYXJ0cy5qb2luKFwiLCBcIil9KWA7Ki9cbiAgICAvLyBFbnN1cmUgdGhlIENTUyBkb2Vzbid0IGRpcmVjdGx5IHJlZmVyZW5jZSBjcm9zcy1vcmlnaW4gaHR0cHM6Ly8uLi4gVVJMcyxcbiAgICAvLyBiZWNhdXNlIENTUyBmZXRjaGVzIGFyZSBjcmVkZW50aWFsZWQgYW5kIG1hbnkgQ0ROcyByZXNwb25kIHdpdGggQUNBTz1cIipcIi5cbiAgICBpZiAodXJsLnN0YXJ0c1dpdGgoXCJ1cmwoXCIpKSB7XG4gICAgICAgIHJldHVybiByZXdyaXRlQ3NzVXJsRnVuY3Rpb25WYWx1ZSh1cmwpID8/IFwibGluZWFyLWdyYWRpZW50KCMwMDAwLCAjMDAwMClcIjtcbiAgICB9XG4gICAgY29uc3QgcmV3cml0dGVuID0gdHJ5UmV3cml0ZUNyb3NzT3JpZ2luVXJsVG9Qcm94eSh1cmwpO1xuICAgIHJldHVybiByZXdyaXR0ZW4gPyBgdXJsKFwiJHtyZXdyaXR0ZW59XCIpYCA6IFwibGluZWFyLWdyYWRpZW50KCMwMDAwLCAjMDAwMClcIjtcbn07XG5cbi8qKlxuICogR2VuZXJhdGVzIHRoZSBDU1Mgc2VsZWN0b3IgZm9yIGFuIGljb25cbiAqIFVzZXMgYXR0cmlidXRlIHNlbGVjdG9ycyBmb3IgaWNvbiBuYW1lIGFuZCBzdHlsZVxuICovXG5jb25zdCBtYWtlU2VsZWN0b3IgPSAoaWNvbk5hbWU6IHN0cmluZywgaWNvblN0eWxlOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIC8vIFZhbGlkYXRlIGFuZCBzYW5pdGl6ZSBpbnB1dHNcbiAgICBjb25zdCBzYWZlTmFtZSA9IChpY29uTmFtZSB8fCAnJykudHJpbSgpO1xuICAgIGNvbnN0IHNhZmVTdHlsZSA9IChpY29uU3R5bGUgfHwgJ2R1b3RvbmUnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcblxuICAgIGlmICghc2FmZU5hbWUpIHtcbiAgICAgICAgcmV0dXJuICcnOyAvLyBJbnZhbGlkIHNlbGVjdG9yXG4gICAgfVxuXG4gICAgLy8gRXNjYXBlIHNwZWNpYWwgY2hhcmFjdGVycyBpbiBhdHRyaWJ1dGUgdmFsdWVzXG4gICAgY29uc3QgZXNjYXBlZE5hbWUgPSBDU1MuZXNjYXBlKHNhZmVOYW1lKTtcbiAgICBjb25zdCBlc2NhcGVkU3R5bGUgPSBDU1MuZXNjYXBlKHNhZmVTdHlsZSk7XG5cbiAgICAvLyBNYXRjaCBib3RoIGNsYXNzIHNlbGVjdG9yICgudWktaWNvbikgYW5kIDpob3N0IHNlbGVjdG9yIGZvciBzaGFkb3cgRE9NXG4gICAgcmV0dXJuIGAudWktaWNvbltpY29uPVwiJHtlc2NhcGVkTmFtZX1cIl1baWNvbi1zdHlsZT1cIiR7ZXNjYXBlZFN0eWxlfVwiXSwgOmhvc3QoLnVpLWljb25baWNvbj1cIiR7ZXNjYXBlZE5hbWV9XCJdW2ljb24tc3R5bGU9XCIke2VzY2FwZWRTdHlsZX1cIl0pYDtcbn07XG5cbi8qKlxuICogRmx1c2hlcyBwZW5kaW5nIENTUyBydWxlcyBpbiBhIHNpbmdsZSBiYXRjaFxuICovXG5jb25zdCBmbHVzaFBlbmRpbmdSdWxlcyA9ICgpID0+IHtcbiAgICBmbHVzaFNjaGVkdWxlZCA9IGZhbHNlO1xuICAgIGlmIChwZW5kaW5nUnVsZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBzaGVldCA9IGVuc3VyZVN0eWxlU2hlZXQoKTtcbiAgICBpZiAoIXNoZWV0KSB7XG4gICAgICAgIC8vIFJldHJ5IGxhdGVyIGlmIGRvY3VtZW50IG5vdCByZWFkeVxuICAgICAgICBwZW5kaW5nUnVsZXMgPSBbXTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJ1bGVzVG9JbnNlcnQgPSBwZW5kaW5nUnVsZXMuc2xpY2UoKTtcbiAgICBwZW5kaW5nUnVsZXMgPSBbXTtcblxuICAgIGZvciAoY29uc3QgeyBzZWxlY3RvciwgY3NzVGV4dCwga2V5IH0gb2YgcnVsZXNUb0luc2VydCkge1xuICAgICAgICBpZiAocmVnaXN0ZXJlZFJ1bGVzLmhhcyhrZXkpKSBjb250aW51ZTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcnVsZVRleHQgPSBgJHtzZWxlY3Rvcn0geyAke2Nzc1RleHR9IH1gO1xuICAgICAgICAgICAgc2hlZXQuaW5zZXJ0UnVsZShydWxlVGV4dCwgc2hlZXQuY3NzUnVsZXMubGVuZ3RoKTtcbiAgICAgICAgICAgIHJlZ2lzdGVyZWRSdWxlcy5hZGQoa2V5KTtcblxuICAgICAgICAgICAgLy8gU3RvcmUgdGhlIHJ1bGUgZGF0YSBmb3IgcGVyc2lzdGVuY2VcbiAgICAgICAgICAgIHJlZ2lzdGVyZWRSdWxlRGF0YS5zZXQoa2V5LCB7IHNlbGVjdG9yLCBjc3NUZXh0IH0pO1xuXG4gICAgICAgICAgICAvLyBTYXZlIHJlZ2lzdHJ5IHN0YXRlIGFmdGVyIHN1Y2Nlc3NmdWwgcnVsZSBpbnNlcnRpb25cbiAgICAgICAgICAgIHNhdmVSZWdpc3RyeVN0YXRlKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUud2Fybj8uKFwiW2ljb24tcmVnaXN0cnldIEZhaWxlZCB0byBpbnNlcnQgcnVsZTpcIiwgZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG4vKipcbiAqIFNjaGVkdWxlcyBhIGJhdGNoIGZsdXNoIG9mIHBlbmRpbmcgcnVsZXNcbiAqL1xuY29uc3Qgc2NoZWR1bGVGbHVzaCA9ICgpID0+IHtcbiAgICBpZiAoZmx1c2hTY2hlZHVsZWQpIHJldHVybjtcbiAgICBmbHVzaFNjaGVkdWxlZCA9IHRydWU7XG4gICAgcXVldWVNaWNyb3Rhc2soZmx1c2hQZW5kaW5nUnVsZXMpO1xufTtcblxuLyoqXG4gKiBSZWdpc3RlcnMgYW4gaWNvbiBydWxlIGluIHRoZSBzdHlsZXNoZWV0XG4gKiBSdWxlcyBhcmUgYmF0Y2hlZCBhbmQgZGVkdXBsaWNhdGVkIGF1dG9tYXRpY2FsbHlcbiAqL1xuZXhwb3J0IGNvbnN0IHJlZ2lzdGVySWNvblJ1bGUgPSAoXG4gICAgaWNvbk5hbWU6IHN0cmluZyxcbiAgICBpY29uU3R5bGU6IHN0cmluZyxcbiAgICBpbWFnZVVybDogc3RyaW5nLFxuICAgIGJ1Y2tldDogbnVtYmVyID0gTUlOX1JBU1RFUl9TSVpFLFxuKTogdm9pZCA9PiB7XG4gICAgY29uc3Qga2V5ID0gbWFrZVJ1bGVLZXkoaWNvbk5hbWUsIGljb25TdHlsZSwgYnVja2V0KTtcblxuICAgIC8vIFNraXAgaWYgYWxyZWFkeSByZWdpc3RlcmVkXG4gICAgaWYgKHJlZ2lzdGVyZWRSdWxlcy5oYXMoa2V5KSkgcmV0dXJuO1xuXG4gICAgLy8gU2tpcCBpZiBhbHJlYWR5IHBlbmRpbmdcbiAgICBpZiAocGVuZGluZ1J1bGVzLnNvbWUociA9PiByLmtleSA9PT0ga2V5KSkgcmV0dXJuO1xuXG4gICAgY29uc3Qgc2VsZWN0b3IgPSBtYWtlU2VsZWN0b3IoaWNvbk5hbWUsIGljb25TdHlsZSk7XG4gICAgY29uc3QgaW1hZ2VTZXRWYWx1ZSA9IGNyZWF0ZUltYWdlU2V0Q1NTKGltYWdlVXJsLCBidWNrZXQpO1xuXG4gICAgLy8gUXVldWUgdGhlIHJ1bGUgZm9yIGJhdGNoIGluc2VydGlvblxuICAgIHBlbmRpbmdSdWxlcy5wdXNoKHtcbiAgICAgICAgc2VsZWN0b3IsXG4gICAgICAgIGNzc1RleHQ6IGAtLWljb24taW1hZ2U6ICR7aW1hZ2VTZXRWYWx1ZX07YCxcbiAgICAgICAga2V5LFxuICAgIH0pO1xuXG4gICAgc2NoZWR1bGVGbHVzaCgpO1xufTtcblxuLyoqXG4gKiBSZWdpc3RlcnMgbXVsdGlwbGUgYnVja2V0IHNpemVzIGZvciBhbiBpY29uXG4gKiBVc2VmdWwgZm9yIHJlc3BvbnNpdmUgaWNvbnMgdGhhdCBuZWVkIGRpZmZlcmVudCByZXNvbHV0aW9uc1xuICovXG5leHBvcnQgY29uc3QgcmVnaXN0ZXJJY29uUnVsZVdpdGhCdWNrZXRzID0gKFxuICAgIGljb25OYW1lOiBzdHJpbmcsXG4gICAgaWNvblN0eWxlOiBzdHJpbmcsXG4gICAgaW1hZ2VVcmw6IHN0cmluZyxcbiAgICBidWNrZXRzOiBudW1iZXJbXSA9IFszMiwgNjQsIDEyOCwgMjU2XSxcbik6IHZvaWQgPT4ge1xuICAgIGZvciAoY29uc3QgYnVja2V0IG9mIGJ1Y2tldHMpIHtcbiAgICAgICAgcmVnaXN0ZXJJY29uUnVsZShpY29uTmFtZSwgaWNvblN0eWxlLCBpbWFnZVVybCwgYnVja2V0KTtcbiAgICB9XG59O1xuXG4vKipcbiAqIENoZWNrcyBpZiBhbiBpY29uIHJ1bGUgaXMgYWxyZWFkeSByZWdpc3RlcmVkXG4gKi9cbmV4cG9ydCBjb25zdCBoYXNJY29uUnVsZSA9IChcbiAgICBpY29uTmFtZTogc3RyaW5nLFxuICAgIGljb25TdHlsZTogc3RyaW5nLFxuICAgIGJ1Y2tldDogbnVtYmVyID0gTUlOX1JBU1RFUl9TSVpFLFxuKTogYm9vbGVhbiA9PiB7XG4gICAgY29uc3Qga2V5ID0gbWFrZVJ1bGVLZXkoaWNvbk5hbWUsIGljb25TdHlsZSwgYnVja2V0KTtcbiAgICByZXR1cm4gcmVnaXN0ZXJlZFJ1bGVzLmhhcyhrZXkpIHx8IHBlbmRpbmdSdWxlcy5zb21lKHIgPT4gci5rZXkgPT09IGtleSk7XG59O1xuXG4vKipcbiAqIEdlbmVyYXRlcyBhIGNvbnRhaW5lciBxdWVyeSBiYXNlZCBydWxlIGZvciBidWNrZXQgc2l6aW5nXG4gKiBUaGlzIGFsbG93cyBpY29ucyB0byBhdXRvbWF0aWNhbGx5IHVzZSB0aGUgcmlnaHQgcmVzb2x1dGlvbiBiYXNlZCBvbiB0aGVpciBzaXplXG4gKi9cbmV4cG9ydCBjb25zdCByZWdpc3RlclJlc3BvbnNpdmVJY29uUnVsZSA9IChcbiAgICBpY29uTmFtZTogc3RyaW5nLFxuICAgIGljb25TdHlsZTogc3RyaW5nLFxuICAgIGJhc2VVcmw6IHN0cmluZyxcbiAgICBidWNrZXRVcmxzOiBNYXA8bnVtYmVyLCBzdHJpbmc+LFxuKTogdm9pZCA9PiB7XG4gICAgY29uc3Qgc2VsZWN0b3IgPSBtYWtlU2VsZWN0b3IoaWNvbk5hbWUsIGljb25TdHlsZSk7XG5cbiAgICAvLyBSZWdpc3RlciBiYXNlIHJ1bGVcbiAgICByZWdpc3Rlckljb25SdWxlKGljb25OYW1lLCBpY29uU3R5bGUsIGJhc2VVcmwsIE1JTl9SQVNURVJfU0laRSk7XG5cbiAgICAvLyBBZGQgY29udGFpbmVyLXF1ZXJ5IGJhc2VkIHJ1bGVzIGZvciBkaWZmZXJlbnQgc2l6ZXNcbiAgICAvLyBOb3RlOiBUaGlzIHJlcXVpcmVzIHRoZSBpY29uIGNvbnRhaW5lciB0byBoYXZlIGNvbnRhaW5lci10eXBlIHNldFxuICAgIGZvciAoY29uc3QgW2J1Y2tldCwgdXJsXSBvZiBidWNrZXRVcmxzKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGAke21ha2VSdWxlS2V5KGljb25OYW1lLCBpY29uU3R5bGUsIGJ1Y2tldCl9LWNxYDtcbiAgICAgICAgaWYgKHJlZ2lzdGVyZWRSdWxlcy5oYXMoa2V5KSkgY29udGludWU7XG5cbiAgICAgICAgY29uc3Qgc2hlZXQgPSBlbnN1cmVTdHlsZVNoZWV0KCk7XG4gICAgICAgIGlmICghc2hlZXQpIGNvbnRpbnVlO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBVc2UgQGNvbnRhaW5lciBxdWVyeSBmb3IgcmVzcG9uc2l2ZSBzaXppbmcgKGxvZ2ljYWwgcHJvcGVydHkpXG4gICAgICAgICAgICBjb25zdCBjcVJ1bGUgPSBgXG4gICAgICAgICAgICAgICAgQGNvbnRhaW5lciAobWluLWlubGluZS1zaXplOiAke2J1Y2tldH1weCkge1xuICAgICAgICAgICAgICAgICAgICAke3NlbGVjdG9yfSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAtLWljb24taW1hZ2U6ICR7Y3JlYXRlSW1hZ2VTZXRDU1ModXJsLCBidWNrZXQpfTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGA7XG4gICAgICAgICAgICBzaGVldC5pbnNlcnRSdWxlKGNxUnVsZSwgc2hlZXQuY3NzUnVsZXMubGVuZ3RoKTtcbiAgICAgICAgICAgIHJlZ2lzdGVyZWRSdWxlcy5hZGQoa2V5KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBDb250YWluZXIgcXVlcmllcyBtaWdodCBub3QgYmUgc3VwcG9ydGVkXG4gICAgICAgIH1cbiAgICB9XG59O1xuXG4vKipcbiAqIENsZWFycyBhbGwgcmVnaXN0ZXJlZCBpY29uIHJ1bGVzXG4gKiBVc2VmdWwgZm9yIGhvdCByZWxvYWQgb3IgY2FjaGUgaW52YWxpZGF0aW9uXG4gKi9cbmV4cG9ydCBjb25zdCBjbGVhckljb25SdWxlcyA9ICgpOiB2b2lkID0+IHtcbiAgICByZWdpc3RlcmVkUnVsZXMuY2xlYXIoKTtcbiAgICBwZW5kaW5nUnVsZXMgPSBbXTtcblxuICAgIGlmIChzdHlsZUVsZW1lbnQ/LnNoZWV0KSB7XG4gICAgICAgIC8vIFJlbW92ZSBhbGwgcnVsZXNcbiAgICAgICAgY29uc3Qgc2hlZXQgPSBzdHlsZUVsZW1lbnQuc2hlZXQ7XG4gICAgICAgIHdoaWxlIChzaGVldC5jc3NSdWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzaGVldC5kZWxldGVSdWxlKDApO1xuICAgICAgICB9XG4gICAgfVxufTtcblxuLyoqXG4gKiBHZXRzIHN0YXRpc3RpY3MgYWJvdXQgcmVnaXN0ZXJlZCBydWxlc1xuICovXG5leHBvcnQgY29uc3QgZ2V0UmVnaXN0cnlTdGF0cyA9ICgpOiB7XG4gICAgcnVsZUNvdW50OiBudW1iZXI7XG4gICAgcGVuZGluZ0NvdW50OiBudW1iZXI7XG4gICAgaGFzU3R5bGVTaGVldDogYm9vbGVhbjtcbn0gPT4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHJ1bGVDb3VudDogcmVnaXN0ZXJlZFJ1bGVzLnNpemUsXG4gICAgICAgIHBlbmRpbmdDb3VudDogcGVuZGluZ1J1bGVzLmxlbmd0aCxcbiAgICAgICAgaGFzU3R5bGVTaGVldDogaWNvblN0eWxlU2hlZXQgIT09IG51bGwsXG4gICAgfTtcbn07XG5cbi8qKlxuICogUHJlLXJlZ2lzdGVycyBjb21tb24gaWNvbiBzdHlsZXMgdG8gcmVkdWNlIGxheW91dCBzaGlmdHNcbiAqIENhbGwgdGhpcyBlYXJseSBpbiBhcHAgaW5pdGlhbGl6YXRpb24gaWYgeW91IGtub3cgd2hpY2ggaWNvbnMgd2lsbCBiZSB1c2VkXG4gKi9cbmV4cG9ydCBjb25zdCBwcmVyZWdpc3Rlckljb25zID0gKFxuICAgIGljb25zOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc3R5bGU6IHN0cmluZzsgdXJsOiBzdHJpbmcgfT4sXG4pOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IHsgbmFtZSwgc3R5bGUsIHVybCB9IG9mIGljb25zKSB7XG4gICAgICAgIHJlZ2lzdGVySWNvblJ1bGUobmFtZSwgc3R5bGUsIHVybCk7XG4gICAgfVxufTtcblxuLyoqXG4gKiBQcmUtaW5pdGlhbGl6ZXMgcmVnaXN0cnkgb24gbW9kdWxlIGxvYWQgKG5vbi1ibG9ja2luZylcbiAqL1xuaWYgKHR5cGVvZiBkb2N1bWVudCAhPT0gXCJ1bmRlZmluZWRcIiAmJiB0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgLy8gTG9hZCBwZXJzaXN0ZWQgc3RhdGUgaW1tZWRpYXRlbHkgKGRvZXNuJ3QgcmVxdWlyZSBET00pXG4gICAgbG9hZFJlZ2lzdHJ5U3RhdGUoKTtcblxuICAgIC8vIEluaXRpYWxpemUgc3R5bGVzaGVldCBvbiBuZXh0IHRpY2sgdG8gZW5zdXJlIERPTSBpcyByZWFkeVxuICAgIHF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgICAgICAgZW5zdXJlU3R5bGVTaGVldCgpO1xuXG4gICAgICAgIC8vIExpc3RlbiBmb3IgcGFnZSB2aXNpYmlsaXR5IGNoYW5nZXMgdG8gcmVpbml0aWFsaXplIGlmIG5lZWRlZFxuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd2aXNpYmlsaXR5Y2hhbmdlJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFkb2N1bWVudC5oaWRkZW4gJiYgIWljb25TdHlsZVNoZWV0KSB7XG4gICAgICAgICAgICAgICAgLy8gUGFnZSBiZWNhbWUgdmlzaWJsZSBhbmQgd2UgZG9uJ3QgaGF2ZSBhIHN0eWxlc2hlZXQgLSByZWluaXRpYWxpemVcbiAgICAgICAgICAgICAgICByZWluaXRpYWxpemVSZWdpc3RyeSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBBbHNvIHJlaW5pdGlhbGl6ZSBvbiBmb2N1cyB0byBoYW5kbGUgdGFiIHN3aXRjaGluZ1xuICAgICAgICBnbG9iYWxUaGlzLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFpY29uU3R5bGVTaGVldCkge1xuICAgICAgICAgICAgICAgIHJlaW5pdGlhbGl6ZVJlZ2lzdHJ5KCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuIl19