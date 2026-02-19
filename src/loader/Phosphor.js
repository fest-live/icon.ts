// should to return from source code to style element (in shadow DOM)
export const preloadStyle = (srcCode) => {
    const content = typeof srcCode === "string" ? srcCode?.trim?.() : "";
    if (!content) {
        return () => null;
    }
    const styleURL = URL.createObjectURL(new Blob([content], { type: "text/css" }));
    //
    if (typeof document === "undefined") {
        return null;
    }
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-ui-phosphor-icon", "true");
    styleEl.innerHTML = `@import url("${styleURL}");`;
    //
    return () => styleEl?.cloneNode?.(true);
    ;
};
// @ts-ignore – Vite inline import
import styles from "./Phosphor.scss?inline";
import { ensureMaskValue, loadAsImage, FALLBACK_ICON_DATA_URL, MIN_RASTER_SIZE, quantizeToBucket, camelToKebab, registerIconRule, hasIconRule, } from "./Loader";
//
const createStyle = preloadStyle(styles);
// Handle non-string or empty inputs gracefully
const capitalizeFirstLetter = (str) => {
    if (typeof str !== "string" || str.length === 0) {
        return str;
    }
    return str.charAt(0).toUpperCase() + str.slice(1);
};
const summarizeIconUrlForLog = (value, previewLength = 140) => {
    if (typeof value !== "string") {
        return value;
    }
    if (!value) {
        return value;
    }
    if (value.startsWith("data:")) {
        const mimeMatch = /^data:([^;,]+)[;,]/.exec(value);
        const mimeType = mimeMatch?.[1] || "application/octet-stream";
        return `[data-url ${mimeType}, length=${value.length}]`;
    }
    if (value.length > previewLength) {
        return `${value.slice(0, previewLength)}... [truncated ${value.length - previewLength} chars]`;
    }
    return value;
};
const iconUrlMetaForLog = (value) => {
    if (typeof value !== "string") {
        return { kind: typeof value, valid: false };
    }
    const isDataUrl = value.startsWith("data:");
    const mimeMatch = isDataUrl ? /^data:([^;,]+)[;,]/.exec(value) : null;
    return {
        valid: true,
        type: isDataUrl ? "data-url" : "url",
        mimeType: mimeMatch?.[1] || undefined,
        length: value.length
    };
};
// @ts-ignore
export class UIPhosphorIcon extends HTMLElement {
    static get observedAttributes() {
        return ["icon", "icon-style", "size", "width", "icon-base"];
    }
    #options = {
        padding: 0,
        icon: "",
        iconStyle: "duotone",
    };
    #resizeObserver;
    #devicePixelSize = {
        inline: MIN_RASTER_SIZE,
        block: MIN_RASTER_SIZE,
    };
    #queuedMaskUpdate = null;
    #currentIconUrl = "";
    #maskKeyBase = "";
    #maskRef = { value: "" };
    #styleAttached = false;
    #pendingIconName = null;
    #intersectionObserver;
    #isIntersecting = false;
    constructor(options = {}) {
        super();
        Object.assign(this.#options, options);
        if (typeof options.icon === "string" && options.icon.length > 0) {
            this.setAttribute("icon", options.icon);
        }
        if (typeof options.iconStyle === "string" && options.iconStyle.length > 0) {
            this.setAttribute("icon-style", options.iconStyle.toLowerCase());
        }
        this.#ensureShadowRoot();
    }
    get icon() {
        return this.getAttribute("icon") ?? "";
    }
    set icon(value) {
        if (value == null || value === "") {
            this.removeAttribute("icon");
            return;
        }
        const normalized = String(value);
        if (this.getAttribute("icon") !== normalized) {
            this.setAttribute("icon", normalized);
        }
    }
    get iconStyle() {
        return this.getAttribute("icon-style") ?? this.#options.iconStyle ?? "duotone";
    }
    set iconStyle(value) {
        const normalized = (value ?? "")?.trim?.()?.toLowerCase?.();
        if (!normalized) {
            this.removeAttribute("icon-style");
            return;
        }
        if (this.getAttribute("icon-style") !== normalized) {
            this.setAttribute("icon-style", normalized);
        }
    }
    get size() {
        return this.getAttribute("size");
    }
    set size(value) {
        if (value == null || value === "") {
            this.removeAttribute("size");
            return;
        }
        const normalized = String(value);
        if (this.getAttribute("size") !== normalized) {
            this.setAttribute("size", normalized);
        }
    }
    get width() {
        return this.getAttribute("width");
    }
    set width(value) {
        if (value == null || value === "") {
            this.removeAttribute("width");
            return;
        }
        const normalized = typeof value === "number" ? String(value) : value;
        if (this.getAttribute("width") !== normalized) {
            this.setAttribute("width", normalized);
        }
    }
    /**
     * Optional base URL for same-origin icon hosting.
     * Example: icon-base="/assets/phosphor"
     * Will be tried before CDNs.
     */
    get iconBase() {
        return this.getAttribute("icon-base") ?? "";
    }
    set iconBase(value) {
        const normalized = (value ?? "").trim();
        if (!normalized) {
            this.removeAttribute("icon-base");
            return;
        }
        if (this.getAttribute("icon-base") !== normalized) {
            this.setAttribute("icon-base", normalized);
        }
    }
    connectedCallback() {
        this.#applyHostDefaults();
        this.#setupResizeObserver(this);
        this.#setupVisibilityObserver();
        if (!this.#styleAttached) {
            const styleNode = createStyle?.() ?? null;
            if (styleNode) {
                this.shadowRoot.appendChild(styleNode);
            }
            this.#styleAttached = true;
        }
        if (!this.hasAttribute("icon") && this.#options.icon) {
            this.setAttribute("icon", this.#options.icon);
        }
        if (!this.hasAttribute("icon-style") && this.#options.iconStyle) {
            this.setAttribute("icon-style", this.#options.iconStyle);
        }
        // Force load any pending icon immediately when connected
        const pendingIcon = this.#pendingIconName ?? this.icon;
        console.log(`[ui-icon] Element connected, pending icon: ${pendingIcon}, current icon: ${this.icon}`);
        if (pendingIcon) {
            console.log(`[ui-icon] Loading pending icon: ${pendingIcon}`);
            this.updateIcon(pendingIcon);
        }
        else if (this.icon) {
            console.log(`[ui-icon] Loading current icon: ${this.icon}`);
            this.updateIcon(this.icon);
        }
        else {
            console.log(`[ui-icon] No icon to load`);
        }
    }
    disconnectedCallback() {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = undefined;
        this.#teardownVisibilityObserver();
        this.#queuedMaskUpdate = null;
        this.#retryAttempt = 0;
    }
    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) {
            return;
        }
        switch (name) {
            case "icon": {
                if (!this.isConnected) {
                    this.#pendingIconName = newValue ?? "";
                    return;
                }
                this.updateIcon(newValue ?? "");
                break;
            }
            case "icon-style": {
                if (newValue) {
                    const normalized = newValue?.trim?.()?.toLowerCase?.();
                    if (normalized !== newValue) {
                        this.setAttribute("icon-style", normalized);
                        return;
                    }
                }
                this.#maskKeyBase = "";
                if (!this.isConnected) {
                    this.#pendingIconName = this.icon;
                    return;
                }
                this.updateIcon();
                break;
            }
            case "size": {
                if (newValue) {
                    this.style.setProperty("--icon-size", (typeof newValue === "number" || /^\d+$/.test(newValue)) ? `${newValue}px` : newValue);
                }
                else {
                    this.style.removeProperty("--icon-size");
                }
                if (this.isConnected) {
                    this.#queueMaskUpdate();
                }
                break;
            }
            case "width": {
                if (newValue == null || newValue === "") {
                    this.style.removeProperty("width");
                }
                else {
                    const value = (typeof newValue === "number" || /^\d+$/.test(newValue)) ? `${newValue}px` : newValue;
                    this.style.width = value;
                }
                if (this.isConnected) {
                    this.#queueMaskUpdate();
                }
                break;
            }
            case "icon-base": {
                // Changing base affects load source; force reload.
                this.#currentIconUrl = "";
                this.#maskKeyBase = "";
                if (this.isConnected) {
                    this.updateIcon(this.icon);
                }
                break;
            }
        }
    }
    #retryAttempt = 0;
    static #MAX_ICON_RETRIES = 3;
    static #RETRY_DELAY_MS = 500;
    updateIcon(icon) {
        const candidate = typeof icon === "string" && icon.length > 0 ? icon : this.icon;
        const nextIcon = candidate?.trim?.() ?? "";
        if (!this.isConnected) {
            this.#pendingIconName = nextIcon;
            return this;
        }
        if (typeof IntersectionObserver !== "undefined" && !this.#isIntersecting) {
            this.#pendingIconName = nextIcon;
            return this;
        }
        this.#pendingIconName = null;
        if (!nextIcon) {
            return this;
        }
        let iconStyle = (this.iconStyle ?? "duotone")?.trim?.()?.toLowerCase?.();
        const ICON = camelToKebab(nextIcon);
        // Use CDN for Phosphor icons (npm package assets; stable paths)
        // Example:
        // - https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/duotone/folder-open-duotone.svg
        // Validate icon name to prevent invalid requests
        if (!ICON || !/^[a-z0-9-]+$/.test(ICON)) {
            console.warn(`[ui-icon] Invalid icon name: ${ICON}`);
            return this;
        }
        // Validate icon style
        const validStyles = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'];
        if (!validStyles.includes(iconStyle)) {
            console.warn(`[ui-icon] Invalid icon style: ${iconStyle}, defaulting to 'duotone'`);
            iconStyle = 'duotone';
        }
        // For duotone icons, append '-duotone' to the filename
        // For other styles like 'fill', 'bold', etc., append '-{style}'
        const iconFileName = iconStyle === 'duotone' ? `${ICON}-duotone` :
            iconStyle !== 'regular' ? `${ICON}-${iconStyle}` :
                ICON;
        // Try direct CDN first (most reliable), then proxy (without suffix - proxy adds it), then local
        const directCdnPath = `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/${iconStyle}/${iconFileName}.svg`;
        const proxyCdnPath = `/assets/icons/phosphor/${iconStyle}/${ICON}.svg`; // Proxy expects base name, adds suffix
        const base = (this.iconBase ?? "").trim().replace(/\/+$/, "");
        const localPath = base ? `${base}/${iconStyle}/${iconFileName}.svg` : "";
        const requestKey = `${iconStyle}:${ICON}`;
        this.#maskKeyBase = requestKey;
        requestAnimationFrame(() => {
            // Always attempt to load if we don't have a current icon URL, or if we're intersecting
            const shouldLoad = !this.#currentIconUrl || this.#isIntersecting ||
                (this?.checkVisibility?.({
                    contentVisibilityAuto: true,
                    opacityProperty: true,
                    visibilityProperty: true,
                }) ?? true);
            console.log(`[ui-icon] Checking load conditions for ${requestKey}:`, {
                hasCurrentUrl: !!this.#currentIconUrl,
                isIntersecting: this.#isIntersecting,
                shouldLoad
            });
            if (shouldLoad) {
                const sources = (localPath ? [directCdnPath, proxyCdnPath, localPath] : [directCdnPath, proxyCdnPath]);
                (async () => {
                    let lastUrl = null;
                    let lastError = null;
                    for (const src of sources) {
                        try {
                            const url = await loadAsImage(src);
                            lastUrl = url;
                            // If local source returns fallback placeholder, try the CDN next.
                            if (src === localPath && url === FALLBACK_ICON_DATA_URL) {
                                continue;
                            }
                            break;
                        }
                        catch (e) {
                            lastError = e;
                        }
                    }
                    const url = lastUrl;
                    console.log(`[ui-icon] Loaded icon ${requestKey} (${localPath ? "local+proxy+fallback" : "proxy+fallback"}):`, iconUrlMetaForLog(url));
                    if (!url || typeof url !== "string") {
                        console.warn(`[ui-icon] Invalid URL returned for ${requestKey}:`, iconUrlMetaForLog(url));
                        return;
                    }
                    if (this.#maskKeyBase !== requestKey) {
                        console.log(`[ui-icon] Ignoring outdated request for ${requestKey}`);
                        return;
                    }
                    this.#currentIconUrl = url;
                    this.#retryAttempt = 0;
                    this.#queueMaskUpdate();
                    // If both sources failed and we ended up with fallback, keep the old retry behavior for timeouts.
                    if (url === FALLBACK_ICON_DATA_URL && lastError instanceof Error) {
                        const isTimeout = lastError.message.includes("Timeout");
                        if (isTimeout && this.#retryAttempt < UIPhosphorIcon.#MAX_ICON_RETRIES && this.isConnected) {
                            this.#retryAttempt++;
                            setTimeout(() => {
                                if (this.isConnected && this.#maskKeyBase === requestKey) {
                                    this.updateIcon(nextIcon);
                                }
                            }, UIPhosphorIcon.#RETRY_DELAY_MS * this.#retryAttempt);
                        }
                    }
                })().catch((error) => {
                    if (typeof console !== "undefined") {
                        console.error?.("[ui-icon] Failed to load icon sources", { directCdnPath, proxyCdnPath, localPath }, error);
                    }
                });
            }
        });
        return this;
    }
    #setupVisibilityObserver() {
        console.log(`[ui-icon] Setting up visibility observer`);
        if (typeof IntersectionObserver === "undefined") {
            console.log(`[ui-icon] IntersectionObserver not available, setting intersecting to true`);
            this.#isIntersecting = true;
            return;
        }
        if (this.#intersectionObserver) {
            console.log(`[ui-icon] Visibility observer already exists`);
            return;
        }
        console.log(`[ui-icon] Creating new IntersectionObserver`);
        this.#intersectionObserver = new IntersectionObserver((entries) => {
            const isIntersecting = entries.some((entry) => entry.isIntersecting);
            console.log(`[ui-icon] IntersectionObserver callback: isIntersecting=${isIntersecting}, was=${this.#isIntersecting}`);
            if (isIntersecting !== this.#isIntersecting) {
                this.#isIntersecting = isIntersecting;
                if (isIntersecting) {
                    console.log(`[ui-icon] Element became visible, updating icon`);
                    this.updateIcon(this.#pendingIconName ?? this.icon);
                }
            }
        }, { rootMargin: "100px" });
        console.log(`[ui-icon] Starting observation`);
        this.#intersectionObserver.observe(this);
        // Handle content-visibility
        // @ts-ignore
        this.addEventListener("contentvisibilityautostatechange", this.#handleContentVisibility);
        // Initially assume intersecting to allow loading
        console.log(`[ui-icon] Setting initial intersecting state to true`);
        this.#isIntersecting = true;
    }
    #teardownVisibilityObserver() {
        this.#intersectionObserver?.disconnect();
        this.#intersectionObserver = undefined;
        // @ts-ignore
        this.removeEventListener("contentvisibilityautostatechange", this.#handleContentVisibility);
    }
    #handleContentVisibility = (e) => {
        // @ts-ignore
        if (e.skipped === false) {
            this.updateIcon(this.#pendingIconName ?? this.icon);
        }
    };
    #ensureShadowRoot() {
        if (!this.shadowRoot) {
            this.attachShadow({ mode: "open" });
        }
    }
    #applyHostDefaults() {
        this.classList.add("ui-icon", "u2-icon");
        try {
            this.inert = true;
        }
        catch {
            this.setAttribute("inert", "");
        }
        /*if (!this.hasAttribute("aria-hidden")) {
            this.setAttribute("aria-hidden", "true");
        }*/
        const paddingOption = this.#options.padding;
        if (!this.style.getPropertyValue("--icon-padding") &&
            paddingOption !== undefined &&
            paddingOption !== null &&
            paddingOption !== "") {
            const paddingValue = typeof paddingOption === "number" ? `${paddingOption}rem` : String(paddingOption);
            this.style.setProperty("--icon-padding", paddingValue);
        }
        const sizeAttr = this.getAttribute("size");
        if (sizeAttr) {
            this.style.setProperty("--icon-size", (typeof sizeAttr === "number" || /^\d+$/.test(sizeAttr)) ? `${sizeAttr}px` : sizeAttr);
        }
        // Note: --icon-image is now set via CSS rules with attribute selectors
        // e.g., ui-icon[icon="house"][icon-style="duotone"] { --icon-image: image-set(...); }
        // No inline style needed - the CSS registry handles it lazily
    }
    #setupResizeObserver(element) {
        if (typeof ResizeObserver === "undefined" || this.#resizeObserver) {
            return;
        }
        this.#resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target !== element) {
                    continue;
                }
                const deviceSize = entry.devicePixelContentBoxSize?.[0];
                const contentSize = Array.isArray(entry.contentBoxSize)
                    ? entry.contentBoxSize[0]
                    : entry.contentBoxSize;
                const ratio = typeof devicePixelRatio === "number" && isFinite(devicePixelRatio)
                    ? devicePixelRatio
                    : 1;
                const inline = deviceSize?.inlineSize ??
                    (contentSize?.inlineSize ?? entry.contentRect?.width ?? element.clientWidth ?? MIN_RASTER_SIZE) *
                        ratio;
                const block = deviceSize?.blockSize ??
                    (contentSize?.blockSize ?? entry.contentRect?.height ?? element.clientHeight ?? MIN_RASTER_SIZE) *
                        ratio;
                this.#devicePixelSize = {
                    inline: inline || MIN_RASTER_SIZE,
                    block: block || MIN_RASTER_SIZE,
                };
                this.#queueMaskUpdate();
            }
        });
        try {
            this.#resizeObserver.observe(element, { box: "device-pixel-content-box" });
        }
        catch {
            this.#resizeObserver.observe(element);
        }
    }
    #queueMaskUpdate() {
        if (!this.#currentIconUrl || !this.isConnected) {
            return;
        }
        if (this.#queuedMaskUpdate) {
            return;
        }
        const forResolve = Promise.withResolvers();
        this.#queuedMaskUpdate = forResolve?.promise;
        requestAnimationFrame(() => {
            this.#queuedMaskUpdate = null;
            forResolve?.resolve();
            const url = this.#currentIconUrl;
            if (!url || !this.isConnected) {
                return;
            }
            const bucket = this.#getRasterBucket();
            const iconName = camelToKebab(this.icon);
            const iconStyle = this.iconStyle;
            // Check if CSS rule already exists for this icon combination
            if (hasIconRule(iconName, iconStyle, bucket)) {
                // Rule exists, CSS handles the styling via attribute selectors
                return;
            }
            // Generate mask value and register CSS rule
            ensureMaskValue(url, this.#maskKeyBase, bucket)
                .then((maskValue) => {
                console.log(`[ui-icon] Got mask value for ${iconName}:${iconStyle}:`, iconUrlMetaForLog(maskValue));
                // Register the icon in CSS registry with attribute-based selector
                // The rule: ui-icon[icon="name"][icon-style="style"] { --icon-image: ... }
                registerIconRule(iconName, iconStyle, maskValue, bucket);
                console.log(`[ui-icon] Registered CSS rule for ${iconName}:${iconStyle}`);
                // Keep local ref for fallback/debugging
                if (this.#maskRef.value !== maskValue) {
                    this.#maskRef.value = maskValue;
                }
            })
                .catch((error) => {
                if (typeof console !== "undefined") {
                    console.warn?.("[ui-icon] Mask update failed", error);
                }
            });
        });
    }
    #getRasterBucket() {
        const self = this;
        const inline = Math.ceil(this.#devicePixelSize?.inline || 0);
        const block = Math.ceil(this.#devicePixelSize?.block || 0);
        const candidate = Math.max(inline, block);
        if (candidate > 0) {
            return quantizeToBucket(candidate);
        }
        let fallback = MIN_RASTER_SIZE;
        const ratio = typeof devicePixelRatio === "number" && isFinite(devicePixelRatio)
            ? devicePixelRatio
            : 1;
        if (typeof self.getBoundingClientRect === "function") {
            const rect = self.getBoundingClientRect();
            const maximum = Math.max(rect.width, rect.height) * ratio;
            if (maximum > 0) {
                fallback = maximum;
            }
        }
        return quantizeToBucket(fallback);
    }
}
if (typeof window !== "undefined" && !customElements.get("ui-icon")) {
    console.log(UIPhosphorIcon);
    customElements.define("ui-icon", UIPhosphorIcon);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUGhvc3Bob3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJQaG9zcGhvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxRUFBcUU7QUFDckUsTUFBTSxDQUFDLE1BQU0sWUFBWSxHQUFHLENBQUMsT0FBZSxFQUFFLEVBQUU7SUFDNUMsTUFBTSxPQUFPLEdBQUcsT0FBTyxPQUFPLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3JFLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUMsSUFBK0IsQ0FBQztJQUFDLENBQUM7SUFDL0QsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLGVBQWUsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUMsSUFBSSxFQUFFLFVBQVUsRUFBQyxDQUFDLENBQUMsQ0FBQztJQUU5RSxFQUFFO0lBQ0YsSUFBSSxPQUFPLFFBQVEsS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUFDLE9BQU8sSUFBSSxDQUFDO0lBQUMsQ0FBQztJQUNyRCxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsYUFBYSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ2hELE9BQU8sQ0FBQyxZQUFZLENBQUMsdUJBQXVCLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDdEQsT0FBTyxDQUFDLFNBQVMsR0FBRyxnQkFBZ0IsUUFBUSxLQUFLLENBQUM7SUFFbEQsRUFBRTtJQUNGLE9BQU8sR0FBRyxFQUFFLENBQUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQUEsQ0FBQztBQUM3QyxDQUFDLENBQUM7QUFFRixrQ0FBa0M7QUFDbEMsT0FBTyxNQUFNLE1BQU0sd0JBQXdCLENBQUM7QUFDNUMsT0FBTyxFQUNILGVBQWUsRUFDZixXQUFXLEVBQ1gsc0JBQXNCLEVBQ3RCLGVBQWUsRUFDZixnQkFBZ0IsRUFDaEIsWUFBWSxFQUVaLGdCQUFnQixFQUNoQixXQUFXLEdBRWQsTUFBTSxVQUFVLENBQUM7QUFFbEIsRUFBRTtBQUNGLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUV6QywrQ0FBK0M7QUFDL0MsTUFBTSxxQkFBcUIsR0FBRyxDQUFDLEdBQVksRUFBRSxFQUFFO0lBQzNDLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFBQyxPQUFPLEdBQUcsQ0FBQztJQUFDLENBQUM7SUFDaEUsT0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDO0FBRUYsTUFBTSxzQkFBc0IsR0FBRyxDQUFDLEtBQWMsRUFBRSxhQUFhLEdBQUcsR0FBRyxFQUFXLEVBQUU7SUFDNUUsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUFDLE9BQU8sS0FBSyxDQUFDO0lBQUMsQ0FBQztJQUNoRCxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7UUFBQyxPQUFPLEtBQUssQ0FBQztJQUFDLENBQUM7SUFFN0IsSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDNUIsTUFBTSxTQUFTLEdBQUcsb0JBQW9CLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25ELE1BQU0sUUFBUSxHQUFHLFNBQVMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLDBCQUEwQixDQUFDO1FBQzlELE9BQU8sYUFBYSxRQUFRLFlBQVksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO0lBQzVELENBQUM7SUFFRCxJQUFJLEtBQUssQ0FBQyxNQUFNLEdBQUcsYUFBYSxFQUFFLENBQUM7UUFDL0IsT0FBTyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLGFBQWEsQ0FBQyxrQkFBa0IsS0FBSyxDQUFDLE1BQU0sR0FBRyxhQUFhLFNBQVMsQ0FBQztJQUNuRyxDQUFDO0lBRUQsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQyxDQUFDO0FBRUYsTUFBTSxpQkFBaUIsR0FBRyxDQUFDLEtBQWMsRUFBMkIsRUFBRTtJQUNsRSxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzVCLE9BQU8sRUFBRSxJQUFJLEVBQUUsT0FBTyxLQUFLLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQ2hELENBQUM7SUFFRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzVDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDdEUsT0FBTztRQUNILEtBQUssRUFBRSxJQUFJO1FBQ1gsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxLQUFLO1FBQ3BDLFFBQVEsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxTQUFTO1FBQ3JDLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTTtLQUN2QixDQUFDO0FBQ04sQ0FBQyxDQUFDO0FBRUYsYUFBYTtBQUNiLE1BQU0sT0FBTyxjQUFlLFNBQVEsV0FBVztJQUMzQyxNQUFNLEtBQUssa0JBQWtCO1FBQ3pCLE9BQU8sQ0FBQyxNQUFNLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsV0FBVyxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUVELFFBQVEsR0FBcUU7UUFDekUsT0FBTyxFQUFFLENBQUM7UUFDVixJQUFJLEVBQUUsRUFBRTtRQUNSLFNBQVMsRUFBRSxTQUFTO0tBQ3ZCLENBQUM7SUFDRixlQUFlLENBQWtCO0lBQ2pDLGdCQUFnQixHQUFvQjtRQUNoQyxNQUFNLEVBQUUsZUFBZTtRQUN2QixLQUFLLEVBQUUsZUFBZTtLQUN6QixDQUFDO0lBQ0YsaUJBQWlCLEdBQXlCLElBQUksQ0FBQztJQUMvQyxlQUFlLEdBQUcsRUFBRSxDQUFDO0lBQ3JCLFlBQVksR0FBRyxFQUFFLENBQUM7SUFDbEIsUUFBUSxHQUFHLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxDQUFDO0lBQ3pCLGNBQWMsR0FBRyxLQUFLLENBQUM7SUFDdkIsZ0JBQWdCLEdBQWtCLElBQUksQ0FBQztJQUN2QyxxQkFBcUIsQ0FBd0I7SUFDN0MsZUFBZSxHQUFHLEtBQUssQ0FBQztJQUV4QixZQUNJLFVBQWtGLEVBQUU7UUFFcEYsS0FBSyxFQUFFLENBQUM7UUFDUixNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFFdEMsSUFBSSxPQUFPLE9BQU8sQ0FBQyxJQUFJLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzlELElBQUksQ0FBQyxZQUFZLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM1QyxDQUFDO1FBRUQsSUFBSSxPQUFPLE9BQU8sQ0FBQyxTQUFTLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ3hFLElBQUksQ0FBQyxZQUFZLENBQUMsWUFBWSxFQUFFLE9BQU8sQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBRUQsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7SUFDN0IsQ0FBQztJQUVELElBQUksSUFBSTtRQUNKLE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDM0MsQ0FBQztJQUVELElBQUksSUFBSSxDQUFDLEtBQWE7UUFDbEIsSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFFLEVBQUUsQ0FBQztZQUNoQyxJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzdCLE9BQU87UUFDWCxDQUFDO1FBQ0QsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pDLElBQUksSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUMzQyxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMxQyxDQUFDO0lBQ0wsQ0FBQztJQUVELElBQUksU0FBUztRQUNULE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQyxZQUFZLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLFNBQVMsSUFBSSxTQUFTLENBQUM7SUFDbkYsQ0FBQztJQUVELElBQUksU0FBUyxDQUFDLEtBQWE7UUFDdkIsTUFBTSxVQUFVLEdBQUcsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsRUFBRSxXQUFXLEVBQUUsRUFBRSxDQUFDO1FBQzVELElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxlQUFlLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDbkMsT0FBTztRQUNYLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxZQUFZLENBQUMsWUFBWSxDQUFDLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDakQsSUFBSSxDQUFDLFlBQVksQ0FBQyxZQUFZLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDaEQsQ0FBQztJQUNMLENBQUM7SUFFRCxJQUFJLElBQUk7UUFDSixPQUFPLElBQUksQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVELElBQUksSUFBSSxDQUFDLEtBQW9CO1FBQ3pCLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLEtBQUssRUFBRSxFQUFFLENBQUM7WUFDaEMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUM3QixPQUFPO1FBQ1gsQ0FBQztRQUNELE1BQU0sVUFBVSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQyxJQUFJLElBQUksQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDM0MsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDMUMsQ0FBQztJQUNMLENBQUM7SUFFRCxJQUFJLEtBQUs7UUFDTCxPQUFPLElBQUksQ0FBQyxZQUFZLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDdEMsQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLEtBQTZCO1FBQ25DLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLEtBQUssRUFBRSxFQUFFLENBQUM7WUFDaEMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUM5QixPQUFPO1FBQ1gsQ0FBQztRQUNELE1BQU0sVUFBVSxHQUFHLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7UUFDckUsSUFBSSxJQUFJLENBQUMsWUFBWSxDQUFDLE9BQU8sQ0FBQyxLQUFLLFVBQVUsRUFBRSxDQUFDO1lBQzVDLElBQUksQ0FBQyxZQUFZLENBQUMsT0FBTyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBQzNDLENBQUM7SUFDTCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILElBQUksUUFBUTtRQUNSLE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDaEQsQ0FBQztJQUVELElBQUksUUFBUSxDQUFDLEtBQWE7UUFDdEIsTUFBTSxVQUFVLEdBQUcsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDeEMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUNsQyxPQUFPO1FBQ1gsQ0FBQztRQUNELElBQUksSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNoRCxJQUFJLENBQUMsWUFBWSxDQUFDLFdBQVcsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMvQyxDQUFDO0lBQ0wsQ0FBQztJQUVELGlCQUFpQjtRQUNiLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1FBQzFCLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNoQyxJQUFJLENBQUMsd0JBQXdCLEVBQUUsQ0FBQztRQUVoQyxJQUFJLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1lBQ3ZCLE1BQU0sU0FBUyxHQUFHLFdBQVcsRUFBRSxFQUFFLElBQUksSUFBSSxDQUFDO1lBQzFDLElBQUksU0FBUyxFQUFFLENBQUM7Z0JBQUMsSUFBSSxDQUFDLFVBQVcsQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLENBQUM7WUFBQyxDQUFDO1lBQzNELElBQUksQ0FBQyxjQUFjLEdBQUcsSUFBSSxDQUFDO1FBQy9CLENBQUM7UUFFRCxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ25ELElBQUksQ0FBQyxZQUFZLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDbEQsQ0FBQztRQUNELElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDOUQsSUFBSSxDQUFDLFlBQVksQ0FBQyxZQUFZLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM3RCxDQUFDO1FBRUQseURBQXlEO1FBQ3pELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ3ZELE9BQU8sQ0FBQyxHQUFHLENBQUMsOENBQThDLFdBQVcsbUJBQW1CLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBRXJHLElBQUksV0FBVyxFQUFFLENBQUM7WUFDZCxPQUFPLENBQUMsR0FBRyxDQUFDLG1DQUFtQyxXQUFXLEVBQUUsQ0FBQyxDQUFDO1lBQzlELElBQUksQ0FBQyxVQUFVLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDakMsQ0FBQzthQUFNLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ25CLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUNBQW1DLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQzVELElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQy9CLENBQUM7YUFBTSxDQUFDO1lBQ0osT0FBTyxDQUFDLEdBQUcsQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO1FBQzdDLENBQUM7SUFDTCxDQUFDO0lBRUQsb0JBQW9CO1FBQ2hCLElBQUksQ0FBQyxlQUFlLEVBQUUsVUFBVSxFQUFFLENBQUM7UUFDbkMsSUFBSSxDQUFDLGVBQWUsR0FBRyxTQUFTLENBQUM7UUFDakMsSUFBSSxDQUFDLDJCQUEyQixFQUFFLENBQUM7UUFDbkMsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztRQUM5QixJQUFJLENBQUMsYUFBYSxHQUFHLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBRUQsd0JBQXdCLENBQUMsSUFBWSxFQUFFLFFBQXVCLEVBQUUsUUFBdUI7UUFDbkYsSUFBSSxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7WUFBQyxPQUFPO1FBQUMsQ0FBQztRQUV0QyxRQUFRLElBQUksRUFBRSxDQUFDO1lBQ1gsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDO2dCQUNWLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxRQUFRLElBQUksRUFBRSxDQUFDO29CQUN2QyxPQUFPO2dCQUNYLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLFVBQVUsQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBQ2hDLE1BQU07WUFDVixDQUFDO1lBQ0QsS0FBSyxZQUFZLENBQUMsQ0FBQyxDQUFDO2dCQUNoQixJQUFJLFFBQVEsRUFBRSxDQUFDO29CQUNYLE1BQU0sVUFBVSxHQUFHLFFBQVEsRUFBRSxJQUFJLEVBQUUsRUFBRSxFQUFFLFdBQVcsRUFBRSxFQUFFLENBQUM7b0JBQ3ZELElBQUksVUFBVSxLQUFLLFFBQVEsRUFBRSxDQUFDO3dCQUMxQixJQUFJLENBQUMsWUFBWSxDQUFDLFlBQVksRUFBRSxVQUFVLENBQUMsQ0FBQzt3QkFDNUMsT0FBTztvQkFDWCxDQUFDO2dCQUNMLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLFlBQVksR0FBRyxFQUFFLENBQUM7Z0JBQ3ZCLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO29CQUNsQyxPQUFPO2dCQUNYLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO2dCQUNsQixNQUFNO1lBQ1YsQ0FBQztZQUNELEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQztnQkFDVixJQUFJLFFBQVEsRUFBRSxDQUFDO29CQUNYLElBQUksQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLGFBQWEsRUFBRSxDQUFDLE9BQU8sUUFBUSxLQUFLLFFBQVEsSUFBSSxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsUUFBUSxJQUFJLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDO2dCQUNqSSxDQUFDO3FCQUFNLENBQUM7b0JBQ0osSUFBSSxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsYUFBYSxDQUFDLENBQUM7Z0JBQzdDLENBQUM7Z0JBQ0QsSUFBSSxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQ25CLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2dCQUM1QixDQUFDO2dCQUNELE1BQU07WUFDVixDQUFDO1lBQ0QsS0FBSyxPQUFPLENBQUMsQ0FBQyxDQUFDO2dCQUNYLElBQUksUUFBUSxJQUFJLElBQUksSUFBSSxRQUFRLEtBQUssRUFBRSxFQUFFLENBQUM7b0JBQ3RDLElBQUksQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLE9BQU8sQ0FBQyxDQUFDO2dCQUN2QyxDQUFDO3FCQUFNLENBQUM7b0JBQ0osTUFBTSxLQUFLLEdBQUcsQ0FBQyxPQUFPLFFBQVEsS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLFFBQVEsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7b0JBQ3BHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztnQkFDN0IsQ0FBQztnQkFDRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztvQkFDbkIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7Z0JBQzVCLENBQUM7Z0JBQ0QsTUFBTTtZQUNWLENBQUM7WUFDRCxLQUFLLFdBQVcsQ0FBQyxDQUFDLENBQUM7Z0JBQ2YsbURBQW1EO2dCQUNuRCxJQUFJLENBQUMsZUFBZSxHQUFHLEVBQUUsQ0FBQztnQkFDMUIsSUFBSSxDQUFDLFlBQVksR0FBRyxFQUFFLENBQUM7Z0JBQ3ZCLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO29CQUNuQixJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDL0IsQ0FBQztnQkFDRCxNQUFNO1lBQ1YsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQsYUFBYSxHQUFHLENBQUMsQ0FBQztJQUNsQixNQUFNLENBQVUsaUJBQWlCLEdBQUcsQ0FBQyxDQUFDO0lBQ3RDLE1BQU0sQ0FBVSxlQUFlLEdBQUcsR0FBRyxDQUFDO0lBRS9CLFVBQVUsQ0FBQyxJQUFhO1FBQzNCLE1BQU0sU0FBUyxHQUFHLE9BQU8sSUFBSSxLQUFLLFFBQVEsSUFBSSxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ2pGLE1BQU0sUUFBUSxHQUFHLFNBQVMsRUFBRSxJQUFJLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQztRQUUzQyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxRQUFRLENBQUM7WUFDakMsT0FBTyxJQUFJLENBQUM7UUFDaEIsQ0FBQztRQUVELElBQUksT0FBTyxvQkFBb0IsS0FBSyxXQUFXLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7WUFDdkUsSUFBSSxDQUFDLGdCQUFnQixHQUFHLFFBQVEsQ0FBQztZQUNqQyxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO1FBRUQsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQztRQUU3QixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFBQyxPQUFPLElBQUksQ0FBQztRQUFDLENBQUM7UUFFL0IsSUFBSSxTQUFTLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxJQUFJLFNBQVMsQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsV0FBVyxFQUFFLEVBQUUsQ0FBQztRQUN6RSxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDcEMsZ0VBQWdFO1FBQ2hFLFdBQVc7UUFDWCwrRkFBK0Y7UUFDL0YsaURBQWlEO1FBQ2pELElBQUksQ0FBQyxJQUFJLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDdEMsT0FBTyxDQUFDLElBQUksQ0FBQyxnQ0FBZ0MsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUNyRCxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO1FBRUQsc0JBQXNCO1FBQ3RCLE1BQU0sV0FBVyxHQUFHLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztRQUM1RSxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1lBQ25DLE9BQU8sQ0FBQyxJQUFJLENBQUMsaUNBQWlDLFNBQVMsMkJBQTJCLENBQUMsQ0FBQztZQUNwRixTQUFTLEdBQUcsU0FBUyxDQUFDO1FBQzFCLENBQUM7UUFFRCx1REFBdUQ7UUFDdkQsZ0VBQWdFO1FBQ2hFLE1BQU0sWUFBWSxHQUFHLFNBQVMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxVQUFVLENBQUMsQ0FBQztZQUM5QyxTQUFTLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxTQUFTLEVBQUUsQ0FBQyxDQUFDO2dCQUNsRCxJQUFJLENBQUM7UUFFekIsZ0dBQWdHO1FBQ2hHLE1BQU0sYUFBYSxHQUFHLDhEQUE4RCxTQUFTLElBQUksWUFBWSxNQUFNLENBQUM7UUFDcEgsTUFBTSxZQUFZLEdBQUcsMEJBQTBCLFNBQVMsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLHVDQUF1QztRQUMvRyxNQUFNLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztRQUM5RCxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLFNBQVMsSUFBSSxZQUFZLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3pFLE1BQU0sVUFBVSxHQUFHLEdBQUcsU0FBUyxJQUFJLElBQUksRUFBRSxDQUFDO1FBRTFDLElBQUksQ0FBQyxZQUFZLEdBQUcsVUFBVSxDQUFDO1FBRS9CLHFCQUFxQixDQUFDLEdBQUcsRUFBRTtZQUN2Qix1RkFBdUY7WUFDdkYsTUFBTSxVQUFVLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxJQUFJLElBQUksQ0FBQyxlQUFlO2dCQUM1RCxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsQ0FBQztvQkFDckIscUJBQXFCLEVBQUUsSUFBSTtvQkFDM0IsZUFBZSxFQUFFLElBQUk7b0JBQ3JCLGtCQUFrQixFQUFFLElBQUk7aUJBQzNCLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQztZQUVoQixPQUFPLENBQUMsR0FBRyxDQUFDLDBDQUEwQyxVQUFVLEdBQUcsRUFBRTtnQkFDakUsYUFBYSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsZUFBZTtnQkFDckMsY0FBYyxFQUFFLElBQUksQ0FBQyxlQUFlO2dCQUNwQyxVQUFVO2FBQ2IsQ0FBQyxDQUFDO1lBRUgsSUFBSSxVQUFVLEVBQUUsQ0FBQztnQkFDYixNQUFNLE9BQU8sR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLEVBQUUsWUFBWSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsRUFBRSxZQUFZLENBQUMsQ0FBQyxDQUFDO2dCQUN2RyxDQUFDLEtBQUssSUFBSSxFQUFFO29CQUNSLElBQUksT0FBTyxHQUFrQixJQUFJLENBQUM7b0JBQ2xDLElBQUksU0FBUyxHQUFZLElBQUksQ0FBQztvQkFFOUIsS0FBSyxNQUFNLEdBQUcsSUFBSSxPQUFPLEVBQUUsQ0FBQzt3QkFDeEIsSUFBSSxDQUFDOzRCQUNELE1BQU0sR0FBRyxHQUFHLE1BQU0sV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDOzRCQUNuQyxPQUFPLEdBQUcsR0FBRyxDQUFDOzRCQUVkLGtFQUFrRTs0QkFDbEUsSUFBSSxHQUFHLEtBQUssU0FBUyxJQUFJLEdBQUcsS0FBSyxzQkFBc0IsRUFBRSxDQUFDO2dDQUN0RCxTQUFTOzRCQUNiLENBQUM7NEJBQ0QsTUFBTTt3QkFDVixDQUFDO3dCQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7NEJBQ1QsU0FBUyxHQUFHLENBQUMsQ0FBQzt3QkFDbEIsQ0FBQztvQkFDTCxDQUFDO29CQUVELE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQztvQkFDcEIsT0FBTyxDQUFDLEdBQUcsQ0FDUCx5QkFBeUIsVUFBVSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsc0JBQXNCLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixJQUFJLEVBQ2pHLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxDQUN6QixDQUFDO29CQUNGLElBQUksQ0FBQyxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7d0JBQ2xDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0NBQXNDLFVBQVUsR0FBRyxFQUFFLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7d0JBQzFGLE9BQU87b0JBQ1gsQ0FBQztvQkFDRCxJQUFJLElBQUksQ0FBQyxZQUFZLEtBQUssVUFBVSxFQUFFLENBQUM7d0JBQ25DLE9BQU8sQ0FBQyxHQUFHLENBQUMsMkNBQTJDLFVBQVUsRUFBRSxDQUFDLENBQUM7d0JBQ3JFLE9BQU87b0JBQ1gsQ0FBQztvQkFDRCxJQUFJLENBQUMsZUFBZSxHQUFHLEdBQUcsQ0FBQztvQkFDM0IsSUFBSSxDQUFDLGFBQWEsR0FBRyxDQUFDLENBQUM7b0JBQ3ZCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO29CQUV4QixrR0FBa0c7b0JBQ2xHLElBQUksR0FBRyxLQUFLLHNCQUFzQixJQUFJLFNBQVMsWUFBWSxLQUFLLEVBQUUsQ0FBQzt3QkFDL0QsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUM7d0JBQ3hELElBQUksU0FBUyxJQUFJLElBQUksQ0FBQyxhQUFhLEdBQUcsY0FBYyxDQUFDLGlCQUFpQixJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQzs0QkFDekYsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDOzRCQUNyQixVQUFVLENBQUMsR0FBRyxFQUFFO2dDQUNaLElBQUksSUFBSSxDQUFDLFdBQVcsSUFBSSxJQUFJLENBQUMsWUFBWSxLQUFLLFVBQVUsRUFBRSxDQUFDO29DQUN2RCxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxDQUFDO2dDQUM5QixDQUFDOzRCQUNMLENBQUMsRUFBRSxjQUFjLENBQUMsZUFBZSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQzt3QkFDNUQsQ0FBQztvQkFDTCxDQUFDO2dCQUNMLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7b0JBQ2pCLElBQUksT0FBTyxPQUFPLEtBQUssV0FBVyxFQUFFLENBQUM7d0JBQ2pDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsQ0FBQyx1Q0FBdUMsRUFBRSxFQUFFLGFBQWEsRUFBRSxZQUFZLEVBQUUsU0FBUyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7b0JBQ2hILENBQUM7Z0JBQ0wsQ0FBQyxDQUFDLENBQUM7WUFDUCxDQUFDO1FBQ0wsQ0FBQyxDQUFDLENBQUM7UUFFSCxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBRUQsd0JBQXdCO1FBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsMENBQTBDLENBQUMsQ0FBQztRQUV4RCxJQUFJLE9BQU8sb0JBQW9CLEtBQUssV0FBVyxFQUFFLENBQUM7WUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyw0RUFBNEUsQ0FBQyxDQUFDO1lBQzFGLElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxDQUFDO1lBQzVCLE9BQU87UUFDWCxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztZQUM3QixPQUFPLENBQUMsR0FBRyxDQUFDLDhDQUE4QyxDQUFDLENBQUM7WUFDNUQsT0FBTztRQUNYLENBQUM7UUFFRCxPQUFPLENBQUMsR0FBRyxDQUFDLDZDQUE2QyxDQUFDLENBQUM7UUFDM0QsSUFBSSxDQUFDLHFCQUFxQixHQUFHLElBQUksb0JBQW9CLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtZQUM5RCxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7WUFDckUsT0FBTyxDQUFDLEdBQUcsQ0FBQywyREFBMkQsY0FBYyxTQUFTLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQyxDQUFDO1lBRXRILElBQUksY0FBYyxLQUFLLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztnQkFDMUMsSUFBSSxDQUFDLGVBQWUsR0FBRyxjQUFjLENBQUM7Z0JBQ3RDLElBQUksY0FBYyxFQUFFLENBQUM7b0JBQ2pCLE9BQU8sQ0FBQyxHQUFHLENBQUMsaURBQWlELENBQUMsQ0FBQztvQkFDL0QsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN4RCxDQUFDO1lBQ0wsQ0FBQztRQUNMLENBQUMsRUFBRSxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBRTVCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0NBQWdDLENBQUMsQ0FBQztRQUM5QyxJQUFJLENBQUMscUJBQXFCLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRXpDLDRCQUE0QjtRQUM1QixhQUFhO1FBQ2IsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGtDQUFrQyxFQUFFLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1FBRXpGLGlEQUFpRDtRQUNqRCxPQUFPLENBQUMsR0FBRyxDQUFDLHNEQUFzRCxDQUFDLENBQUM7UUFDcEUsSUFBSSxDQUFDLGVBQWUsR0FBRyxJQUFJLENBQUM7SUFDaEMsQ0FBQztJQUVELDJCQUEyQjtRQUN2QixJQUFJLENBQUMscUJBQXFCLEVBQUUsVUFBVSxFQUFFLENBQUM7UUFDekMsSUFBSSxDQUFDLHFCQUFxQixHQUFHLFNBQVMsQ0FBQztRQUN2QyxhQUFhO1FBQ2IsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGtDQUFrQyxFQUFFLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ2hHLENBQUM7SUFFRCx3QkFBd0IsR0FBRyxDQUFDLENBQVEsRUFBRSxFQUFFO1FBQ3BDLGFBQWE7UUFDYixJQUFJLENBQUMsQ0FBQyxPQUFPLEtBQUssS0FBSyxFQUFFLENBQUM7WUFDdEIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3hELENBQUM7SUFDTCxDQUFDLENBQUE7SUFFRCxpQkFBaUI7UUFDYixJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ25CLElBQUksQ0FBQyxZQUFZLENBQUMsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUN4QyxDQUFDO0lBQ0wsQ0FBQztJQUVELGtCQUFrQjtRQUNkLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQztRQUV6QyxJQUFJLENBQUM7WUFDQSxJQUFzQyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUM7UUFDekQsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNMLElBQUksQ0FBQyxZQUFZLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ25DLENBQUM7UUFFRDs7V0FFRztRQUVILE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDO1FBQzVDLElBQ0ksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLGdCQUFnQixDQUFDLGdCQUFnQixDQUFDO1lBQzlDLGFBQWEsS0FBSyxTQUFTO1lBQzNCLGFBQWEsS0FBSyxJQUFJO1lBQ3RCLGFBQWEsS0FBSyxFQUFFLEVBQ3RCLENBQUM7WUFDQyxNQUFNLFlBQVksR0FDZCxPQUFPLGFBQWEsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsYUFBYSxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsQ0FBQztZQUN0RixJQUFJLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxnQkFBZ0IsRUFBRSxZQUFZLENBQUMsQ0FBQztRQUMzRCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUMzQyxJQUFJLFFBQVEsRUFBRSxDQUFDO1lBQ1gsSUFBSSxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsYUFBYSxFQUFFLENBQUMsT0FBTyxRQUFRLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxRQUFRLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDakksQ0FBQztRQUVELHVFQUF1RTtRQUN2RSxzRkFBc0Y7UUFDdEYsOERBQThEO0lBQ2xFLENBQUM7SUFFRCxvQkFBb0IsQ0FBQyxPQUFvQjtRQUNyQyxJQUFJLE9BQU8sY0FBYyxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7WUFBQyxPQUFPO1FBQUMsQ0FBQztRQUM5RSxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksY0FBYyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUU7WUFDbEQsS0FBSyxNQUFNLEtBQUssSUFBSSxPQUFPLEVBQUUsQ0FBQztnQkFDMUIsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLE9BQU8sRUFBRSxDQUFDO29CQUFDLFNBQVM7Z0JBQUMsQ0FBQztnQkFFM0MsTUFBTSxVQUFVLEdBQUcsS0FBSyxDQUFDLHlCQUF5QixFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7Z0JBQ3hELE1BQU0sV0FBVyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLGNBQWMsQ0FBQztvQkFDbkQsQ0FBQyxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDO29CQUN6QixDQUFDLENBQUUsS0FBSyxDQUFDLGNBQTRELENBQUM7Z0JBRTFFLE1BQU0sS0FBSyxHQUNQLE9BQU8sZ0JBQWdCLEtBQUssUUFBUSxJQUFJLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQztvQkFDOUQsQ0FBQyxDQUFDLGdCQUFnQjtvQkFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFFWixNQUFNLE1BQU0sR0FDUixVQUFVLEVBQUUsVUFBVTtvQkFDdEIsQ0FBQyxXQUFXLEVBQUUsVUFBVSxJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsS0FBSyxJQUFJLE9BQU8sQ0FBQyxXQUFXLElBQUksZUFBZSxDQUFDO3dCQUMzRixLQUFLLENBQUM7Z0JBQ2QsTUFBTSxLQUFLLEdBQ1AsVUFBVSxFQUFFLFNBQVM7b0JBQ3JCLENBQUMsV0FBVyxFQUFFLFNBQVMsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLE1BQU0sSUFBSSxPQUFPLENBQUMsWUFBWSxJQUFJLGVBQWUsQ0FBQzt3QkFDNUYsS0FBSyxDQUFDO2dCQUVkLElBQUksQ0FBQyxnQkFBZ0IsR0FBRztvQkFDcEIsTUFBTSxFQUFFLE1BQU0sSUFBSSxlQUFlO29CQUNqQyxLQUFLLEVBQUUsS0FBSyxJQUFJLGVBQWU7aUJBQ2xDLENBQUM7Z0JBQ0YsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDNUIsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDO1lBQ0QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsR0FBRyxFQUFFLDBCQUFtQyxFQUFFLENBQUMsQ0FBQztRQUN4RixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ0wsSUFBSSxDQUFDLGVBQWUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDMUMsQ0FBQztJQUNMLENBQUM7SUFFRCxnQkFBZ0I7UUFDWixJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUFDLE9BQU87UUFBQyxDQUFDO1FBQzNELElBQUksSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7WUFBQyxPQUFPO1FBQUMsQ0FBQztRQUV2QyxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsYUFBYSxFQUFRLENBQUM7UUFDakQsSUFBSSxDQUFDLGlCQUFpQixHQUFHLFVBQVUsRUFBRSxPQUFPLENBQUM7UUFDN0MscUJBQXFCLENBQUMsR0FBRyxFQUFFO1lBQ3ZCLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsVUFBVSxFQUFFLE9BQU8sRUFBRSxDQUFDO1lBQ3RCLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUM7WUFDakMsSUFBSSxDQUFDLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFBQyxPQUFPO1lBQUMsQ0FBQztZQUUxQyxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUN2QyxNQUFNLFFBQVEsR0FBRyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3pDLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUM7WUFFakMsNkRBQTZEO1lBQzdELElBQUksV0FBVyxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQztnQkFDM0MsK0RBQStEO2dCQUMvRCxPQUFPO1lBQ1gsQ0FBQztZQUVELDRDQUE0QztZQUM1QyxlQUFlLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDO2lCQUMxQyxJQUFJLENBQUMsQ0FBQyxTQUFTLEVBQUUsRUFBRTtnQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQ0FBZ0MsUUFBUSxJQUFJLFNBQVMsR0FBRyxFQUFFLGlCQUFpQixDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7Z0JBRXBHLGtFQUFrRTtnQkFDbEUsMkVBQTJFO2dCQUMzRSxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRSxNQUFNLENBQUMsQ0FBQztnQkFDekQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQ0FBcUMsUUFBUSxJQUFJLFNBQVMsRUFBRSxDQUFDLENBQUM7Z0JBRTFFLHdDQUF3QztnQkFDeEMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssS0FBSyxTQUFTLEVBQUUsQ0FBQztvQkFDcEMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLEdBQUcsU0FBUyxDQUFDO2dCQUNwQyxDQUFDO1lBQ0wsQ0FBQyxDQUFDO2lCQUNELEtBQUssQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO2dCQUNiLElBQUksT0FBTyxPQUFPLEtBQUssV0FBVyxFQUFFLENBQUM7b0JBQ2pDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQyw4QkFBOEIsRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDMUQsQ0FBQztZQUNMLENBQUMsQ0FBQyxDQUFDO1FBQ1gsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDO0lBRUQsZ0JBQWdCO1FBQ1osTUFBTSxJQUFJLEdBQUcsSUFBOEIsQ0FBQztRQUM1QyxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDN0QsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQzNELE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzFDLElBQUksU0FBUyxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQ2hCLE9BQU8sZ0JBQWdCLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDdkMsQ0FBQztRQUVELElBQUksUUFBUSxHQUFHLGVBQWUsQ0FBQztRQUMvQixNQUFNLEtBQUssR0FDUCxPQUFPLGdCQUFnQixLQUFLLFFBQVEsSUFBSSxRQUFRLENBQUMsZ0JBQWdCLENBQUM7WUFDOUQsQ0FBQyxDQUFDLGdCQUFnQjtZQUNsQixDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRVosSUFBSSxPQUFPLElBQUksQ0FBQyxxQkFBcUIsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNuRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztZQUMxQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLEtBQUssQ0FBQztZQUMxRCxJQUFJLE9BQU8sR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDZCxRQUFRLEdBQUcsT0FBTyxDQUFDO1lBQ3ZCLENBQUM7UUFDTCxDQUFDO1FBRUQsT0FBTyxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN0QyxDQUFDOztBQVNMLElBQUksT0FBTyxNQUFNLEtBQUssV0FBVyxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO0lBQ2xFLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDNUIsY0FBYyxDQUFDLE1BQU0sQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7QUFDckQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIHNob3VsZCB0byByZXR1cm4gZnJvbSBzb3VyY2UgY29kZSB0byBzdHlsZSBlbGVtZW50IChpbiBzaGFkb3cgRE9NKVxuZXhwb3J0IGNvbnN0IHByZWxvYWRTdHlsZSA9IChzcmNDb2RlOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBjb250ZW50ID0gdHlwZW9mIHNyY0NvZGUgPT09IFwic3RyaW5nXCIgPyBzcmNDb2RlPy50cmltPy4oKSA6IFwiXCI7XG4gICAgaWYgKCFjb250ZW50KSB7IHJldHVybiAoKSA9PiBudWxsIGFzIEhUTUxTdHlsZUVsZW1lbnQgfCBudWxsOyB9XG4gICAgY29uc3Qgc3R5bGVVUkwgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKG5ldyBCbG9iKFtjb250ZW50XSwge3R5cGU6IFwidGV4dC9jc3NcIn0pKTtcblxuICAgIC8vXG4gICAgaWYgKHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgeyByZXR1cm4gbnVsbDsgfVxuICAgIGNvbnN0IHN0eWxlRWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG4gICAgc3R5bGVFbC5zZXRBdHRyaWJ1dGUoXCJkYXRhLXVpLXBob3NwaG9yLWljb25cIiwgXCJ0cnVlXCIpO1xuICAgIHN0eWxlRWwuaW5uZXJIVE1MID0gYEBpbXBvcnQgdXJsKFwiJHtzdHlsZVVSTH1cIik7YDtcblxuICAgIC8vXG4gICAgcmV0dXJuICgpID0+IHN0eWxlRWw/LmNsb25lTm9kZT8uKHRydWUpOztcbn07XG5cbi8vIEB0cy1pZ25vcmUg4oCTIFZpdGUgaW5saW5lIGltcG9ydFxuaW1wb3J0IHN0eWxlcyBmcm9tIFwiLi9QaG9zcGhvci5zY3NzP2lubGluZVwiO1xuaW1wb3J0IHtcbiAgICBlbnN1cmVNYXNrVmFsdWUsXG4gICAgbG9hZEFzSW1hZ2UsXG4gICAgRkFMTEJBQ0tfSUNPTl9EQVRBX1VSTCxcbiAgICBNSU5fUkFTVEVSX1NJWkUsXG4gICAgcXVhbnRpemVUb0J1Y2tldCxcbiAgICBjYW1lbFRvS2ViYWIsXG4gICAgZ2VuZXJhdGVJY29uSW1hZ2VWYXJpYWJsZSxcbiAgICByZWdpc3Rlckljb25SdWxlLFxuICAgIGhhc0ljb25SdWxlLFxuICAgIHR5cGUgRGV2aWNlUGl4ZWxTaXplLFxufSBmcm9tIFwiLi9Mb2FkZXJcIjtcblxuLy9cbmNvbnN0IGNyZWF0ZVN0eWxlID0gcHJlbG9hZFN0eWxlKHN0eWxlcyk7XG5cbi8vIEhhbmRsZSBub24tc3RyaW5nIG9yIGVtcHR5IGlucHV0cyBncmFjZWZ1bGx5XG5jb25zdCBjYXBpdGFsaXplRmlyc3RMZXR0ZXIgPSAoc3RyOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKHR5cGVvZiBzdHIgIT09IFwic3RyaW5nXCIgfHwgc3RyLmxlbmd0aCA9PT0gMCkgeyByZXR1cm4gc3RyOyB9XG4gICAgcmV0dXJuIHN0ci5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHN0ci5zbGljZSgxKTtcbn07XG5cbmNvbnN0IHN1bW1hcml6ZUljb25VcmxGb3JMb2cgPSAodmFsdWU6IHVua25vd24sIHByZXZpZXdMZW5ndGggPSAxNDApOiB1bmtub3duID0+IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSB7IHJldHVybiB2YWx1ZTsgfVxuICAgIGlmICghdmFsdWUpIHsgcmV0dXJuIHZhbHVlOyB9XG5cbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcImRhdGE6XCIpKSB7XG4gICAgICAgIGNvbnN0IG1pbWVNYXRjaCA9IC9eZGF0YTooW147LF0rKVs7LF0vLmV4ZWModmFsdWUpO1xuICAgICAgICBjb25zdCBtaW1lVHlwZSA9IG1pbWVNYXRjaD8uWzFdIHx8IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG4gICAgICAgIHJldHVybiBgW2RhdGEtdXJsICR7bWltZVR5cGV9LCBsZW5ndGg9JHt2YWx1ZS5sZW5ndGh9XWA7XG4gICAgfVxuXG4gICAgaWYgKHZhbHVlLmxlbmd0aCA+IHByZXZpZXdMZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIGAke3ZhbHVlLnNsaWNlKDAsIHByZXZpZXdMZW5ndGgpfS4uLiBbdHJ1bmNhdGVkICR7dmFsdWUubGVuZ3RoIC0gcHJldmlld0xlbmd0aH0gY2hhcnNdYDtcbiAgICB9XG5cbiAgICByZXR1cm4gdmFsdWU7XG59O1xuXG5jb25zdCBpY29uVXJsTWV0YUZvckxvZyA9ICh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IHR5cGVvZiB2YWx1ZSwgdmFsaWQ6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgY29uc3QgaXNEYXRhVXJsID0gdmFsdWUuc3RhcnRzV2l0aChcImRhdGE6XCIpO1xuICAgIGNvbnN0IG1pbWVNYXRjaCA9IGlzRGF0YVVybCA/IC9eZGF0YTooW147LF0rKVs7LF0vLmV4ZWModmFsdWUpIDogbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgICB2YWxpZDogdHJ1ZSxcbiAgICAgICAgdHlwZTogaXNEYXRhVXJsID8gXCJkYXRhLXVybFwiIDogXCJ1cmxcIixcbiAgICAgICAgbWltZVR5cGU6IG1pbWVNYXRjaD8uWzFdIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgbGVuZ3RoOiB2YWx1ZS5sZW5ndGhcbiAgICB9O1xufTtcblxuLy8gQHRzLWlnbm9yZVxuZXhwb3J0IGNsYXNzIFVJUGhvc3Bob3JJY29uIGV4dGVuZHMgSFRNTEVsZW1lbnQge1xuICAgIHN0YXRpYyBnZXQgb2JzZXJ2ZWRBdHRyaWJ1dGVzKCkge1xuICAgICAgICByZXR1cm4gW1wiaWNvblwiLCBcImljb24tc3R5bGVcIiwgXCJzaXplXCIsIFwid2lkdGhcIiwgXCJpY29uLWJhc2VcIl07XG4gICAgfVxuXG4gICAgI29wdGlvbnM6IHsgcGFkZGluZz86IG51bWJlciB8IHN0cmluZzsgaWNvbj86IHN0cmluZzsgaWNvblN0eWxlPzogc3RyaW5nIH0gPSB7XG4gICAgICAgIHBhZGRpbmc6IDAsXG4gICAgICAgIGljb246IFwiXCIsXG4gICAgICAgIGljb25TdHlsZTogXCJkdW90b25lXCIsXG4gICAgfTtcbiAgICAjcmVzaXplT2JzZXJ2ZXI/OiBSZXNpemVPYnNlcnZlcjtcbiAgICAjZGV2aWNlUGl4ZWxTaXplOiBEZXZpY2VQaXhlbFNpemUgPSB7XG4gICAgICAgIGlubGluZTogTUlOX1JBU1RFUl9TSVpFLFxuICAgICAgICBibG9jazogTUlOX1JBU1RFUl9TSVpFLFxuICAgIH07XG4gICAgI3F1ZXVlZE1hc2tVcGRhdGU6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbiAgICAjY3VycmVudEljb25VcmwgPSBcIlwiO1xuICAgICNtYXNrS2V5QmFzZSA9IFwiXCI7XG4gICAgI21hc2tSZWYgPSB7IHZhbHVlOiBcIlwiIH07XG4gICAgI3N0eWxlQXR0YWNoZWQgPSBmYWxzZTtcbiAgICAjcGVuZGluZ0ljb25OYW1lOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAjaW50ZXJzZWN0aW9uT2JzZXJ2ZXI/OiBJbnRlcnNlY3Rpb25PYnNlcnZlcjtcbiAgICAjaXNJbnRlcnNlY3RpbmcgPSBmYWxzZTtcblxuICAgIGNvbnN0cnVjdG9yKFxuICAgICAgICBvcHRpb25zOiBQYXJ0aWFsPHsgaWNvbjogc3RyaW5nOyBpY29uU3R5bGU6IHN0cmluZzsgcGFkZGluZzogbnVtYmVyIHwgc3RyaW5nIH0+ID0ge30sXG4gICAgKSB7XG4gICAgICAgIHN1cGVyKCk7XG4gICAgICAgIE9iamVjdC5hc3NpZ24odGhpcy4jb3B0aW9ucywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLmljb24gPT09IFwic3RyaW5nXCIgJiYgb3B0aW9ucy5pY29uLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHRoaXMuc2V0QXR0cmlidXRlKFwiaWNvblwiLCBvcHRpb25zLmljb24pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLmljb25TdHlsZSA9PT0gXCJzdHJpbmdcIiAmJiBvcHRpb25zLmljb25TdHlsZS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB0aGlzLnNldEF0dHJpYnV0ZShcImljb24tc3R5bGVcIiwgb3B0aW9ucy5pY29uU3R5bGUudG9Mb3dlckNhc2UoKSk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLiNlbnN1cmVTaGFkb3dSb290KCk7XG4gICAgfVxuXG4gICAgZ2V0IGljb24oKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZ2V0QXR0cmlidXRlKFwiaWNvblwiKSA/PyBcIlwiO1xuICAgIH1cblxuICAgIHNldCBpY29uKHZhbHVlOiBzdHJpbmcpIHtcbiAgICAgICAgaWYgKHZhbHVlID09IG51bGwgfHwgdmFsdWUgPT09IFwiXCIpIHtcbiAgICAgICAgICAgIHRoaXMucmVtb3ZlQXR0cmlidXRlKFwiaWNvblwiKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKTtcbiAgICAgICAgaWYgKHRoaXMuZ2V0QXR0cmlidXRlKFwiaWNvblwiKSAhPT0gbm9ybWFsaXplZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRBdHRyaWJ1dGUoXCJpY29uXCIsIG5vcm1hbGl6ZWQpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ2V0IGljb25TdHlsZSgpOiBzdHJpbmcge1xuICAgICAgICByZXR1cm4gdGhpcy5nZXRBdHRyaWJ1dGUoXCJpY29uLXN0eWxlXCIpID8/IHRoaXMuI29wdGlvbnMuaWNvblN0eWxlID8/IFwiZHVvdG9uZVwiO1xuICAgIH1cblxuICAgIHNldCBpY29uU3R5bGUodmFsdWU6IHN0cmluZykge1xuICAgICAgICBjb25zdCBub3JtYWxpemVkID0gKHZhbHVlID8/IFwiXCIpPy50cmltPy4oKT8udG9Mb3dlckNhc2U/LigpO1xuICAgICAgICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICAgICAgICAgIHRoaXMucmVtb3ZlQXR0cmlidXRlKFwiaWNvbi1zdHlsZVwiKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5nZXRBdHRyaWJ1dGUoXCJpY29uLXN0eWxlXCIpICE9PSBub3JtYWxpemVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEF0dHJpYnV0ZShcImljb24tc3R5bGVcIiwgbm9ybWFsaXplZCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnZXQgc2l6ZSgpOiBzdHJpbmcgfCBudWxsIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZ2V0QXR0cmlidXRlKFwic2l6ZVwiKTtcbiAgICB9XG5cbiAgICBzZXQgc2l6ZSh2YWx1ZTogc3RyaW5nIHwgbnVsbCkge1xuICAgICAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgdGhpcy5yZW1vdmVBdHRyaWJ1dGUoXCJzaXplXCIpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodmFsdWUpO1xuICAgICAgICBpZiAodGhpcy5nZXRBdHRyaWJ1dGUoXCJzaXplXCIpICE9PSBub3JtYWxpemVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEF0dHJpYnV0ZShcInNpemVcIiwgbm9ybWFsaXplZCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnZXQgd2lkdGgoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgICAgIHJldHVybiB0aGlzLmdldEF0dHJpYnV0ZShcIndpZHRoXCIpO1xuICAgIH1cblxuICAgIHNldCB3aWR0aCh2YWx1ZTogc3RyaW5nIHwgbnVtYmVyIHwgbnVsbCkge1xuICAgICAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB2YWx1ZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgdGhpcy5yZW1vdmVBdHRyaWJ1dGUoXCJ3aWR0aFwiKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub3JtYWxpemVkID0gdHlwZW9mIHZhbHVlID09PSBcIm51bWJlclwiID8gU3RyaW5nKHZhbHVlKSA6IHZhbHVlO1xuICAgICAgICBpZiAodGhpcy5nZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiKSAhPT0gbm9ybWFsaXplZCkge1xuICAgICAgICAgICAgdGhpcy5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBub3JtYWxpemVkKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGJhc2UgVVJMIGZvciBzYW1lLW9yaWdpbiBpY29uIGhvc3RpbmcuXG4gICAgICogRXhhbXBsZTogaWNvbi1iYXNlPVwiL2Fzc2V0cy9waG9zcGhvclwiXG4gICAgICogV2lsbCBiZSB0cmllZCBiZWZvcmUgQ0ROcy5cbiAgICAgKi9cbiAgICBnZXQgaWNvbkJhc2UoKTogc3RyaW5nIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZ2V0QXR0cmlidXRlKFwiaWNvbi1iYXNlXCIpID8/IFwiXCI7XG4gICAgfVxuXG4gICAgc2V0IGljb25CYXNlKHZhbHVlOiBzdHJpbmcpIHtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9ICh2YWx1ZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgIGlmICghbm9ybWFsaXplZCkge1xuICAgICAgICAgICAgdGhpcy5yZW1vdmVBdHRyaWJ1dGUoXCJpY29uLWJhc2VcIik7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuZ2V0QXR0cmlidXRlKFwiaWNvbi1iYXNlXCIpICE9PSBub3JtYWxpemVkKSB7XG4gICAgICAgICAgICB0aGlzLnNldEF0dHJpYnV0ZShcImljb24tYmFzZVwiLCBub3JtYWxpemVkKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbm5lY3RlZENhbGxiYWNrKCk6IHZvaWQge1xuICAgICAgICB0aGlzLiNhcHBseUhvc3REZWZhdWx0cygpO1xuICAgICAgICB0aGlzLiNzZXR1cFJlc2l6ZU9ic2VydmVyKHRoaXMpO1xuICAgICAgICB0aGlzLiNzZXR1cFZpc2liaWxpdHlPYnNlcnZlcigpO1xuXG4gICAgICAgIGlmICghdGhpcy4jc3R5bGVBdHRhY2hlZCkge1xuICAgICAgICAgICAgY29uc3Qgc3R5bGVOb2RlID0gY3JlYXRlU3R5bGU/LigpID8/IG51bGw7XG4gICAgICAgICAgICBpZiAoc3R5bGVOb2RlKSB7IHRoaXMuc2hhZG93Um9vdCEuYXBwZW5kQ2hpbGQoc3R5bGVOb2RlKTsgfVxuICAgICAgICAgICAgdGhpcy4jc3R5bGVBdHRhY2hlZCA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRoaXMuaGFzQXR0cmlidXRlKFwiaWNvblwiKSAmJiB0aGlzLiNvcHRpb25zLmljb24pIHtcbiAgICAgICAgICAgIHRoaXMuc2V0QXR0cmlidXRlKFwiaWNvblwiLCB0aGlzLiNvcHRpb25zLmljb24pO1xuICAgICAgICB9XG4gICAgICAgIGlmICghdGhpcy5oYXNBdHRyaWJ1dGUoXCJpY29uLXN0eWxlXCIpICYmIHRoaXMuI29wdGlvbnMuaWNvblN0eWxlKSB7XG4gICAgICAgICAgICB0aGlzLnNldEF0dHJpYnV0ZShcImljb24tc3R5bGVcIiwgdGhpcy4jb3B0aW9ucy5pY29uU3R5bGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9yY2UgbG9hZCBhbnkgcGVuZGluZyBpY29uIGltbWVkaWF0ZWx5IHdoZW4gY29ubmVjdGVkXG4gICAgICAgIGNvbnN0IHBlbmRpbmdJY29uID0gdGhpcy4jcGVuZGluZ0ljb25OYW1lID8/IHRoaXMuaWNvbjtcbiAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBFbGVtZW50IGNvbm5lY3RlZCwgcGVuZGluZyBpY29uOiAke3BlbmRpbmdJY29ufSwgY3VycmVudCBpY29uOiAke3RoaXMuaWNvbn1gKTtcblxuICAgICAgICBpZiAocGVuZGluZ0ljb24pIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gTG9hZGluZyBwZW5kaW5nIGljb246ICR7cGVuZGluZ0ljb259YCk7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZUljb24ocGVuZGluZ0ljb24pO1xuICAgICAgICB9IGVsc2UgaWYgKHRoaXMuaWNvbikge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBMb2FkaW5nIGN1cnJlbnQgaWNvbjogJHt0aGlzLmljb259YCk7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZUljb24odGhpcy5pY29uKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gTm8gaWNvbiB0byBsb2FkYCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBkaXNjb25uZWN0ZWRDYWxsYmFjaygpOiB2b2lkIHtcbiAgICAgICAgdGhpcy4jcmVzaXplT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgdGhpcy4jcmVzaXplT2JzZXJ2ZXIgPSB1bmRlZmluZWQ7XG4gICAgICAgIHRoaXMuI3RlYXJkb3duVmlzaWJpbGl0eU9ic2VydmVyKCk7XG4gICAgICAgIHRoaXMuI3F1ZXVlZE1hc2tVcGRhdGUgPSBudWxsO1xuICAgICAgICB0aGlzLiNyZXRyeUF0dGVtcHQgPSAwO1xuICAgIH1cblxuICAgIGF0dHJpYnV0ZUNoYW5nZWRDYWxsYmFjayhuYW1lOiBzdHJpbmcsIG9sZFZhbHVlOiBzdHJpbmcgfCBudWxsLCBuZXdWYWx1ZTogc3RyaW5nIHwgbnVsbCkge1xuICAgICAgICBpZiAob2xkVmFsdWUgPT09IG5ld1ZhbHVlKSB7IHJldHVybjsgfVxuXG4gICAgICAgIHN3aXRjaCAobmFtZSkge1xuICAgICAgICAgICAgY2FzZSBcImljb25cIjoge1xuICAgICAgICAgICAgICAgIGlmICghdGhpcy5pc0Nvbm5lY3RlZCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLiNwZW5kaW5nSWNvbk5hbWUgPSBuZXdWYWx1ZSA/PyBcIlwiO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMudXBkYXRlSWNvbihuZXdWYWx1ZSA/PyBcIlwiKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgXCJpY29uLXN0eWxlXCI6IHtcbiAgICAgICAgICAgICAgICBpZiAobmV3VmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IG5ld1ZhbHVlPy50cmltPy4oKT8udG9Mb3dlckNhc2U/LigpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZCAhPT0gbmV3VmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2V0QXR0cmlidXRlKFwiaWNvbi1zdHlsZVwiLCBub3JtYWxpemVkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLiNtYXNrS2V5QmFzZSA9IFwiXCI7XG4gICAgICAgICAgICAgICAgaWYgKCF0aGlzLmlzQ29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuI3BlbmRpbmdJY29uTmFtZSA9IHRoaXMuaWNvbjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLnVwZGF0ZUljb24oKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgXCJzaXplXCI6IHtcbiAgICAgICAgICAgICAgICBpZiAobmV3VmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zdHlsZS5zZXRQcm9wZXJ0eShcIi0taWNvbi1zaXplXCIsICh0eXBlb2YgbmV3VmFsdWUgPT09IFwibnVtYmVyXCIgfHwgL15cXGQrJC8udGVzdChuZXdWYWx1ZSkpID8gYCR7bmV3VmFsdWV9cHhgIDogbmV3VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc3R5bGUucmVtb3ZlUHJvcGVydHkoXCItLWljb24tc2l6ZVwiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuaXNDb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy4jcXVldWVNYXNrVXBkYXRlKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2FzZSBcIndpZHRoXCI6IHtcbiAgICAgICAgICAgICAgICBpZiAobmV3VmFsdWUgPT0gbnVsbCB8fCBuZXdWYWx1ZSA9PT0gXCJcIikge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnN0eWxlLnJlbW92ZVByb3BlcnR5KFwid2lkdGhcIik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSAodHlwZW9mIG5ld1ZhbHVlID09PSBcIm51bWJlclwiIHx8IC9eXFxkKyQvLnRlc3QobmV3VmFsdWUpKSA/IGAke25ld1ZhbHVlfXB4YCA6IG5ld1ZhbHVlO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLnN0eWxlLndpZHRoID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh0aGlzLmlzQ29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuI3F1ZXVlTWFza1VwZGF0ZSgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhc2UgXCJpY29uLWJhc2VcIjoge1xuICAgICAgICAgICAgICAgIC8vIENoYW5naW5nIGJhc2UgYWZmZWN0cyBsb2FkIHNvdXJjZTsgZm9yY2UgcmVsb2FkLlxuICAgICAgICAgICAgICAgIHRoaXMuI2N1cnJlbnRJY29uVXJsID0gXCJcIjtcbiAgICAgICAgICAgICAgICB0aGlzLiNtYXNrS2V5QmFzZSA9IFwiXCI7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuaXNDb25uZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy51cGRhdGVJY29uKHRoaXMuaWNvbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgI3JldHJ5QXR0ZW1wdCA9IDA7XG4gICAgc3RhdGljIHJlYWRvbmx5ICNNQVhfSUNPTl9SRVRSSUVTID0gMztcbiAgICBzdGF0aWMgcmVhZG9ubHkgI1JFVFJZX0RFTEFZX01TID0gNTAwO1xuXG4gICAgcHVibGljIHVwZGF0ZUljb24oaWNvbj86IHN0cmluZykge1xuICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSB0eXBlb2YgaWNvbiA9PT0gXCJzdHJpbmdcIiAmJiBpY29uLmxlbmd0aCA+IDAgPyBpY29uIDogdGhpcy5pY29uO1xuICAgICAgICBjb25zdCBuZXh0SWNvbiA9IGNhbmRpZGF0ZT8udHJpbT8uKCkgPz8gXCJcIjtcblxuICAgICAgICBpZiAoIXRoaXMuaXNDb25uZWN0ZWQpIHtcbiAgICAgICAgICAgIHRoaXMuI3BlbmRpbmdJY29uTmFtZSA9IG5leHRJY29uO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIEludGVyc2VjdGlvbk9ic2VydmVyICE9PSBcInVuZGVmaW5lZFwiICYmICF0aGlzLiNpc0ludGVyc2VjdGluZykge1xuICAgICAgICAgICAgdGhpcy4jcGVuZGluZ0ljb25OYW1lID0gbmV4dEljb247XG4gICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuI3BlbmRpbmdJY29uTmFtZSA9IG51bGw7XG5cbiAgICAgICAgaWYgKCFuZXh0SWNvbikgeyByZXR1cm4gdGhpczsgfVxuXG4gICAgICAgIGxldCBpY29uU3R5bGUgPSAodGhpcy5pY29uU3R5bGUgPz8gXCJkdW90b25lXCIpPy50cmltPy4oKT8udG9Mb3dlckNhc2U/LigpO1xuICAgICAgICBjb25zdCBJQ09OID0gY2FtZWxUb0tlYmFiKG5leHRJY29uKTtcbiAgICAgICAgLy8gVXNlIENETiBmb3IgUGhvc3Bob3IgaWNvbnMgKG5wbSBwYWNrYWdlIGFzc2V0czsgc3RhYmxlIHBhdGhzKVxuICAgICAgICAvLyBFeGFtcGxlOlxuICAgICAgICAvLyAtIGh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vQHBob3NwaG9yLWljb25zL2NvcmVAMi9hc3NldHMvZHVvdG9uZS9mb2xkZXItb3Blbi1kdW90b25lLnN2Z1xuICAgICAgICAvLyBWYWxpZGF0ZSBpY29uIG5hbWUgdG8gcHJldmVudCBpbnZhbGlkIHJlcXVlc3RzXG4gICAgICAgIGlmICghSUNPTiB8fCAhL15bYS16MC05LV0rJC8udGVzdChJQ09OKSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbdWktaWNvbl0gSW52YWxpZCBpY29uIG5hbWU6ICR7SUNPTn1gKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gVmFsaWRhdGUgaWNvbiBzdHlsZVxuICAgICAgICBjb25zdCB2YWxpZFN0eWxlcyA9IFsndGhpbicsICdsaWdodCcsICdyZWd1bGFyJywgJ2JvbGQnLCAnZmlsbCcsICdkdW90b25lJ107XG4gICAgICAgIGlmICghdmFsaWRTdHlsZXMuaW5jbHVkZXMoaWNvblN0eWxlKSkge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbdWktaWNvbl0gSW52YWxpZCBpY29uIHN0eWxlOiAke2ljb25TdHlsZX0sIGRlZmF1bHRpbmcgdG8gJ2R1b3RvbmUnYCk7XG4gICAgICAgICAgICBpY29uU3R5bGUgPSAnZHVvdG9uZSc7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb3IgZHVvdG9uZSBpY29ucywgYXBwZW5kICctZHVvdG9uZScgdG8gdGhlIGZpbGVuYW1lXG4gICAgICAgIC8vIEZvciBvdGhlciBzdHlsZXMgbGlrZSAnZmlsbCcsICdib2xkJywgZXRjLiwgYXBwZW5kICcte3N0eWxlfSdcbiAgICAgICAgY29uc3QgaWNvbkZpbGVOYW1lID0gaWNvblN0eWxlID09PSAnZHVvdG9uZScgPyBgJHtJQ09OfS1kdW90b25lYCA6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWNvblN0eWxlICE9PSAncmVndWxhcicgPyBgJHtJQ09OfS0ke2ljb25TdHlsZX1gIDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBJQ09OO1xuXG4gICAgICAgIC8vIFRyeSBkaXJlY3QgQ0ROIGZpcnN0IChtb3N0IHJlbGlhYmxlKSwgdGhlbiBwcm94eSAod2l0aG91dCBzdWZmaXggLSBwcm94eSBhZGRzIGl0KSwgdGhlbiBsb2NhbFxuICAgICAgICBjb25zdCBkaXJlY3RDZG5QYXRoID0gYGh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vQHBob3NwaG9yLWljb25zL2NvcmVAMi9hc3NldHMvJHtpY29uU3R5bGV9LyR7aWNvbkZpbGVOYW1lfS5zdmdgO1xuICAgICAgICBjb25zdCBwcm94eUNkblBhdGggPSBgL2Fzc2V0cy9pY29ucy9waG9zcGhvci8ke2ljb25TdHlsZX0vJHtJQ09OfS5zdmdgOyAvLyBQcm94eSBleHBlY3RzIGJhc2UgbmFtZSwgYWRkcyBzdWZmaXhcbiAgICAgICAgY29uc3QgYmFzZSA9ICh0aGlzLmljb25CYXNlID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICAgICAgICBjb25zdCBsb2NhbFBhdGggPSBiYXNlID8gYCR7YmFzZX0vJHtpY29uU3R5bGV9LyR7aWNvbkZpbGVOYW1lfS5zdmdgIDogXCJcIjtcbiAgICAgICAgY29uc3QgcmVxdWVzdEtleSA9IGAke2ljb25TdHlsZX06JHtJQ09OfWA7XG5cbiAgICAgICAgdGhpcy4jbWFza0tleUJhc2UgPSByZXF1ZXN0S2V5O1xuXG4gICAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICAvLyBBbHdheXMgYXR0ZW1wdCB0byBsb2FkIGlmIHdlIGRvbid0IGhhdmUgYSBjdXJyZW50IGljb24gVVJMLCBvciBpZiB3ZSdyZSBpbnRlcnNlY3RpbmdcbiAgICAgICAgICAgIGNvbnN0IHNob3VsZExvYWQgPSAhdGhpcy4jY3VycmVudEljb25VcmwgfHwgdGhpcy4jaXNJbnRlcnNlY3RpbmcgfHxcbiAgICAgICAgICAgICAgICAodGhpcz8uY2hlY2tWaXNpYmlsaXR5Py4oe1xuICAgICAgICAgICAgICAgICAgICBjb250ZW50VmlzaWJpbGl0eUF1dG86IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIG9wYWNpdHlQcm9wZXJ0eTogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgdmlzaWJpbGl0eVByb3BlcnR5OiB0cnVlLFxuICAgICAgICAgICAgICAgIH0pID8/IHRydWUpO1xuXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW3VpLWljb25dIENoZWNraW5nIGxvYWQgY29uZGl0aW9ucyBmb3IgJHtyZXF1ZXN0S2V5fTpgLCB7XG4gICAgICAgICAgICAgICAgaGFzQ3VycmVudFVybDogISF0aGlzLiNjdXJyZW50SWNvblVybCxcbiAgICAgICAgICAgICAgICBpc0ludGVyc2VjdGluZzogdGhpcy4jaXNJbnRlcnNlY3RpbmcsXG4gICAgICAgICAgICAgICAgc2hvdWxkTG9hZFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChzaG91bGRMb2FkKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc291cmNlcyA9IChsb2NhbFBhdGggPyBbZGlyZWN0Q2RuUGF0aCwgcHJveHlDZG5QYXRoLCBsb2NhbFBhdGhdIDogW2RpcmVjdENkblBhdGgsIHByb3h5Q2RuUGF0aF0pO1xuICAgICAgICAgICAgICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBsYXN0VXJsOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGxhc3RFcnJvcjogdW5rbm93biA9IG51bGw7XG5cbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBzcmMgb2Ygc291cmNlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB1cmwgPSBhd2FpdCBsb2FkQXNJbWFnZShzcmMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhc3RVcmwgPSB1cmw7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBJZiBsb2NhbCBzb3VyY2UgcmV0dXJucyBmYWxsYmFjayBwbGFjZWhvbGRlciwgdHJ5IHRoZSBDRE4gbmV4dC5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoc3JjID09PSBsb2NhbFBhdGggJiYgdXJsID09PSBGQUxMQkFDS19JQ09OX0RBVEFfVVJMKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsYXN0RXJyb3IgPSBlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdXJsID0gbGFzdFVybDtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgICAgICAgICAgICAgICBgW3VpLWljb25dIExvYWRlZCBpY29uICR7cmVxdWVzdEtleX0gKCR7bG9jYWxQYXRoID8gXCJsb2NhbCtwcm94eStmYWxsYmFja1wiIDogXCJwcm94eStmYWxsYmFja1wifSk6YCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGljb25VcmxNZXRhRm9yTG9nKHVybClcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF1cmwgfHwgdHlwZW9mIHVybCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGBbdWktaWNvbl0gSW52YWxpZCBVUkwgcmV0dXJuZWQgZm9yICR7cmVxdWVzdEtleX06YCwgaWNvblVybE1ldGFGb3JMb2codXJsKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuI21hc2tLZXlCYXNlICE9PSByZXF1ZXN0S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW3VpLWljb25dIElnbm9yaW5nIG91dGRhdGVkIHJlcXVlc3QgZm9yICR7cmVxdWVzdEtleX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLiNjdXJyZW50SWNvblVybCA9IHVybDtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy4jcmV0cnlBdHRlbXB0ID0gMDtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy4jcXVldWVNYXNrVXBkYXRlKCk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgYm90aCBzb3VyY2VzIGZhaWxlZCBhbmQgd2UgZW5kZWQgdXAgd2l0aCBmYWxsYmFjaywga2VlcCB0aGUgb2xkIHJldHJ5IGJlaGF2aW9yIGZvciB0aW1lb3V0cy5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHVybCA9PT0gRkFMTEJBQ0tfSUNPTl9EQVRBX1VSTCAmJiBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgaXNUaW1lb3V0ID0gbGFzdEVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJUaW1lb3V0XCIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzVGltZW91dCAmJiB0aGlzLiNyZXRyeUF0dGVtcHQgPCBVSVBob3NwaG9ySWNvbi4jTUFYX0lDT05fUkVUUklFUyAmJiB0aGlzLmlzQ29ubmVjdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy4jcmV0cnlBdHRlbXB0Kys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLmlzQ29ubmVjdGVkICYmIHRoaXMuI21hc2tLZXlCYXNlID09PSByZXF1ZXN0S2V5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnVwZGF0ZUljb24obmV4dEljb24pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSwgVUlQaG9zcGhvckljb24uI1JFVFJZX0RFTEFZX01TICogdGhpcy4jcmV0cnlBdHRlbXB0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pKCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgY29uc29sZSAhPT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5lcnJvcj8uKFwiW3VpLWljb25dIEZhaWxlZCB0byBsb2FkIGljb24gc291cmNlc1wiLCB7IGRpcmVjdENkblBhdGgsIHByb3h5Q2RuUGF0aCwgbG9jYWxQYXRoIH0sIGVycm9yKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICAjc2V0dXBWaXNpYmlsaXR5T2JzZXJ2ZXIoKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gU2V0dGluZyB1cCB2aXNpYmlsaXR5IG9ic2VydmVyYCk7XG5cbiAgICAgICAgaWYgKHR5cGVvZiBJbnRlcnNlY3Rpb25PYnNlcnZlciA9PT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBJbnRlcnNlY3Rpb25PYnNlcnZlciBub3QgYXZhaWxhYmxlLCBzZXR0aW5nIGludGVyc2VjdGluZyB0byB0cnVlYCk7XG4gICAgICAgICAgICB0aGlzLiNpc0ludGVyc2VjdGluZyA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy4jaW50ZXJzZWN0aW9uT2JzZXJ2ZXIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gVmlzaWJpbGl0eSBvYnNlcnZlciBhbHJlYWR5IGV4aXN0c2ApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBDcmVhdGluZyBuZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXJgKTtcbiAgICAgICAgdGhpcy4jaW50ZXJzZWN0aW9uT2JzZXJ2ZXIgPSBuZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXIoKGVudHJpZXMpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGlzSW50ZXJzZWN0aW5nID0gZW50cmllcy5zb21lKChlbnRyeSkgPT4gZW50cnkuaXNJbnRlcnNlY3RpbmcpO1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBJbnRlcnNlY3Rpb25PYnNlcnZlciBjYWxsYmFjazogaXNJbnRlcnNlY3Rpbmc9JHtpc0ludGVyc2VjdGluZ30sIHdhcz0ke3RoaXMuI2lzSW50ZXJzZWN0aW5nfWApO1xuXG4gICAgICAgICAgICBpZiAoaXNJbnRlcnNlY3RpbmcgIT09IHRoaXMuI2lzSW50ZXJzZWN0aW5nKSB7XG4gICAgICAgICAgICAgICAgdGhpcy4jaXNJbnRlcnNlY3RpbmcgPSBpc0ludGVyc2VjdGluZztcbiAgICAgICAgICAgICAgICBpZiAoaXNJbnRlcnNlY3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBFbGVtZW50IGJlY2FtZSB2aXNpYmxlLCB1cGRhdGluZyBpY29uYCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMudXBkYXRlSWNvbih0aGlzLiNwZW5kaW5nSWNvbk5hbWUgPz8gdGhpcy5pY29uKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHsgcm9vdE1hcmdpbjogXCIxMDBweFwiIH0pO1xuXG4gICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gU3RhcnRpbmcgb2JzZXJ2YXRpb25gKTtcbiAgICAgICAgdGhpcy4jaW50ZXJzZWN0aW9uT2JzZXJ2ZXIub2JzZXJ2ZSh0aGlzKTtcblxuICAgICAgICAvLyBIYW5kbGUgY29udGVudC12aXNpYmlsaXR5XG4gICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgdGhpcy5hZGRFdmVudExpc3RlbmVyKFwiY29udGVudHZpc2liaWxpdHlhdXRvc3RhdGVjaGFuZ2VcIiwgdGhpcy4jaGFuZGxlQ29udGVudFZpc2liaWxpdHkpO1xuXG4gICAgICAgIC8vIEluaXRpYWxseSBhc3N1bWUgaW50ZXJzZWN0aW5nIHRvIGFsbG93IGxvYWRpbmdcbiAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBTZXR0aW5nIGluaXRpYWwgaW50ZXJzZWN0aW5nIHN0YXRlIHRvIHRydWVgKTtcbiAgICAgICAgdGhpcy4jaXNJbnRlcnNlY3RpbmcgPSB0cnVlO1xuICAgIH1cblxuICAgICN0ZWFyZG93blZpc2liaWxpdHlPYnNlcnZlcigpIHtcbiAgICAgICAgdGhpcy4jaW50ZXJzZWN0aW9uT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgdGhpcy4jaW50ZXJzZWN0aW9uT2JzZXJ2ZXIgPSB1bmRlZmluZWQ7XG4gICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgdGhpcy5yZW1vdmVFdmVudExpc3RlbmVyKFwiY29udGVudHZpc2liaWxpdHlhdXRvc3RhdGVjaGFuZ2VcIiwgdGhpcy4jaGFuZGxlQ29udGVudFZpc2liaWxpdHkpO1xuICAgIH1cblxuICAgICNoYW5kbGVDb250ZW50VmlzaWJpbGl0eSA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgICAvLyBAdHMtaWdub3JlXG4gICAgICAgIGlmIChlLnNraXBwZWQgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICB0aGlzLnVwZGF0ZUljb24odGhpcy4jcGVuZGluZ0ljb25OYW1lID8/IHRoaXMuaWNvbik7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAjZW5zdXJlU2hhZG93Um9vdCgpIHtcbiAgICAgICAgaWYgKCF0aGlzLnNoYWRvd1Jvb3QpIHtcbiAgICAgICAgICAgIHRoaXMuYXR0YWNoU2hhZG93KHsgbW9kZTogXCJvcGVuXCIgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAjYXBwbHlIb3N0RGVmYXVsdHMoKSB7XG4gICAgICAgIHRoaXMuY2xhc3NMaXN0LmFkZChcInVpLWljb25cIiwgXCJ1Mi1pY29uXCIpO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAodGhpcyBhcyB1bmtub3duIGFzIHsgaW5lcnQ6IGJvb2xlYW4gfSkuaW5lcnQgPSB0cnVlO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHRoaXMuc2V0QXR0cmlidXRlKFwiaW5lcnRcIiwgXCJcIik7XG4gICAgICAgIH1cblxuICAgICAgICAvKmlmICghdGhpcy5oYXNBdHRyaWJ1dGUoXCJhcmlhLWhpZGRlblwiKSkge1xuICAgICAgICAgICAgdGhpcy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhpZGRlblwiLCBcInRydWVcIik7XG4gICAgICAgIH0qL1xuXG4gICAgICAgIGNvbnN0IHBhZGRpbmdPcHRpb24gPSB0aGlzLiNvcHRpb25zLnBhZGRpbmc7XG4gICAgICAgIGlmIChcbiAgICAgICAgICAgICF0aGlzLnN0eWxlLmdldFByb3BlcnR5VmFsdWUoXCItLWljb24tcGFkZGluZ1wiKSAmJlxuICAgICAgICAgICAgcGFkZGluZ09wdGlvbiAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICBwYWRkaW5nT3B0aW9uICE9PSBudWxsICYmXG4gICAgICAgICAgICBwYWRkaW5nT3B0aW9uICE9PSBcIlwiXG4gICAgICAgICkge1xuICAgICAgICAgICAgY29uc3QgcGFkZGluZ1ZhbHVlID1cbiAgICAgICAgICAgICAgICB0eXBlb2YgcGFkZGluZ09wdGlvbiA9PT0gXCJudW1iZXJcIiA/IGAke3BhZGRpbmdPcHRpb259cmVtYCA6IFN0cmluZyhwYWRkaW5nT3B0aW9uKTtcbiAgICAgICAgICAgIHRoaXMuc3R5bGUuc2V0UHJvcGVydHkoXCItLWljb24tcGFkZGluZ1wiLCBwYWRkaW5nVmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc2l6ZUF0dHIgPSB0aGlzLmdldEF0dHJpYnV0ZShcInNpemVcIik7XG4gICAgICAgIGlmIChzaXplQXR0cikge1xuICAgICAgICAgICAgdGhpcy5zdHlsZS5zZXRQcm9wZXJ0eShcIi0taWNvbi1zaXplXCIsICh0eXBlb2Ygc2l6ZUF0dHIgPT09IFwibnVtYmVyXCIgfHwgL15cXGQrJC8udGVzdChzaXplQXR0cikpID8gYCR7c2l6ZUF0dHJ9cHhgIDogc2l6ZUF0dHIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gTm90ZTogLS1pY29uLWltYWdlIGlzIG5vdyBzZXQgdmlhIENTUyBydWxlcyB3aXRoIGF0dHJpYnV0ZSBzZWxlY3RvcnNcbiAgICAgICAgLy8gZS5nLiwgdWktaWNvbltpY29uPVwiaG91c2VcIl1baWNvbi1zdHlsZT1cImR1b3RvbmVcIl0geyAtLWljb24taW1hZ2U6IGltYWdlLXNldCguLi4pOyB9XG4gICAgICAgIC8vIE5vIGlubGluZSBzdHlsZSBuZWVkZWQgLSB0aGUgQ1NTIHJlZ2lzdHJ5IGhhbmRsZXMgaXQgbGF6aWx5XG4gICAgfVxuXG4gICAgI3NldHVwUmVzaXplT2JzZXJ2ZXIoZWxlbWVudDogSFRNTEVsZW1lbnQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBSZXNpemVPYnNlcnZlciA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0aGlzLiNyZXNpemVPYnNlcnZlcikgeyByZXR1cm47IH1cbiAgICAgICAgdGhpcy4jcmVzaXplT2JzZXJ2ZXIgPSBuZXcgUmVzaXplT2JzZXJ2ZXIoKGVudHJpZXMpID0+IHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeS50YXJnZXQgIT09IGVsZW1lbnQpIHsgY29udGludWU7IH1cblxuICAgICAgICAgICAgICAgIGNvbnN0IGRldmljZVNpemUgPSBlbnRyeS5kZXZpY2VQaXhlbENvbnRlbnRCb3hTaXplPy5bMF07XG4gICAgICAgICAgICAgICAgY29uc3QgY29udGVudFNpemUgPSBBcnJheS5pc0FycmF5KGVudHJ5LmNvbnRlbnRCb3hTaXplKVxuICAgICAgICAgICAgICAgICAgICA/IGVudHJ5LmNvbnRlbnRCb3hTaXplWzBdXG4gICAgICAgICAgICAgICAgICAgIDogKGVudHJ5LmNvbnRlbnRCb3hTaXplIGFzIHVua25vd24gYXMgUmVzaXplT2JzZXJ2ZXJTaXplIHwgdW5kZWZpbmVkKTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IHJhdGlvID1cbiAgICAgICAgICAgICAgICAgICAgdHlwZW9mIGRldmljZVBpeGVsUmF0aW8gPT09IFwibnVtYmVyXCIgJiYgaXNGaW5pdGUoZGV2aWNlUGl4ZWxSYXRpbylcbiAgICAgICAgICAgICAgICAgICAgICAgID8gZGV2aWNlUGl4ZWxSYXRpb1xuICAgICAgICAgICAgICAgICAgICAgICAgOiAxO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgaW5saW5lID1cbiAgICAgICAgICAgICAgICAgICAgZGV2aWNlU2l6ZT8uaW5saW5lU2l6ZSA/P1xuICAgICAgICAgICAgICAgICAgICAoY29udGVudFNpemU/LmlubGluZVNpemUgPz8gZW50cnkuY29udGVudFJlY3Q/LndpZHRoID8/IGVsZW1lbnQuY2xpZW50V2lkdGggPz8gTUlOX1JBU1RFUl9TSVpFKSAqXG4gICAgICAgICAgICAgICAgICAgICAgICByYXRpbztcbiAgICAgICAgICAgICAgICBjb25zdCBibG9jayA9XG4gICAgICAgICAgICAgICAgICAgIGRldmljZVNpemU/LmJsb2NrU2l6ZSA/P1xuICAgICAgICAgICAgICAgICAgICAoY29udGVudFNpemU/LmJsb2NrU2l6ZSA/PyBlbnRyeS5jb250ZW50UmVjdD8uaGVpZ2h0ID8/IGVsZW1lbnQuY2xpZW50SGVpZ2h0ID8/IE1JTl9SQVNURVJfU0laRSkgKlxuICAgICAgICAgICAgICAgICAgICAgICAgcmF0aW87XG5cbiAgICAgICAgICAgICAgICB0aGlzLiNkZXZpY2VQaXhlbFNpemUgPSB7XG4gICAgICAgICAgICAgICAgICAgIGlubGluZTogaW5saW5lIHx8IE1JTl9SQVNURVJfU0laRSxcbiAgICAgICAgICAgICAgICAgICAgYmxvY2s6IGJsb2NrIHx8IE1JTl9SQVNURVJfU0laRSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIHRoaXMuI3F1ZXVlTWFza1VwZGF0ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdGhpcy4jcmVzaXplT2JzZXJ2ZXIub2JzZXJ2ZShlbGVtZW50LCB7IGJveDogXCJkZXZpY2UtcGl4ZWwtY29udGVudC1ib3hcIiBhcyBjb25zdCB9KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICB0aGlzLiNyZXNpemVPYnNlcnZlci5vYnNlcnZlKGVsZW1lbnQpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgI3F1ZXVlTWFza1VwZGF0ZSgpIHtcbiAgICAgICAgaWYgKCF0aGlzLiNjdXJyZW50SWNvblVybCB8fCAhdGhpcy5pc0Nvbm5lY3RlZCkgeyByZXR1cm47IH1cbiAgICAgICAgaWYgKHRoaXMuI3F1ZXVlZE1hc2tVcGRhdGUpIHsgcmV0dXJuOyB9XG5cbiAgICAgICAgY29uc3QgZm9yUmVzb2x2ZSA9IFByb21pc2Uud2l0aFJlc29sdmVyczx2b2lkPigpO1xuICAgICAgICB0aGlzLiNxdWV1ZWRNYXNrVXBkYXRlID0gZm9yUmVzb2x2ZT8ucHJvbWlzZTtcbiAgICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICAgIHRoaXMuI3F1ZXVlZE1hc2tVcGRhdGUgPSBudWxsO1xuICAgICAgICAgICAgZm9yUmVzb2x2ZT8ucmVzb2x2ZSgpO1xuICAgICAgICAgICAgY29uc3QgdXJsID0gdGhpcy4jY3VycmVudEljb25Vcmw7XG4gICAgICAgICAgICBpZiAoIXVybCB8fCAhdGhpcy5pc0Nvbm5lY3RlZCkgeyByZXR1cm47IH1cblxuICAgICAgICAgICAgY29uc3QgYnVja2V0ID0gdGhpcy4jZ2V0UmFzdGVyQnVja2V0KCk7XG4gICAgICAgICAgICBjb25zdCBpY29uTmFtZSA9IGNhbWVsVG9LZWJhYih0aGlzLmljb24pO1xuICAgICAgICAgICAgY29uc3QgaWNvblN0eWxlID0gdGhpcy5pY29uU3R5bGU7XG5cbiAgICAgICAgICAgIC8vIENoZWNrIGlmIENTUyBydWxlIGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGljb24gY29tYmluYXRpb25cbiAgICAgICAgICAgIGlmIChoYXNJY29uUnVsZShpY29uTmFtZSwgaWNvblN0eWxlLCBidWNrZXQpKSB7XG4gICAgICAgICAgICAgICAgLy8gUnVsZSBleGlzdHMsIENTUyBoYW5kbGVzIHRoZSBzdHlsaW5nIHZpYSBhdHRyaWJ1dGUgc2VsZWN0b3JzXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBHZW5lcmF0ZSBtYXNrIHZhbHVlIGFuZCByZWdpc3RlciBDU1MgcnVsZVxuICAgICAgICAgICAgZW5zdXJlTWFza1ZhbHVlKHVybCwgdGhpcy4jbWFza0tleUJhc2UsIGJ1Y2tldClcbiAgICAgICAgICAgICAgICAudGhlbigobWFza1ZhbHVlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbdWktaWNvbl0gR290IG1hc2sgdmFsdWUgZm9yICR7aWNvbk5hbWV9OiR7aWNvblN0eWxlfTpgLCBpY29uVXJsTWV0YUZvckxvZyhtYXNrVmFsdWUpKTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBSZWdpc3RlciB0aGUgaWNvbiBpbiBDU1MgcmVnaXN0cnkgd2l0aCBhdHRyaWJ1dGUtYmFzZWQgc2VsZWN0b3JcbiAgICAgICAgICAgICAgICAgICAgLy8gVGhlIHJ1bGU6IHVpLWljb25baWNvbj1cIm5hbWVcIl1baWNvbi1zdHlsZT1cInN0eWxlXCJdIHsgLS1pY29uLWltYWdlOiAuLi4gfVxuICAgICAgICAgICAgICAgICAgICByZWdpc3Rlckljb25SdWxlKGljb25OYW1lLCBpY29uU3R5bGUsIG1hc2tWYWx1ZSwgYnVja2V0KTtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFt1aS1pY29uXSBSZWdpc3RlcmVkIENTUyBydWxlIGZvciAke2ljb25OYW1lfToke2ljb25TdHlsZX1gKTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBLZWVwIGxvY2FsIHJlZiBmb3IgZmFsbGJhY2svZGVidWdnaW5nXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLiNtYXNrUmVmLnZhbHVlICE9PSBtYXNrVmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuI21hc2tSZWYudmFsdWUgPSBtYXNrVmFsdWU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4/LihcIlt1aS1pY29uXSBNYXNrIHVwZGF0ZSBmYWlsZWRcIiwgZXJyb3IpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgICNnZXRSYXN0ZXJCdWNrZXQoKTogbnVtYmVyIHtcbiAgICAgICAgY29uc3Qgc2VsZiA9IHRoaXMgYXMgdW5rbm93biBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgY29uc3QgaW5saW5lID0gTWF0aC5jZWlsKHRoaXMuI2RldmljZVBpeGVsU2l6ZT8uaW5saW5lIHx8IDApO1xuICAgICAgICBjb25zdCBibG9jayA9IE1hdGguY2VpbCh0aGlzLiNkZXZpY2VQaXhlbFNpemU/LmJsb2NrIHx8IDApO1xuICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBNYXRoLm1heChpbmxpbmUsIGJsb2NrKTtcbiAgICAgICAgaWYgKGNhbmRpZGF0ZSA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiBxdWFudGl6ZVRvQnVja2V0KGNhbmRpZGF0ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZmFsbGJhY2sgPSBNSU5fUkFTVEVSX1NJWkU7XG4gICAgICAgIGNvbnN0IHJhdGlvID1cbiAgICAgICAgICAgIHR5cGVvZiBkZXZpY2VQaXhlbFJhdGlvID09PSBcIm51bWJlclwiICYmIGlzRmluaXRlKGRldmljZVBpeGVsUmF0aW8pXG4gICAgICAgICAgICAgICAgPyBkZXZpY2VQaXhlbFJhdGlvXG4gICAgICAgICAgICAgICAgOiAxO1xuXG4gICAgICAgIGlmICh0eXBlb2Ygc2VsZi5nZXRCb3VuZGluZ0NsaWVudFJlY3QgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgY29uc3QgcmVjdCA9IHNlbGYuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgICBjb25zdCBtYXhpbXVtID0gTWF0aC5tYXgocmVjdC53aWR0aCwgcmVjdC5oZWlnaHQpICogcmF0aW87XG4gICAgICAgICAgICBpZiAobWF4aW11bSA+IDApIHtcbiAgICAgICAgICAgICAgICBmYWxsYmFjayA9IG1heGltdW07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcXVhbnRpemVUb0J1Y2tldChmYWxsYmFjayk7XG4gICAgfVxufVxuXG5kZWNsYXJlIGdsb2JhbCB7XG4gICAgaW50ZXJmYWNlIEhUTUxFbGVtZW50VGFnTmFtZU1hcCB7XG4gICAgICAgIFwidWktaWNvblwiOiBVSVBob3NwaG9ySWNvbjtcbiAgICB9XG59XG5cbmlmICh0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiICYmICFjdXN0b21FbGVtZW50cy5nZXQoXCJ1aS1pY29uXCIpKSB7XG4gICAgY29uc29sZS5sb2coVUlQaG9zcGhvckljb24pO1xuICAgIGN1c3RvbUVsZW1lbnRzLmRlZmluZShcInVpLWljb25cIiwgVUlQaG9zcGhvckljb24pO1xufVxuIl19