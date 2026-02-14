// should to return from source code to style element (in shadow DOM)
export const preloadStyle = (srcCode: string) => {
    const content = typeof srcCode === "string" ? srcCode?.trim?.() : "";
    if (!content) { return () => null as HTMLStyleElement | null; }
    const styleURL = URL.createObjectURL(new Blob([content], {type: "text/css"}));

    //
    if (typeof document === "undefined") { return null; }
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-ui-phosphor-icon", "true");
    styleEl.innerHTML = `@import url("${styleURL}");`;

    //
    return () => styleEl?.cloneNode?.(true);;
};

// @ts-ignore – Vite inline import
import styles from "./Phosphor.scss?inline";
import {
    ensureMaskValue,
    loadAsImage,
    FALLBACK_ICON_DATA_URL,
    MIN_RASTER_SIZE,
    quantizeToBucket,
    camelToKebab,
    generateIconImageVariable,
    registerIconRule,
    hasIconRule,
    type DevicePixelSize,
} from "./Loader";

//
const createStyle = preloadStyle(styles);

// Handle non-string or empty inputs gracefully
const capitalizeFirstLetter = (str: unknown) => {
    if (typeof str !== "string" || str.length === 0) { return str; }
    return str.charAt(0).toUpperCase() + str.slice(1);
};

// @ts-ignore
export class UIPhosphorIcon extends HTMLElement {
    static get observedAttributes() {
        return ["icon", "icon-style", "size", "width", "icon-base"];
    }

