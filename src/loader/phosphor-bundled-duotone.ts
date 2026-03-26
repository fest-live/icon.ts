/**
 * Icons baked into Phosphor.scss (generated map). Registry rules must not set
 * `--icon-image` for these or they override `:host` rules in the shadow sheet.
 */
import { PHOSPHOR_DUOTONE_STATIC } from "./generated/phosphor-duotone-known.ts";

/** Keep in sync with Loader.ts `PHOSPHOR_KEBAB_ALIASES`. */
const PHOSPHOR_KEBAB_ALIASES: Record<string, string> = {
    history: "clock-counter-clockwise",
};

const camelToKebab = (camel: string): string => {
    if (typeof camel !== "string") {
        return "";
    }
    return camel
        .replace(/[_\s]+/g, "-")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
        .toLowerCase();
};

const resolveBase = (iconName: string): string => {
    const k = camelToKebab(iconName.trim());
    return PHOSPHOR_KEBAB_ALIASES[k] ?? k;
};

export const isBundledPhosphorDuotone = (iconName: string, iconStyle: string): boolean => {
    if (iconStyle.trim().toLowerCase() !== "duotone") {
        return false;
    }
    const base = resolveBase(iconName);
    if (!base || !/^[a-z0-9-]+$/i.test(base)) {
        return false;
    }
    return PHOSPHOR_DUOTONE_STATIC.has(base);
};
