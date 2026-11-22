import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";

/** ComfyUI API 格式工作流：节点 id → { class_type, inputs }。 */
export type ComfyWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
export type ComfyVariables = {
    prompt: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    count?: number;
    seed?: number;
    /** 已上传到 ComfyUI 的参考图文件名，按顺序填入。 */
    images?: string[];
    seconds?: number;
};
export type ComfyOutputFile = { filename: string; subfolder?: string; type?: string; kind: "image" | "video" | "audio" };
type RequestOptions = { signal?: AbortSignal };
type ComfyHistory = Record<string, { status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> }; outputs?: Record<string, Record<string, unknown>> }>;

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
/** 等待 ComfyUI 出图时每次查询的间隔。 */
const POLL_INTERVAL_MS = 1000;
const MAX_SEED = 2 ** 32 - 1;
const LATENT_CLASS = /^Empty.*Latent/i;
const PROMPT_CLASS = /^CLIPTextEncode/i;
const SAMPLER_CLASS = /Sampler/i;
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

function comfyUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    return withLocalProxy(`${config.baseUrl.trim().replace(/\/+$/, "")}${path}`);
}

function comfyHeaders(config: Pick<AiConfig, "apiKey">, contentType?: string) {
    return {
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

/** 解析工作流 JSON；只接受 ComfyUI「导出（API）」格式。 */
export function parseComfyWorkflow(text: string): ComfyWorkflow {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error(apiText("comfyWorkflowInvalid"));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(apiText("comfyWorkflowInvalid"));
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.nodes) && Array.isArray(record.links)) throw new Error(apiText("comfyWorkflowNotApi"));
    const workflow = (record.prompt && typeof record.prompt === "object" && !Array.isArray(record.prompt) ? record.prompt : record) as ComfyWorkflow;
    const nodes = Object.values(workflow);
    if (!nodes.length || nodes.some((node) => !node || typeof node !== "object" || typeof node.class_type !== "string")) throw new Error(apiText("comfyWorkflowInvalid"));
    return workflow;
}

function variableMap(vars: ComfyVariables): Record<string, unknown> {
    const images = vars.images || [];
    return {
        prompt: vars.prompt,
        negative_prompt: vars.negativePrompt || "",
        width: vars.width,
        height: vars.height,
        count: vars.count,
        batch_size: vars.count,
        seed: vars.seed,
        seconds: vars.seconds,
        image: images[0],
        ...Object.fromEntries(images.map((name, index) => [`image${index + 1}`, name])),
    };
}

function replacePlaceholders(value: unknown, values: Record<string, unknown>, used: Set<string>): unknown {
    if (typeof value === "string") {
        const exact = value.match(/^\{\{\s*(\w+)\s*\}\}$/);
        if (exact && exact[1] in values) {
            used.add(exact[1]);
            return values[exact[1]] ?? "";
        }
        return value.replace(PLACEHOLDER, (match, key: string) => {
            if (!(key in values)) return match;
            used.add(key);
            return String(values[key] ?? "");
        });
    }
    if (Array.isArray(value)) return value.map((item) => replacePlaceholders(item, values, used));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, values, used)]));
    return value;
}

/** 找出采样器 positive 输入直接连着的提示词节点；找不到时退回第一个 CLIPTextEncode。 */
function positivePromptNode(workflow: ComfyWorkflow) {
    for (const node of Object.values(workflow)) {
        const positive = SAMPLER_CLASS.test(node.class_type || "") ? node.inputs?.positive : undefined;
        if (Array.isArray(positive) && typeof positive[0] === "string") {
            const target = workflow[positive[0]];
            if (target && typeof target.inputs?.text === "string") return target;
        }
    }
    return Object.values(workflow).find((node) => PROMPT_CLASS.test(node.class_type || "") && typeof node.inputs?.text === "string");
}

/**
 * 把画布的提示词、尺寸、张数、参考图填进工作流。
 * 优先替换 {{prompt}}、{{negative_prompt}}、{{width}}、{{height}}、{{count}}、{{seed}}、{{image}}、{{image2}}… 占位符；
 * 没写占位符时自动填：正向提示词节点、Empty*Latent* 的宽高和张数、LoadImage 的图片，并为采样器换一个随机种子。
 */
