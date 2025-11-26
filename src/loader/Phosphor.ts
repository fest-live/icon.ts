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
    MIN_RASTER_SIZE,
    quantizeToBucket,
    camelToKebab,
    generateIconImageVariable,
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
        return ["icon", "icon-style", "size", "width"];
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
        } else {
            this.updateIcon();
        }
    }

    disconnectedCallback(): void {
        this.#resizeObserver?.disconnect();
        this.#resizeObserver = undefined;
        this.#teardownVisibilityObserver();
        this.#queuedMaskUpdate = null;
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
                    this.style.setProperty("--icon-size", newValue);
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
                    const value = /^\d+$/.test(newValue) ? `${newValue}px` : newValue;
                    this.style.width = value;
                }
                if (this.isConnected) {
                    this.#queueMaskUpdate();
                }
                break;
            }
        }
    }

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

        const iconStyle = (this.iconStyle ?? "duotone")?.trim?.()?.toLowerCase?.();
        const ICON = camelToKebab(nextIcon);
        const assetPath = `./assets/icons/${iconStyle}/${ICON}-${iconStyle}.svg`;
        const requestKey = `${iconStyle}:${ICON}`;

        this.#maskKeyBase = requestKey;

        //
        requestAnimationFrame(() => {
            if (this?.checkVisibility?.({
                contentVisibilityAuto: true,
                opacityProperty: false,
                visibilityProperty: false,
            })) {
                loadAsImage(assetPath)
                    ?.then((url) => {
                        if (!url) { return; }
                        if (this.#maskKeyBase !== requestKey) { return; } // игнор, если уже запросили новую иконку
                        this.#currentIconUrl = url;
                        this.#queueMaskUpdate();
                    })
                    ?.catch((error) => {
                        if (typeof console !== "undefined") {
                            console.warn?.("[ui-icon] Failed to load icon", assetPath, error);
                        }
                    });
            }
        });

        return this;
    }

    #setupVisibilityObserver() {
        if (typeof IntersectionObserver === "undefined") {
            this.#isIntersecting = true;
            return;
        }

        if (this.#intersectionObserver) { return; }

        this.#intersectionObserver = new IntersectionObserver((entries) => {
            const isIntersecting = entries.some((entry) => entry.isIntersecting);
            if (isIntersecting !== this.#isIntersecting) {
                this.#isIntersecting = isIntersecting;
                if (isIntersecting) {
                    this.updateIcon(this.#pendingIconName ?? this.icon);
                }
            }
        }, { rootMargin: "100px" });

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
            this.style.setProperty("--icon-size", sizeAttr);
        }

        if (!this.style.getPropertyValue("--icon-image")) {
            this.style.setProperty("--icon-image", this.#maskRef.value || "linear-gradient(#0000, #0000)");
        }
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

        //
        const self = this as unknown as HTMLElement;
        const forResolve = Promise.withResolvers<void>();
        this.#queuedMaskUpdate = forResolve?.promise;
        queueMicrotask(() => {
            this.#queuedMaskUpdate = null;
            forResolve?.resolve();
            const url = this.#currentIconUrl;
            if (!url || !this.isConnected) { return; }

            const bucket = this.#getRasterBucket();
            const cacheKey = this.#maskKeyBase || url;

            ensureMaskValue(url, cacheKey, bucket)
                .then((maskValue) => {
                    if (this.#maskRef.value !== maskValue) {
                        this.#maskRef.value = maskValue;
                        self.style.setProperty("--icon-image", maskValue);
                        generateIconImageVariable(this.#maskKeyBase, url, bucket);
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
