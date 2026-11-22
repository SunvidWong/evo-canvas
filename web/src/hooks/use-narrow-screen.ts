import { useSyncExternalStore } from "react";

/** 手机宽度断点：小于 768px 时侧边面板改为浮层，不挤占画布。 */
export const NARROW_SCREEN_WIDTH = 768;

function subscribe(callback: () => void) {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("resize", callback);
    return () => window.removeEventListener("resize", callback);
}

function viewportWidth() {
    return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

export function isNarrowScreen() {
    return viewportWidth() < NARROW_SCREEN_WIDTH;
}

/** 当前窗口宽度；旋转屏幕或改变窗口大小时自动更新，用于按屏幕宽度设置浮层面板尺寸。 */
export function useViewportWidth() {
    return useSyncExternalStore(subscribe, viewportWidth, () => Number.POSITIVE_INFINITY);
}

/** 当前是否为手机宽度，窗口尺寸变化时自动更新。 */
export function useNarrowScreen() {
    return useViewportWidth() < NARROW_SCREEN_WIDTH;
}
