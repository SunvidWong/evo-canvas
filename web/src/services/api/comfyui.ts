import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { clearComfyProgress, setComfyProgress, type ComfyProgress } from "@/lib/comfy-progress";
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

/** 画布能填进工作流的参数；image 按顺序对应第 1、2… 张参考图。 */
// 画布目前没有反向提示词输入，所以不提供映射；工作流里仍可写 {{negative_prompt}} 占位符（替换为空）。
export const COMFY_PARAMS = ["prompt", "width", "height", "count", "seed", "seconds", "image"] as const;
export type ComfyParam = (typeof COMFY_PARAMS)[number];
/** 工作流里一个节点参数，写成「节点 id.参数名」，例如 "6.text"。 */
export type ComfyInputRef = string;
/** 画布保存在工作流旁边的设置：参数映射和要取结果的输出节点。 */
export type ComfyCanvasSettings = { mapping?: Partial<Record<ComfyParam, ComfyInputRef[]>>; outputNodes?: string[] };
export type ComfyInputOption = { ref: ComfyInputRef; nodeId: string; input: string; classType: string; title?: string; value: string | number | boolean };
export type ComfyOutputNode = { nodeId: string; classType: string; title?: string; kind: "image" | "video" | "audio" };

/** 设置和工作流存在一起：{ "prompt": 工作流, "infinite_canvas": 设置 }。 */
const SETTINGS_KEY = "infinite_canvas";
/** 每个参数最多映射到几个节点参数；编辑器里同样限制，防止异常数据撑大配置。 */
export const COMFY_MAX_REFS_PER_PARAM = 16;
const OUTPUT_CLASS = /^(Save|Preview)|VideoCombine|SaveVideo|SaveWEBM|SaveAnimated|CreateVideo/i;
const AUDIO_OUTPUT_CLASS = /Audio/i;

function splitRef(ref: string): [string, string] | null {
    const index = ref.indexOf(".");
    return index > 0 && index < ref.length - 1 ? [ref.slice(0, index), ref.slice(index + 1)] : null;
}

function cleanRefs(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.filter((ref): ref is string => typeof ref === "string" && Boolean(splitRef(ref))))).slice(0, COMFY_MAX_REFS_PER_PARAM);
}

/** 读出工作流 JSON 里画布的设置；没有或格式不对时返回空对象。 */
export function parseComfySettings(text: string): ComfyCanvasSettings {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return {};
    }
    const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[SETTINGS_KEY] : undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const record = raw as { mapping?: unknown; outputNodes?: unknown };
    const mapping: Partial<Record<ComfyParam, ComfyInputRef[]>> = {};
    if (record.mapping && typeof record.mapping === "object" && !Array.isArray(record.mapping)) {
        for (const param of COMFY_PARAMS) {
            const refs = cleanRefs((record.mapping as Record<string, unknown>)[param]);
            if (refs.length) mapping[param] = refs;
        }
    }
    const outputNodes = Array.isArray(record.outputNodes) ? Array.from(new Set(record.outputNodes.filter((id): id is string => typeof id === "string" && Boolean(id)))) : [];
    return { ...(Object.keys(mapping).length ? { mapping } : {}), ...(outputNodes.length ? { outputNodes } : {}) };
}

/** 把工作流和设置合成要保存的 JSON；没有设置时只保存工作流本身。 */
export function serializeComfyWorkflow(workflow: ComfyWorkflow, settings: ComfyCanvasSettings) {
    const mapping = Object.fromEntries(Object.entries(settings.mapping || {}).filter(([, refs]) => refs?.length));
    const outputNodes = (settings.outputNodes || []).filter((id) => workflow[id]);
    const clean = { ...(Object.keys(mapping).length ? { mapping } : {}), ...(outputNodes.length ? { outputNodes } : {}) };
    return JSON.stringify(Object.keys(clean).length ? { prompt: workflow, [SETTINGS_KEY]: clean } : workflow, null, 2);
}

/** 列出可以映射的节点参数：只列直接填值的参数，连线的输入不能填。 */
export function listComfyInputs(workflow: ComfyWorkflow): ComfyInputOption[] {
    return Object.entries(workflow).flatMap(([nodeId, node]) =>
        Object.entries(node.inputs || {}).flatMap(([input, value]) =>
            typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [{ ref: `${nodeId}.${input}`, nodeId, input, classType: node.class_type || "", title: node._meta?.title, value }] : [],
        ),
    );
}

