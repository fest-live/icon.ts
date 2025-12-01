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

console.log(UIPhosphorIcon);