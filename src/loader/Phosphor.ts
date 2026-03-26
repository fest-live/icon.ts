// should to return from source code to style element (in shadow DOM)
export const preloadStyle = (srcCode: string) => {
    const content = typeof srcCode === "string" ? srcCode?.trim?.() : "";
    if (!content) { return () => null as HTMLStyleElement | null; }

    //
    if (typeof document === "undefined") { return null; }
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-ui-phosphor-icon", "true");
    styleEl.textContent = content;

    //
    return () => styleEl?.cloneNode?.(true);
};

// @ts-ignore – Vite inline import
import styles from "./Phosphor.scss?inline";
import { FALLBACK_ICON_DATA_URL } from "./fallback-icon-data-url";
import {
    ensureMaskValue,
    loadAsImage,
    prefetchIcon,
    MIN_RASTER_SIZE,
    quantizeToBucket,
    camelToKebab,
    PHOSPHOR_CORE_NPM_VERSION,
    resolvePhosphorIconFileBase,
    registerIconRule,
    hasIconRule,
    type DevicePixelSize,
} from "./Loader";
import { PHOSPHOR_DUOTONE_STATIC } from "./generated/phosphor-duotone-known";

//
const createStyle = preloadStyle(styles);

const iconUrlMetaForLog = (value: unknown): Record<string, unknown> => {
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
    #intersectionStateKnown = false;

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

        const pendingIcon = this.#pendingIconName ?? this.icon;
        if (pendingIcon) {
            this.updateIcon(pendingIcon);
        } else if (this.icon) {
            this.updateIcon(this.icon);
        }
    }

    disconnectedCallback(): void {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = undefined;
        this.#teardownVisibilityObserver();
        this.#queuedMaskUpdate = null;
        this.#retryAttempt = 0;
        this.#intersectionStateKnown = false;
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

    /** Same-origin paths first, then CDN (Loader races mirrors with concurrency 2). */
    #phosphorSourcesForIcon(nextIcon: string): { sources: string[]; requestKey: string } | null {
        let iconStyle = (this.iconStyle ?? "duotone")?.trim?.()?.toLowerCase?.();
        const ICON = resolvePhosphorIconFileBase(nextIcon);
        if (!ICON || !/^[a-z0-9-]+$/.test(ICON)) {
            console.warn(`[ui-icon] Invalid icon name: ${ICON}`);
            return null;
        }
        const validStyles = ["thin", "light", "regular", "bold", "fill", "duotone"];
        if (!validStyles.includes(iconStyle)) {
            console.warn(`[ui-icon] Invalid icon style: ${iconStyle}, defaulting to 'duotone'`);
            iconStyle = "duotone";
        }
        const iconFileName =
            iconStyle === "duotone" ? `${ICON}-duotone` : iconStyle !== "regular" ? `${ICON}-${iconStyle}` : ICON;
        const directCdnPath = `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@${PHOSPHOR_CORE_NPM_VERSION}/assets/${iconStyle}/${iconFileName}.svg`;
        const base = (this.iconBase ?? "").trim().replace(/\/+$/, "");
        const localPath = base ? `${base}/${iconStyle}/${iconFileName}.svg` : "";
        const sources = localPath ? [localPath, directCdnPath] : [directCdnPath];
        return { sources, requestKey: `${iconStyle}:${ICON}` };
    }

    public updateIcon(icon?: string) {
        const candidate = typeof icon === "string" && icon.length > 0 ? icon : this.icon;
        const nextIcon = candidate?.trim?.() ?? "";

        if (!this.isConnected) {
            this.#pendingIconName = nextIcon;
            return this;
        }

        if (!nextIcon) {
            this.#pendingIconName = null;
            this.#currentIconUrl = "";
            this.#maskKeyBase = "";
            return this;
        }

        const kebab = resolvePhosphorIconFileBase(nextIcon);
        const styleKey = (this.iconStyle ?? "duotone").trim().toLowerCase();
        if (
            kebab &&
            /^[a-z0-9-]+$/i.test(kebab) &&
            styleKey === "duotone" &&
            PHOSPHOR_DUOTONE_STATIC.has(kebab)
        ) {
            this.#pendingIconName = null;
            this.#currentIconUrl = "";
            this.#maskKeyBase = "";
            return this;
        }

        if (
            typeof IntersectionObserver !== "undefined" &&
            this.#intersectionStateKnown &&
            !this.#isIntersecting
        ) {
            this.#pendingIconName = nextIcon;
            const prePack = this.#phosphorSourcesForIcon(nextIcon);
            if (prePack) {
                for (const src of prePack.sources) {
                    prefetchIcon(src);
                }
            }
            return this;
        }

        this.#pendingIconName = null;

        const pack = this.#phosphorSourcesForIcon(nextIcon);
        if (!pack) {
            return this;
        }

        const { sources, requestKey } = pack;
        this.#maskKeyBase = requestKey;

        requestAnimationFrame(() => {
            const shouldLoad =
                !this.#currentIconUrl ||
                this.#isIntersecting ||
                (this?.checkVisibility?.({
                    contentVisibilityAuto: true,
                    opacityProperty: true,
                    visibilityProperty: true,
                }) ??
                    true);

            if (!shouldLoad) {
                return;
            }

            (async () => {
                let lastUrl: string | null = null;
                let lastError: unknown = null;
                const localPath = sources.length > 1 ? sources[0] : "";

                for (const src of sources) {
                    try {
                        const url = await loadAsImage(src, undefined, { fetchPriority: "high" });
                        lastUrl = url;
                        if (src === localPath && url === FALLBACK_ICON_DATA_URL) {
                            continue;
                        }
                        break;
                    } catch (e) {
                        lastError = e;
                    }
                }

                const url = lastUrl;
                if (!url || typeof url !== "string") {
                    console.warn(`[ui-icon] Invalid URL returned for ${requestKey}:`, iconUrlMetaForLog(url));
                    return;
                }
                if (this.#maskKeyBase !== requestKey) {
                    return;
                }
                this.#currentIconUrl = url;
                this.#retryAttempt = 0;
                this.#queueMaskUpdate();

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
                    console.error?.("[ui-icon] Failed to load icon sources", { sources }, error);
                }
            });
        });

        return this;
    }

    #setupVisibilityObserver() {
        if (typeof IntersectionObserver === "undefined") {
            this.#isIntersecting = true;
            this.#intersectionStateKnown = true;
            return;
        }

        if (this.#intersectionObserver) {
            return;
        }

        this.#intersectionObserver = new IntersectionObserver((entries) => {
            const isIntersecting = entries.some((entry) => entry.isIntersecting);
            this.#intersectionStateKnown = true;

            if (isIntersecting !== this.#isIntersecting) {
                this.#isIntersecting = isIntersecting;
                if (isIntersecting) {
                    this.updateIcon(this.#pendingIconName ?? this.icon);
                }
            }
        }, { rootMargin: "200px" });

        this.#intersectionObserver.observe(this);

        // Handle content-visibility
        // @ts-ignore
        this.addEventListener("contentvisibilityautostatechange", this.#handleContentVisibility);
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

        /* Duotone icons: static --icon-image from Phosphor.scss generated map; other styles via Loader + CSSIconRegistry. */
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
                    registerIconRule(iconName, iconStyle, maskValue, bucket);

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
    customElements.define("ui-icon", UIPhosphorIcon);
}