/** 列出会产出文件的节点，用来选择从哪些节点取结果。 */
export function listComfyOutputNodes(workflow: ComfyWorkflow): ComfyOutputNode[] {
    return Object.entries(workflow).flatMap(([nodeId, node]) => {
        const classType = node.class_type || "";
        if (!OUTPUT_CLASS.test(classType)) return [];
        const kind = AUDIO_OUTPUT_CLASS.test(classType) ? ("audio" as const) : VIDEO_OUTPUT_NODE.test(classType) ? ("video" as const) : ("image" as const);
        return [{ nodeId, classType, title: node._meta?.title, kind }];
    });
}

/** 工作流里已经用占位符接管的参数。 */
export function comfyPlaceholderParams(workflow: ComfyWorkflow): ComfyParam[] {
    const keys = new Set(Array.from(JSON.stringify(workflow).matchAll(PLACEHOLDER), (match) => match[1]));
    return COMFY_PARAMS.filter((param) => (param === "count" ? keys.has("count") || keys.has("batch_size") : param === "image" ? [...keys].some((key) => /^image\d*$/.test(key)) : keys.has(param)));
}

/** 没写占位符也没手动映射时，自动识别出来的节点参数。 */
export function autoComfyInputs(workflow: ComfyWorkflow): Partial<Record<ComfyParam, ComfyInputRef[]>> {
    const idOf = (target: ComfyWorkflow[string] | undefined) => Object.keys(workflow).find((id) => workflow[id] === target);
    const prompt = idOf(positivePromptNode(workflow));
    const result: Partial<Record<ComfyParam, ComfyInputRef[]>> = { prompt: prompt ? [`${prompt}.text`] : [], width: [], height: [], count: [], seed: [], image: [] };
    for (const [id, node] of Object.entries(workflow)) {
        const inputs = node.inputs || {};
        if (LATENT_CLASS.test(node.class_type || "")) {
            if (typeof inputs.width === "number") result.width?.push(`${id}.width`);
            if (typeof inputs.height === "number") result.height?.push(`${id}.height`);
            if (typeof inputs.batch_size === "number") result.count?.push(`${id}.batch_size`);
        }
        if (typeof inputs.seed === "number") result.seed?.push(`${id}.seed`);
        if (typeof inputs.noise_seed === "number") result.seed?.push(`${id}.noise_seed`);
        if (node.class_type === "LoadImage" && node.inputs) result.image?.push(`${id}.image`);
    }
    return result;
}

function setInput(workflow: ComfyWorkflow, ref: ComfyInputRef, value: unknown) {
    const parts = splitRef(ref);
    const inputs = parts ? workflow[parts[0]]?.inputs : undefined;
    if (!parts || !inputs || !(parts[1] in inputs) || Array.isArray(inputs[parts[1]])) return;
    inputs[parts[1]] = value;
}

/**
 * 把画布的提示词、尺寸、张数、参考图填进工作流，优先级：占位符 > 手动映射 > 自动识别。
 * 占位符：{{prompt}}、{{negative_prompt}}、{{width}}、{{height}}、{{count}}、{{seed}}、{{seconds}}、{{image}}、{{image2}}…
 * 自动识别：采样器正向提示词节点、Empty*Latent* 的宽高和张数、LoadImage 的图片，并为采样器换一个随机种子。
 * 映射到的参数不存在或是连线输入时跳过，不会改动工作流结构。
 */
