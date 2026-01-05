import { UIPhosphorIcon } from "./loader/Phosphor";
export default UIPhosphorIcon;
export { UIPhosphorIcon };

// OPFS cache utilities for icon management
export {
    isOPFSSupported,
    initOPFSCache,
    clearAllCache as clearIconCache,
    getCacheStats as getIconCacheStats,
    validateAndCleanCache,
} from "./loader/OPFSCache";

// Icon loading cache utilities
export {
    clearIconCaches,
    invalidateIconCache,
    testIconRacing,
    debugIconSystem,
} from "./loader/Loader";

// CSS-based icon registry utilities
export {
    ensureStyleSheet,
    registerIconRule,
    hasIconRule,
    clearIconRules,
    clearRegistryState,
    reinitializeRegistry,
    getRegistryStats,
    preregisterIcons,
} from "./loader/CSSIconRegistry";

console.log(UIPhosphorIcon);
