import { useSyncExternalStore } from "react";

/** 手机宽度断点：小于 768px 时侧边面板改为浮层，不挤占画布。 */
export const NARROW_SCREEN_QUERY = "(max-width: 767px)";

function subscribe(callback: () => void) {
    if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
    const media = window.matchMedia(NARROW_SCREEN_QUERY);
    media.addEventListener("change", callback);
    return () => media.removeEventListener("change", callback);
}

export function isNarrowScreen() {
    return typeof window !== "undefined" && Boolean(window.matchMedia?.(NARROW_SCREEN_QUERY).matches);
}

/** 当前是否为手机宽度，窗口尺寸变化时自动更新。 */
export function useNarrowScreen() {
    return useSyncExternalStore(subscribe, isNarrowScreen, () => false);
}