export function buildComfyWorkflow(workflow: ComfyWorkflow, vars: ComfyVariables): ComfyWorkflow {
    const values = variableMap({ ...vars, seed: vars.seed ?? Math.floor(Math.random() * MAX_SEED) });
    const used = new Set<string>();
    const result = replacePlaceholders(structuredClone(workflow), values, used) as ComfyWorkflow;
    if (!used.has("prompt")) {
        const node = positivePromptNode(result);
        if (node?.inputs) node.inputs.text = vars.prompt;
    }
    const nodes = Object.values(result);
    for (const node of nodes) {
        const inputs = node.inputs;
        if (!inputs) continue;
        if (LATENT_CLASS.test(node.class_type || "")) {
            if (!used.has("width") && vars.width && typeof inputs.width === "number") inputs.width = vars.width;
            if (!used.has("height") && vars.height && typeof inputs.height === "number") inputs.height = vars.height;
            if (!used.has("count") && !used.has("batch_size") && vars.count && typeof inputs.batch_size === "number") inputs.batch_size = vars.count;
        }
        if (!used.has("seed")) {
            if (typeof inputs.seed === "number") inputs.seed = Math.floor(Math.random() * MAX_SEED);
            if (typeof inputs.noise_seed === "number") inputs.noise_seed = Math.floor(Math.random() * MAX_SEED);
        }
    }
    if (![...used].some((key) => key.startsWith("image")) && vars.images?.length) {
        nodes.filter((node) => node.class_type === "LoadImage" && node.inputs).forEach((node, index) => {
            const name = vars.images?.[index];
            if (name && node.inputs) node.inputs.image = name;
        });
    }
    return result;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i;

/** 从 /history 的 outputs 里收集生成的文件；有正式输出时忽略预览用的临时文件。 */
export function collectComfyOutputs(outputs: Record<string, Record<string, unknown>> = {}): ComfyOutputFile[] {
    const files: ComfyOutputFile[] = [];
    for (const output of Object.values(outputs)) {
        for (const [key, list] of Object.entries(output || {})) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                if (!item || typeof item !== "object" || typeof (item as { filename?: unknown }).filename !== "string") continue;
                const file = item as { filename: string; subfolder?: string; type?: string; format?: string };
                const kind = key === "audio" || AUDIO_EXT.test(file.filename) ? "audio" : key === "gifs" || key === "videos" || key === "video" || VIDEO_EXT.test(file.filename) || file.format?.startsWith("video/") ? "video" : "image";
                files.push({ filename: file.filename, subfolder: file.subfolder, type: file.type, kind });
            }
        }
    }
    const saved = files.filter((file) => file.type !== "temp");
    return saved.length ? saved : files;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

async function comfyFetch<T>(config: Pick<AiConfig, "baseUrl" | "apiKey">, path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(comfyUrl(config, path), { ...init, headers: { ...comfyHeaders(config), ...(init.headers || {}) } });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(apiText("comfyUnreachable"));
    }
    const text = await response.text();
    let payload: unknown = undefined;
    try {
        payload = text ? JSON.parse(text) : undefined;
    } catch {
        payload = undefined;
    }
    if (!response.ok) throw new Error(comfyErrorMessage(payload) || text.slice(0, 300) || apiText("httpFailed", { status: response.status }));
    return payload as T;
}

function comfyErrorMessage(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as { error?: { message?: string; details?: string } | string; node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }>; class_type?: string }> };
    const nodeErrors = Object.entries(record.node_errors || {}).flatMap(([id, item]) => (item.errors || []).map((error) => `#${id} ${item.class_type || ""}: ${error.message || ""}${error.details ? ` (${error.details})` : ""}`.trim()));
    const main = typeof record.error === "string" ? record.error : [record.error?.message, record.error?.details].filter(Boolean).join(": ");
    return [main, ...nodeErrors].filter(Boolean).join("\n");
}

