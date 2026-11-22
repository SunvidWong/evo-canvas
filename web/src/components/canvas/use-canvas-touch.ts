import { useEffect, useRef, type RefObject } from "react";

import type { ViewportTransform } from "@/types/canvas";

/** 长按多久弹出右键菜单。 */
const LONG_PRESS_MS = 500;
/** 手指移动超过这个距离（像素）就不算点按或长按。 */
const TAP_SLOP = 8;
/** 触摸结束后多久内忽略浏览器补发的兼容鼠标事件。 */
const COMPAT_MOUSE_WINDOW_MS = 800;
const MIN_SCALE = 0.05;
const MAX_SCALE = 5;

/** 交给浏览器原生处理的元素：输入框、按钮、链接以及显式标记不参与画布手势的区域。 */
const NATIVE_TARGET = "input,textarea,select,button,a,[contenteditable='true'],[role='button'],[role='slider'],[data-canvas-no-zoom],[data-connection-create-menu]";
/** 需要把触摸转成鼠标事件的画布元素：节点（含缩放手柄、连线端点）和连线。 */
const BRIDGED_TARGET = "[data-node-id],[data-connection-id]";

type Point = { x: number; y: number };
type TouchMode =
    | { kind: "none" }
    | { kind: "native" }
    | { kind: "bridge"; target: Element; start: Point; last: Point; moved: boolean }
    | { kind: "pan"; target: Element; start: Point; initial: ViewportTransform; moved: boolean }
    | { kind: "pinch"; startDistance: number; startMid: Point; initial: ViewportTransform }
    | { kind: "done" };

type CanvasTouchOptions = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasDeselect?: () => void;
};

/**
 * 画布触控：单指拖背景平移、双指缩放和平移、长按弹出右键菜单。
 * 节点和连线原本只认鼠标事件，单指在它们上面拖动时转发成 mousedown/mousemove/mouseup，复用现有的选择、拖动、缩放和连线逻辑。
 * 只处理 pointerType 为 touch 的事件，鼠标和触控笔的行为不变。
 */
