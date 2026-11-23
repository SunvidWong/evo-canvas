import { useSyncExternalStore } from "react";

/** ComfyUI 任务的实时状态：排队中的位置，或正在执行的节点和步数。 */
export type ComfyProgress = { phase: "queued"; position: number } | { phase: "running"; value?: number; max?: number; node?: string };

/**
 * 按请求的 AbortSignal 记录 ComfyUI 进度；同一个 signal 下可能并发跑多个工作流（例如一次生成多张图），每个工作流单独记录。
 * 画布在发起生成时把 signal 绑到节点或图片上，节点就能显示真实进度。只放在内存里，不写进画布数据。
 */
const progressBySignal = new Map<AbortSignal, Map<string, ComfyProgress>>();
const keysBySignal = new Map<AbortSignal, Set<string>>();
/** 每个工作流最新一帧预览图的 object URL；被新帧替换或任务结束时释放。 */
const previewBySignal = new Map<AbortSignal, Map<string, string>>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
    version += 1;
    listeners.forEach((listener) => listener());
}

export function setComfyProgress(signal: AbortSignal | undefined, runId: string, progress: ComfyProgress) {
    if (!signal || signal.aborted) return;
    const runs = progressBySignal.get(signal) || new Map<string, ComfyProgress>();
    const current = runs.get(runId);
    if (current && JSON.stringify(current) === JSON.stringify(progress)) return;
    runs.set(runId, progress);
    progressBySignal.set(signal, runs);
    emit();
}

/** 记下这次工作流的最新预览图；只在浏览器里有 object URL 时生效。 */
export function setComfyPreview(signal: AbortSignal | undefined, runId: string, image: Blob) {
    if (!signal || signal.aborted || typeof URL.createObjectURL !== "function") return;
    const previews = previewBySignal.get(signal) || new Map<string, string>();
    const previous = previews.get(runId);
    // 先删再放，让 Map 的顺序代表收到帧的先后。
    previews.delete(runId);
    previews.set(runId, URL.createObjectURL(image));
    previewBySignal.set(signal, previews);
    if (previous) URL.revokeObjectURL(previous);
    emit();
}

function dropPreviews(signal: AbortSignal, runId?: string) {
    const previews = previewBySignal.get(signal);
    if (!previews) return false;
    const urls = runId === undefined ? [...previews.values()] : [previews.get(runId)].filter((url): url is string => Boolean(url));
    if (runId === undefined) previews.clear();
    else previews.delete(runId);
    if (!previews.size) previewBySignal.delete(signal);
    urls.forEach((url) => URL.revokeObjectURL(url));
    return urls.length > 0;
}

/** 只清掉这一次工作流的进度，同一个 signal 下其他还在跑的工作流不受影响。 */
export function clearComfyProgress(signal: AbortSignal | undefined, runId: string) {
    if (!signal) return;
    const runs = progressBySignal.get(signal);
    const hadProgress = Boolean(runs?.delete(runId));
    if (runs && !runs.size) progressBySignal.delete(signal);
    if (dropPreviews(signal, runId) || hadProgress) emit();
}

/** 把一次生成请求绑到画布节点（或图片）上；请求结束或取消时解绑。 */
export function bindComfyProgressNode(signal: AbortSignal, key: string) {
    const keys = keysBySignal.get(signal);
    if (keys) return void keys.add(key);
    keysBySignal.set(signal, new Set([key]));
    signal.addEventListener("abort", () => unbindComfyProgress(signal), { once: true });
}

export function unbindComfyProgress(signal: AbortSignal) {
    const had = keysBySignal.delete(signal);
    const hadPreview = dropPreviews(signal);
    if (progressBySignal.delete(signal) || had || hadPreview) emit();
}

/** 为批量生成里的单张图派生一个 signal：跟随父 signal 取消，进度单独记在这张图上。用完调用 release。 */
export function childComfyProgressSignal(parent: AbortSignal, key: string) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
    bindComfyProgressNode(controller.signal, key);
    return {
        signal: controller.signal,
        release: () => {
            parent.removeEventListener("abort", abort);
            unbindComfyProgress(controller.signal);
        },
    };
}

/** 汇总绑在 key 上的进度：有正在执行的就显示它，否则显示排得最靠前的位置。 */
export function getComfyNodeProgress(key: string | undefined): ComfyProgress | undefined {
    if (!key) return undefined;
    let best: ComfyProgress | undefined;
    for (const [signal, keys] of keysBySignal) {
        if (!keys.has(key)) continue;
        for (const progress of progressBySignal.get(signal)?.values() || []) {
            if (progress.phase === "running") return progress;
            if (!best || (best.phase === "queued" && progress.position < best.position)) best = progress;
        }
    }
    return best;
}

/** 绑在 key 上的最新预览图；同一个 key 下有多张在跑时取最后收到帧的那一张。 */
export function getComfyNodePreview(key: string | undefined): string | undefined {
    if (!key) return undefined;
    let latest: string | undefined;
    for (const [signal, keys] of keysBySignal) {
        if (!keys.has(key)) continue;
        for (const url of previewBySignal.get(signal)?.values() || []) latest = url;
    }
    return latest;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 读取绑在节点（或图片）上的 ComfyUI 进度；按顺序取第一个有进度的 key。 */
export function useComfyNodeProgress(...keys: Array<string | undefined>) {
    useSyncExternalStore(subscribe, () => version);
    for (const key of keys) {
        const progress = getComfyNodeProgress(key);
        if (progress) return progress;
    }
    return undefined;
}

/** 读取绑在节点（或图片）上的最新预览图；按顺序取第一个有预览的 key。 */
export function useComfyNodePreview(...keys: Array<string | undefined>) {
    useSyncExternalStore(subscribe, () => version);
    for (const key of keys) {
        const preview = getComfyNodePreview(key);
        if (preview) return preview;
    }
    return undefined;
}