/** 把参考图上传到 ComfyUI 的 input 目录，返回工作流里 LoadImage 可用的文件名。 */
export async function uploadComfyImage(config: Pick<AiConfig, "baseUrl" | "apiKey">, dataUrl: string, options?: RequestOptions) {
    const file = dataUrlToFile({ id: nanoid(), name: "reference", type: "", dataUrl });
    const form = new FormData();
    form.append("image", file, `canvas-${nanoid(8)}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`);
    form.append("overwrite", "true");
    const result = await comfyFetch<{ name?: string; subfolder?: string }>(config, "/upload/image", { method: "POST", body: form, signal: options?.signal });
    if (!result?.name) throw new Error(apiText("requestFailed"));
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

/** 提交工作流并等待完成，返回生成的文件列表；取消节点生成会中止等待。 */
export async function runComfyWorkflow(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflow: ComfyWorkflow, options?: RequestOptions) {
    const queued = await comfyFetch<{ prompt_id?: string; error?: unknown; node_errors?: Record<string, unknown> }>(config, "/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: `infinite-canvas-${nanoid(8)}` }),
        signal: options?.signal,
    });
    const promptId = queued?.prompt_id;
    if (!promptId) throw new Error(comfyErrorMessage(queued) || apiText("requestFailed"));
    try {
        for (;;) {
            await delay(POLL_INTERVAL_MS, options?.signal);
            const history = await comfyFetch<ComfyHistory>(config, `/history/${encodeURIComponent(promptId)}`, { signal: options?.signal });
            const entry = history?.[promptId];
            if (!entry) continue;
            if (entry.status?.status_str === "error") {
                const failure = entry.status.messages?.find(([type]) => type === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
                throw new Error(failure ? `${failure.node_type || "ComfyUI"}: ${failure.exception_message || ""}`.trim() : apiText("requestFailed"));
            }
            if (entry.status?.completed === false) continue;
            const files = collectComfyOutputs(entry.outputs);
            if (!files.length) throw new Error(apiText("comfyNoOutput"));
            return files;
        }
    } catch (error) {
        // 取消时顺手让 ComfyUI 删掉排队中的任务，正在跑的任务交给 ComfyUI 自己的中断按钮。
        if (error instanceof DOMException && error.name === "AbortError") {
            void fetch(comfyUrl(config, "/queue"), { method: "POST", headers: comfyHeaders(config, "application/json"), body: JSON.stringify({ delete: [promptId] }) }).catch(() => undefined);
        }
        throw error;
    }
}

export async function fetchComfyFile(config: Pick<AiConfig, "baseUrl" | "apiKey">, file: ComfyOutputFile, options?: RequestOptions) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
    const response = await fetch(comfyUrl(config, `/view?${query}`), { headers: comfyHeaders(config), signal: options?.signal });
    if (!response.ok) throw new Error(apiText("httpFailed", { status: response.status }));
    return response.blob();
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** 下载输出图片；ComfyUI 没给 Content-Type 时按扩展名补上，避免生成的 data URL 类型不对。 */
async function comfyImageFile(config: Pick<AiConfig, "baseUrl" | "apiKey">, file: ComfyOutputFile, options?: RequestOptions) {
    const blob = await fetchComfyFile(config, file, options);
    const type = blob.type.startsWith("image/") ? blob.type : IMAGE_TYPES[file.filename.split(".").pop()?.toLowerCase() || ""] || "image/png";
    return new File([blob], file.filename, { type });
}

/** 用工作流生成图片，返回 data URL 列表。 */
export async function generateComfyImages(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[] }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const images = await Promise.all((vars.references || []).map((dataUrl) => uploadComfyImage(config, dataUrl, options)));
    const files = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }), options)).filter((file) => file.kind === "image");
    if (!files.length) throw new Error(apiText("comfyNoOutput"));
    return Promise.all(files.map(async (file) => readFileAsDataUrl(await comfyImageFile(config, file, options))));
}

/** 用工作流生成视频，返回第一个视频文件。 */
export async function generateComfyVideo(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[] }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const images = await Promise.all((vars.references || []).map((dataUrl) => uploadComfyImage(config, dataUrl, options)));
    const file = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }), options)).find((item) => item.kind === "video");
    if (!file) throw new Error(apiText("comfyNoOutput"));
    return fetchComfyFile(config, file, options);
}

/** 测试 ComfyUI 是否可连通。 */
export async function checkComfyConnection(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    await comfyFetch<unknown>(config, "/system_stats");
}