    #options: { padding?: number | string; icon?: string; iconStyle?: string } = {
        padding: 0,
        icon: "",
        iconStyle: "duotone",
    };
    #resizeObserver?: ResizeObserver;
    #devicePixelSize: DevicePixelSize = {
        inline: MIN_RASTER_SIZE,
        block: MIN_RASTER_SIZE,
    };
    #queuedMaskUpdate: Promise<void> | null = null;
    #currentIconUrl = "";
    #maskKeyBase = "";
    #maskRef = { value: "" };
    #styleAttached = false;
    #pendingIconName: string | null = null;
    #intersectionObserver?: IntersectionObserver;
    #isIntersecting = false;

    constructor(
        options: Partial<{ icon: string; iconStyle: string; padding: number | string }> = {},
    ) {
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

    get icon(): string {
        return this.getAttribute("icon") ?? "";
    }

    set icon(value: string) {
        if (value == null || value === "") {
            this.removeAttribute("icon");
            return;
        }
        const normalized = String(value);
        if (this.getAttribute("icon") !== normalized) {
            this.setAttribute("icon", normalized);
        }
    }

    get iconStyle(): string {
        return this.getAttribute("icon-style") ?? this.#options.iconStyle ?? "duotone";
    }

    set iconStyle(value: string) {
        const normalized = (value ?? "")?.trim?.()?.toLowerCase?.();
        if (!normalized) {
            this.removeAttribute("icon-style");
            return;
        }
        if (this.getAttribute("icon-style") !== normalized) {
            this.setAttribute("icon-style", normalized);
        }
    }

    get size(): string | null {
        return this.getAttribute("size");
    }

    set size(value: string | null) {
        if (value == null || value === "") {
            this.removeAttribute("size");
            return;
        }
        const normalized = String(value);
        if (this.getAttribute("size") !== normalized) {
            this.setAttribute("size", normalized);
        }
    }

    get width(): string | null {
        return this.getAttribute("width");
    }

    set width(value: string | number | null) {
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
    get iconBase(): string {
        return this.getAttribute("icon-base") ?? "";
    }

    set iconBase(value: string) {
        const normalized = (value ?? "").trim();
        if (!normalized) {
            this.removeAttribute("icon-base");
            return;
        }
        if (this.getAttribute("icon-base") !== normalized) {
            this.setAttribute("icon-base", normalized);
        }
    }

    connectedCallback(): void {
        this.#applyHostDefaults();
        this.#setupResizeObserver(this);
        this.#setupVisibilityObserver();

        if (!this.#styleAttached) {
            const styleNode = createStyle?.() ?? null;
            if (styleNode) { this.shadowRoot!.appendChild(styleNode); }
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
        } else if (this.icon) {
            console.log(`[ui-icon] Loading current icon: ${this.icon}`);
            this.updateIcon(this.icon);
        } else {
            console.log(`[ui-icon] No icon to load`);
        }
    }

    disconnectedCallback(): void {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = undefined;
        this.#teardownVisibilityObserver();
        this.#queuedMaskUpdate = null;
        this.#retryAttempt = 0;
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
        if (oldValue === newValue) { return; }

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
                } else {
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
                } else {
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
    static readonly #MAX_ICON_RETRIES = 3;
    static readonly #RETRY_DELAY_MS = 500;

    public updateIcon(icon?: string) {
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

        if (!nextIcon) { return this; }

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
                    let lastUrl: string | null = null;
                    let lastError: unknown = null;

                    for (const src of sources) {
                        try {
                            const url = await loadAsImage(src);
                            lastUrl = url;

                            // If local source returns fallback placeholder, try the CDN next.
                            if (src === localPath && url === FALLBACK_ICON_DATA_URL) {
                                continue;
                            }
                            break;
                        } catch (e) {
                            lastError = e;
                        }
                    }

                    const url = lastUrl;
                    console.log(`[ui-icon] Loaded icon ${requestKey} (${localPath ? "local+proxy+fallback" : "proxy+fallback"}):`, url);
                    if (!url || typeof url !== "string") {
                        console.warn(`[ui-icon] Invalid URL returned for ${requestKey}:`, url);
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

    #handleContentVisibility = (e: Event) => {
        // @ts-ignore
        if (e.skipped === false) {
            this.updateIcon(this.#pendingIconName ?? this.icon);
        }
    }

    #ensureShadowRoot() {
        if (!this.shadowRoot) {
            this.attachShadow({ mode: "open" });
        }
    }

    #applyHostDefaults() {
        this.classList.add("ui-icon", "u2-icon");

        try {
            (this as unknown as { inert: boolean }).inert = true;
        } catch {
            this.setAttribute("inert", "");
        }

        /*if (!this.hasAttribute("aria-hidden")) {
            this.setAttribute("aria-hidden", "true");
        }*/

        const paddingOption = this.#options.padding;
        if (
            !this.style.getPropertyValue("--icon-padding") &&
            paddingOption !== undefined &&
            paddingOption !== null &&
            paddingOption !== ""
        ) {
            const paddingValue =
                typeof paddingOption === "number" ? `${paddingOption}rem` : String(paddingOption);
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

    #setupResizeObserver(element: HTMLElement) {
        if (typeof ResizeObserver === "undefined" || this.#resizeObserver) { return; }
        this.#resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target !== element) { continue; }

                const deviceSize = entry.devicePixelContentBoxSize?.[0];
                const contentSize = Array.isArray(entry.contentBoxSize)
                    ? entry.contentBoxSize[0]
                    : (entry.contentBoxSize as unknown as ResizeObserverSize | undefined);

                const ratio =
                    typeof devicePixelRatio === "number" && isFinite(devicePixelRatio)
                        ? devicePixelRatio
                        : 1;

                const inline =
                    deviceSize?.inlineSize ??
                    (contentSize?.inlineSize ?? entry.contentRect?.width ?? element.clientWidth ?? MIN_RASTER_SIZE) *
                        ratio;
                const block =
                    deviceSize?.blockSize ??
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
            this.#resizeObserver.observe(element, { box: "device-pixel-content-box" as const });
        } catch {
            this.#resizeObserver.observe(element);
        }
    }

    #queueMaskUpdate() {
        if (!this.#currentIconUrl || !this.isConnected) { return; }
        if (this.#queuedMaskUpdate) { return; }

        const forResolve = Promise.withResolvers<void>();
        this.#queuedMaskUpdate = forResolve?.promise;
        requestAnimationFrame(() => {
            this.#queuedMaskUpdate = null;
            forResolve?.resolve();
            const url = this.#currentIconUrl;
            if (!url || !this.isConnected) { return; }

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
                    console.log(`[ui-icon] Got mask value for ${iconName}:${iconStyle}:`, maskValue);

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

    #getRasterBucket(): number {
        const self = this as unknown as HTMLElement;
        const inline = Math.ceil(this.#devicePixelSize?.inline || 0);
        const block = Math.ceil(this.#devicePixelSize?.block || 0);
        const candidate = Math.max(inline, block);
        if (candidate > 0) {
            return quantizeToBucket(candidate);
        }

        let fallback = MIN_RASTER_SIZE;
        const ratio =
            typeof devicePixelRatio === "number" && isFinite(devicePixelRatio)
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

declare global {
    interface HTMLElementTagNameMap {
        "ui-icon": UIPhosphorIcon;
    }
}

if (typeof window !== "undefined" && !customElements.get("ui-icon")) {
    console.log(UIPhosphorIcon);
    customElements.define("ui-icon", UIPhosphorIcon);
}