export function buildComfyWorkflow(workflow: ComfyWorkflow, vars: ComfyVariables, settings: ComfyCanvasSettings = {}): ComfyWorkflow {
    const seed = vars.seed ?? Math.floor(Math.random() * MAX_SEED);
    const values = variableMap({ ...vars, seed });
    const used = new Set<string>();
    const result = replacePlaceholders(structuredClone(workflow), values, used) as ComfyWorkflow;
    const placeholders = new Set(COMFY_PARAMS.filter((param) => (param === "count" ? used.has("count") || used.has("batch_size") : param === "image" ? [...used].some((key) => /^image\d*$/.test(key)) : used.has(param))));
    const auto = autoComfyInputs(result);
    for (const param of COMFY_PARAMS) {
        if (placeholders.has(param)) continue;
        const mapped = settings.mapping?.[param];
        const manual = Boolean(mapped?.length);
        const refs = manual ? mapped || [] : auto[param] || [];
        if (param === "image") {
            refs.forEach((ref, index) => vars.images?.[index] && setInput(result, ref, vars.images[index]));
            continue;
        }
        // 自动识别的种子每个采样器各换一个，手动映射的种子用同一个值。
        if (param === "seed") {
            refs.forEach((ref) => setInput(result, ref, manual || vars.seed !== undefined ? seed : Math.floor(Math.random() * MAX_SEED)));
            continue;
        }
        const value = { prompt: vars.prompt, width: vars.width, height: vars.height, count: vars.count, seconds: vars.seconds }[param];
        if (value === undefined || value === "" || (param !== "prompt" && !value)) continue;
        refs.forEach((ref) => setInput(result, ref, value));
    }
    return result;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a)$/i;

/** 从 /history 的 outputs 里收集生成的文件；有正式输出时忽略预览用的临时文件。 */
export function collectComfyOutputs(outputs: Record<string, Record<string, unknown>> = {}, outputNodes: string[] = []): ComfyOutputFile[] {
    // 选了输出节点时只取这些节点的结果；它们都没产出时退回全部输出，避免节点改名后直接失败。
    if (outputNodes.length) {
        const chosen = collectComfyOutputs(Object.fromEntries(Object.entries(outputs).filter(([id]) => outputNodes.includes(id))));
        if (chosen.length) return chosen;
    }
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

type ComfyQueue = { queue_running?: unknown[][]; queue_pending?: unknown[][] };

/** 在 /queue 里找到任务：正在执行返回 0，排队中返回前面还有几个任务 + 1，找不到返回 undefined。 */
export function comfyQueuePosition(queue: ComfyQueue | undefined, promptId: string) {
    if (queue?.queue_running?.some((item) => Array.isArray(item) && item[1] === promptId)) return 0;
    const pending = (queue?.queue_pending || []).filter((item) => Array.isArray(item)).sort((a, b) => Number(a[0]) - Number(b[0]));
    const index = pending.findIndex((item) => item[1] === promptId);
    return index >= 0 ? index + 1 : undefined;
}

/** 把 ComfyUI 的 http 地址换成 /ws 的 WebSocket 地址；相对地址（例如 /comfyui）按当前站点补全。 */
export function comfySocketUrl(config: Pick<AiConfig, "baseUrl">, clientId: string) {
    const raw = comfyUrl(config, `/ws?clientId=${encodeURIComponent(clientId)}`);
    try {
        const url = new URL(raw, typeof location === "undefined" ? undefined : location.href);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    } catch {
        return "";
    }
}

/** 订阅 ComfyUI 的执行进度；连不上（例如需要鉴权或代理不支持 WebSocket）时静默退回轮询。 */
function watchComfySocket(config: Pick<AiConfig, "baseUrl" | "apiKey">, clientId: string, workflow: ComfyWorkflow, getPromptId: () => string | undefined, onProgress: (progress: ComfyProgress) => void) {
    const url = typeof WebSocket === "undefined" ? "" : comfySocketUrl(config, clientId);
    if (!url) return () => undefined;
    let socket: WebSocket;
    try {
        socket = new WebSocket(url);
    } catch {
        return () => undefined;
    }
    const nodeName = (id: unknown) => (typeof id === "string" && workflow[id] ? workflow[id]._meta?.title || workflow[id].class_type || id : undefined);
    let node: string | undefined;
    socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let message: { type?: string; data?: { prompt_id?: string; node?: unknown; value?: unknown; max?: unknown } };
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        const data = message.data || {};
        if (data.prompt_id && data.prompt_id !== getPromptId()) return;
        if (message.type === "execution_start") onProgress({ phase: "running" });
        if (message.type === "executing" && data.node) {
            node = nodeName(data.node);
            onProgress({ phase: "running", node });
        }
        if (message.type === "progress" && typeof data.value === "number" && typeof data.max === "number" && data.max > 0) onProgress({ phase: "running", value: data.value, max: data.max, node: nodeName(data.node) || node });
    };
    socket.onerror = () => undefined;
    return () => {
        socket.onmessage = null;
        try {
            socket.close();
        } catch {
            // 已经关闭。
        }
    };
}

