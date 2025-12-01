import { UIPhosphorIcon } from "./loader/Phosphor";
export default UIPhosphorIcon;
export { UIPhosphorIcon };

// OPFS cache utilities for icon management
export {
    isOPFSSupported,
    initOPFSCache,
    clearAllCache as clearIconCache,
    getCacheStats as getIconCacheStats,
} from "./loader/OPFSCache";

// CSS-based icon registry utilities
export {
    ensureStyleSheet,
    registerIconRule,
    hasIconRule,
    clearIconRules,
    getRegistryStats,
    preregisterIcons,
} from "./loader/CSSIconRegistry";

console.log(UIPhosphorIcon);
