import { useSyncExternalStore } from "react";

/** ComfyUI 任务的实时状态：排队中的位置，或正在执行的节点和步数。 */
export type ComfyProgress = { phase: "queued"; position: number } | { phase: "running"; value?: number; max?: number; node?: string };

/**
 * 按请求的 AbortSignal 记录 ComfyUI 进度；画布在发起生成时把 signal 绑到节点上，节点就能显示真实进度。
 * 只放在内存里，不写进画布数据。
 */
const progressBySignal = new Map<AbortSignal, ComfyProgress>();
const nodesBySignal = new Map<AbortSignal, Set<string>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
    version += 1;
    listeners.forEach((listener) => listener());
}

export function setComfyProgress(signal: AbortSignal | undefined, progress: ComfyProgress) {
    if (!signal || signal.aborted) return;
    const current = progressBySignal.get(signal);
    if (current && JSON.stringify(current) === JSON.stringify(progress)) return;
    progressBySignal.set(signal, progress);
    emit();
}

export function clearComfyProgress(signal: AbortSignal | undefined) {
    if (signal && progressBySignal.delete(signal)) emit();
}

/** 把一次生成请求绑到画布节点上；请求结束或取消时自动解绑。 */
export function bindComfyProgressNode(signal: AbortSignal, nodeId: string) {
    const nodes = nodesBySignal.get(signal) || new Set<string>();
    nodes.add(nodeId);
    if (nodesBySignal.has(signal)) return;
    nodesBySignal.set(signal, nodes);
    signal.addEventListener("abort", () => unbindComfyProgress(signal), { once: true });
}

export function unbindComfyProgress(signal: AbortSignal) {
    const had = nodesBySignal.delete(signal) || progressBySignal.delete(signal);
    progressBySignal.delete(signal);
    if (had) emit();
}

export function getComfyNodeProgress(nodeId: string | undefined): ComfyProgress | undefined {
    if (!nodeId) return undefined;
    for (const [signal, nodes] of nodesBySignal) {
        if (nodes.has(nodeId)) {
            const progress = progressBySignal.get(signal);
            if (progress) return progress;
        }
    }
    return undefined;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 读取绑在节点上的 ComfyUI 进度；不是 ComfyUI 任务时为 undefined。 */
export function useComfyNodeProgress(nodeId: string | undefined) {
    useSyncExternalStore(subscribe, () => version);
    return getComfyNodeProgress(nodeId);
}