/** 取消任务：还在排队就从队列删掉；已经在执行就中断它，避免 ComfyUI 继续占着显卡。 */
async function cancelComfyPrompt(config: Pick<AiConfig, "baseUrl" | "apiKey">, promptId: string) {
    const post = (path: string, body: unknown) => fetch(comfyUrl(config, path), { method: "POST", headers: comfyHeaders(config, "application/json"), body: JSON.stringify(body) });
    try {
        const queue = await comfyFetch<ComfyQueue>(config, "/queue");
        const position = comfyQueuePosition(queue, promptId);
        if (position === 0) await post("/interrupt", { prompt_id: promptId });
        else if (position !== undefined) await post("/queue", { delete: [promptId] });
    } catch {
        // 取消是尽力而为，失败时不影响画布这边的取消。
    }
}

/** 提交工作流并等待完成，返回生成的文件列表。排队和执行进度通过 onProgress 回报；取消时会删掉排队中的任务或中断正在执行的任务。 */
export async function runComfyWorkflow(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflow: ComfyWorkflow, options?: RequestOptions & { outputNodes?: string[]; onProgress?: (progress: ComfyProgress) => void }) {
    const clientId = `infinite-canvas-${nanoid(8)}`;
    let promptId: string | undefined;
    let running = false;
    const report = (progress: ComfyProgress) => {
        if (progress.phase === "running") running = true;
        else if (running) return;
        options?.onProgress?.(progress);
        setComfyProgress(options?.signal, clientId, progress);
    };
    const stopSocket = watchComfySocket(config, clientId, workflow, () => promptId, report);
    try {
        const queued = await comfyFetch<{ prompt_id?: string; error?: unknown; node_errors?: Record<string, unknown> }>(config, "/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
            signal: options?.signal,
        });
        promptId = queued?.prompt_id;
        if (!promptId) throw new Error(comfyErrorMessage(queued) || apiText("requestFailed"));
        try {
            for (;;) {
                // 开始执行前顺便查一下排队位置；查询失败不影响等待结果。
                if (!running) {
                    const queue = await comfyFetch<ComfyQueue>(config, "/queue", { signal: options?.signal }).catch((error) => {
                        if (error instanceof DOMException && error.name === "AbortError") throw error;
                        return undefined;
                    });
                    const position = comfyQueuePosition(queue, promptId);
                    if (position === 0) report({ phase: "running" });
                    else if (position !== undefined) report({ phase: "queued", position });
                }
                await delay(POLL_INTERVAL_MS, options?.signal);
                const history = await comfyFetch<ComfyHistory>(config, `/history/${encodeURIComponent(promptId)}`, { signal: options?.signal });
                const entry = history?.[promptId];
                if (!entry) continue;
                if (entry.status?.status_str === "error") {
                    const failure = entry.status.messages?.find(([type]) => type === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;
                    throw new Error(failure ? `${failure.node_type || "ComfyUI"}: ${failure.exception_message || ""}`.trim() : apiText("requestFailed"));
                }
                if (entry.status?.completed === false) continue;
                const files = collectComfyOutputs(entry.outputs, options?.outputNodes);
                if (!files.length) throw new Error(apiText("comfyNoOutput"));
                return files;
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") void cancelComfyPrompt(config, promptId);
            throw error;
        }
    } finally {
        stopSocket();
        clearComfyProgress(options?.signal, clientId);
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
    const settings = parseComfySettings(workflowText);
    const images = await Promise.all((vars.references || []).map((dataUrl) => uploadComfyImage(config, dataUrl, options)));
    const files = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }, settings), { ...options, outputNodes: settings.outputNodes })).filter((file) => file.kind === "image");
    if (!files.length) throw new Error(apiText("comfyNoOutput"));
    return Promise.all(files.map(async (file) => readFileAsDataUrl(await comfyImageFile(config, file, options))));
}