export function useCanvasTouch({ containerRef, viewport, onViewportChange, onCanvasDeselect }: CanvasTouchOptions) {
    const viewportRef = useRef(viewport);
    const callbacksRef = useRef({ onViewportChange, onCanvasDeselect });
    viewportRef.current = viewport;
    callbacksRef.current = { onViewportChange, onCanvasDeselect };

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const pointers = new Map<number, Point>();
        let mode: TouchMode = { kind: "none" };
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let lastTouchAt = 0;

        const clearLongPress = () => {
            if (longPressTimer) clearTimeout(longPressTimer);
            longPressTimer = null;
        };
        const dispatchMouse = (target: EventTarget, type: string, point: Point) => {
            target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, button: type === "contextmenu" ? 2 : 0, buttons: type === "mouseup" || type === "contextmenu" ? 0 : 1, view: window }));
        };
        const pinchState = () => {
            const [a, b] = [...pointers.values()];
            return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        };
        /** 结束单指动作；转发中的拖动用最后位置收尾，避免节点停在半路。 */
        const endSingle = () => {
            clearLongPress();
            if (mode.kind === "bridge") dispatchMouse(window, "mouseup", mode.last);
        };

        const handlePointerDown = (event: PointerEvent) => {
            if (event.pointerType !== "touch") return;
            lastTouchAt = Date.now();
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const target = event.target instanceof Element ? event.target : null;
            if (pointers.size === 2 && mode.kind !== "native") {
                endSingle();
                const { distance, mid } = pinchState();
                mode = { kind: "pinch", startDistance: distance, startMid: mid, initial: viewportRef.current };
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (pointers.size !== 1) return;
            if (!target || target.closest(NATIVE_TARGET)) {
                mode = { kind: "native" };
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const start = { x: event.clientX, y: event.clientY };
            if (target.closest(BRIDGED_TARGET)) {
                mode = { kind: "bridge", target, start, last: start, moved: false };
                dispatchMouse(target, "mousedown", start);
            } else {
                mode = { kind: "pan", target, start, initial: viewportRef.current, moved: false };
            }
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                if ((mode.kind !== "bridge" && mode.kind !== "pan") || mode.moved) return;
                const pressed = mode;
                if (pressed.kind === "bridge") dispatchMouse(window, "mouseup", pressed.start);
                mode = { kind: "done" };
                dispatchMouse(pressed.target, "contextmenu", pressed.start);
            }, LONG_PRESS_MS);
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (event.pointerType !== "touch" || !pointers.has(event.pointerId)) return;
            lastTouchAt = Date.now();
            const point = { x: event.clientX, y: event.clientY };
            pointers.set(event.pointerId, point);
            if (mode.kind === "pinch" && pointers.size >= 2) {
                event.preventDefault();
                const rect = container.getBoundingClientRect();
                const { distance, mid } = pinchState();
                const { initial, startDistance, startMid } = mode;
                const k = Math.min(Math.max(initial.k * (distance / startDistance), MIN_SCALE), MAX_SCALE);
                // 起始中点对应的画布坐标跟着当前中点走，同时实现缩放和双指平移。
                const worldX = (startMid.x - rect.left - initial.x) / initial.k;
                const worldY = (startMid.y - rect.top - initial.y) / initial.k;
                callbacksRef.current.onViewportChange({ x: mid.x - rect.left - worldX * k, y: mid.y - rect.top - worldY * k, k });
                return;
            }
            if (mode.kind === "bridge") {
                event.preventDefault();
                if (!mode.moved && Math.hypot(point.x - mode.start.x, point.y - mode.start.y) > TAP_SLOP) {
                    mode.moved = true;
                    clearLongPress();
                }
                mode.last = point;
                dispatchMouse(window, "mousemove", point);
                return;
            }
            if (mode.kind === "pan") {
                event.preventDefault();
                const dx = point.x - mode.start.x;
                const dy = point.y - mode.start.y;
                if (!mode.moved && Math.hypot(dx, dy) > TAP_SLOP) {
                    mode.moved = true;
                    clearLongPress();
                }
                if (mode.moved) callbacksRef.current.onViewportChange({ x: mode.initial.x + dx, y: mode.initial.y + dy, k: viewportRef.current.k });
            }
        };

        const handlePointerEnd = (event: PointerEvent) => {
            if (event.pointerType !== "touch" || !pointers.has(event.pointerId)) return;
            lastTouchAt = Date.now();
            pointers.delete(event.pointerId);
            if (mode.kind === "pinch") {
                // 双指松开一只后，剩下的手指不再触发平移或拖动，等全部松开再开始新手势。
                if (!pointers.size) mode = { kind: "none" };
                else mode = { kind: "done" };
                return;
            }
            if (pointers.size) return;
            clearLongPress();
            // 用最后一次移动的位置收尾；部分浏览器 pointercancel 时坐标为 0。
            if (mode.kind === "bridge") dispatchMouse(window, "mouseup", mode.last);
            if (mode.kind === "pan" && !mode.moved && event.type === "pointerup") callbacksRef.current.onCanvasDeselect?.();
            mode = { kind: "none" };
        };

        // 已转发成鼠标事件的触摸，浏览器在松手后还会补发一次兼容鼠标事件和长按菜单，这里拦掉避免重复触发。
        const suppressCompatMouse = (event: MouseEvent) => {
            if (!event.isTrusted || Date.now() - lastTouchAt > COMPAT_MOUSE_WINDOW_MS) return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !container.contains(target) || target.closest(NATIVE_TARGET)) return;
            if (event.type === "contextmenu") event.preventDefault();
            event.stopImmediatePropagation();
        };

        container.addEventListener("pointerdown", handlePointerDown, { capture: true });
        window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
        window.addEventListener("pointerup", handlePointerEnd, { capture: true });
        window.addEventListener("pointercancel", handlePointerEnd, { capture: true });
        const compatEvents = ["mousedown", "mouseup", "mousemove", "contextmenu"] as const;
        compatEvents.forEach((type) => window.addEventListener(type, suppressCompatMouse, { capture: true }));
        return () => {
            clearLongPress();
            container.removeEventListener("pointerdown", handlePointerDown, { capture: true });
            window.removeEventListener("pointermove", handlePointerMove, { capture: true });
            window.removeEventListener("pointerup", handlePointerEnd, { capture: true });
            window.removeEventListener("pointercancel", handlePointerEnd, { capture: true });
            compatEvents.forEach((type) => window.removeEventListener(type, suppressCompatMouse, { capture: true }));
        };
    }, [containerRef]);
}