/** 用工作流生成视频，返回第一个视频文件。 */
export async function generateComfyVideo(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[] }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const settings = parseComfySettings(workflowText);
    const images = await Promise.all((vars.references || []).map((dataUrl) => uploadComfyImage(config, dataUrl, options)));
    const file = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }, settings), { ...options, outputNodes: settings.outputNodes })).find((item) => item.kind === "video");
    if (!file) throw new Error(apiText("comfyNoOutput"));
    return fetchComfyFile(config, file, options);
}

/** 测试 ComfyUI 是否可连通。 */
export async function checkComfyConnection(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    await comfyFetch<unknown>(config, "/system_stats");
}

export type ComfyHistoryWorkflow = {
    id: string;
    /** 开始执行的时间（毫秒），ComfyUI 没给时为空。 */
    time?: number;
    workflow: ComfyWorkflow;
    capability: "image" | "video";
    /** 用于列表展示：模型文件名，没有时用采样器节点名。 */
    summary: string;
    /** 工作流用到的模型文件名。 */
    models: string[];
    nodeCount: number;
};

/** 从历史记录里导入时最多取最近几次运行。 */
export const COMFY_HISTORY_IMPORT_LIMIT = 20;
/** 没有输出记录时，只按真正写出视频文件的节点判断。 */
const VIDEO_OUTPUT_NODE = /VideoCombine|SaveVideo|SaveWEBM|SaveAnimated|CreateVideo/i;
const MODEL_INPUTS = ["ckpt_name", "unet_name", "model_name", "lora_name"];

function isWorkflowRecord(value: unknown): value is ComfyWorkflow {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const nodes = Object.values(value as Record<string, unknown>);
    return nodes.length > 0 && nodes.every((node) => Boolean(node) && typeof node === "object" && typeof (node as { class_type?: unknown }).class_type === "string");
}

/** 把 /history 的返回整理成可导入的工作流列表：每条记录的 prompt[2] 就是 API 格式工作流，最新的在前。 */
export function parseComfyHistoryWorkflows(history: unknown): ComfyHistoryWorkflow[] {
    if (!history || typeof history !== "object" || Array.isArray(history)) return [];
    const items = Object.entries(history as Record<string, { prompt?: unknown[]; status?: ComfyHistory[string]["status"]; outputs?: Record<string, Record<string, unknown>> }>).flatMap(([id, entry]) => {
        const prompt = Array.isArray(entry?.prompt) ? entry.prompt : [];
        const workflow = prompt[2];
        if (!isWorkflowRecord(workflow)) return [];
        const nodes = Object.values(workflow);
        const outputs = collectComfyOutputs(entry.outputs);
        // 优先看实际产出的文件类型；没有输出记录时才看输出节点。
        const video = outputs.length ? outputs.some((file) => file.kind === "video") : nodes.some((node) => VIDEO_OUTPUT_NODE.test(node.class_type || ""));
        const models = nodes.flatMap((node) => MODEL_INPUTS.map((key) => node.inputs?.[key]).filter((value): value is string => typeof value === "string" && Boolean(value)));
        const sampler = nodes.find((node) => SAMPLER_CLASS.test(node.class_type || ""))?.class_type;
        const start = entry.status?.messages?.find(([type]) => type === "execution_start")?.[1]?.timestamp;
        return [
            {
                id,
                order: typeof prompt[0] === "number" ? prompt[0] : -1,
                time: typeof start === "number" ? start : undefined,
                workflow,
                capability: video ? ("video" as const) : ("image" as const),
                summary: Array.from(new Set(models)).join(", ") || sampler || "",
                models: Array.from(new Set(models)),
                nodeCount: nodes.length,
            },
        ];
    });
    return items.sort((a, b) => b.order - a.order || (b.time || 0) - (a.time || 0)).map(({ order: _order, ...item }) => item);
}

/** 读取 ComfyUI 最近运行过的工作流，用来直接导入，免去手动「导出（API）」。 */
export async function fetchComfyHistoryWorkflows(config: Pick<AiConfig, "baseUrl" | "apiKey">, maxItems = COMFY_HISTORY_IMPORT_LIMIT) {
    return parseComfyHistoryWorkflows(await comfyFetch<unknown>(config, `/history?max_items=${maxItems}`));
}
