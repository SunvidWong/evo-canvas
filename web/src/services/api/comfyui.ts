import { message } from "antd";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { clearComfyProgress, setComfyProgress, type ComfyProgress } from "@/lib/comfy-progress";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";

import { ComfySubgraphError, convertComfyUiWorkflow, isComfyUiWorkflow, type ComfyObjectInfo } from "./comfyui-convert";

/** ComfyUI API 格式工作流：节点 id → { class_type, inputs }。 */
export type ComfyWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
export type ComfyVariables = {
    prompt: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    count?: number;
    seed?: number;
    /** 单次覆盖采样步数和 CFG；不填就用工作流里的值。 */
    steps?: number;
    cfg?: number;
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
/** 执行中每隔几次轮询查一次队列（/queue 会带上所有排队任务的工作流，体积不小）。 */
const RUNNING_QUEUE_CHECK_EVERY = 5;
/** 队列和历史里连续这么多次都找不到任务，就当任务已被删除。 */
const COMFY_LOST_CHECKS = 3;
const MAX_SEED = 2 ** 32 - 1;
const LATENT_CLASS = /^Empty.*Latent/i;
/** 放大、修复类节点也带 seed，但不是出图的采样种子，自动识别时跳过（例如 SeedVR2 放大器）。 */
const NON_SAMPLER_SEED_CLASS = /upscal|seedvr/i;

function isLinkValue(value: unknown) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}
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
/** seedMode：random（默认）每次换种子；fixed 保留工作流里写的种子，方便复现同一张图。 */
export type ComfyCanvasSettings = { mapping?: Partial<Record<ComfyParam, ComfyInputRef[]>>; outputNodes?: string[]; seedMode?: "random" | "fixed" };
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
    const record = raw as { mapping?: unknown; outputNodes?: unknown; seedMode?: unknown };
    const mapping: Partial<Record<ComfyParam, ComfyInputRef[]>> = {};
    if (record.mapping && typeof record.mapping === "object" && !Array.isArray(record.mapping)) {
        for (const param of COMFY_PARAMS) {
            const refs = cleanRefs((record.mapping as Record<string, unknown>)[param]);
            if (refs.length) mapping[param] = refs;
        }
    }
    const outputNodes = Array.isArray(record.outputNodes) ? Array.from(new Set(record.outputNodes.filter((id): id is string => typeof id === "string" && Boolean(id)))) : [];
    return { ...(Object.keys(mapping).length ? { mapping } : {}), ...(outputNodes.length ? { outputNodes } : {}), ...(record.seedMode === "fixed" ? { seedMode: "fixed" as const } : {}) };
}

/** 把工作流和设置合成要保存的 JSON；没有设置时只保存工作流本身。 */
export function serializeComfyWorkflow(workflow: ComfyWorkflow, settings: ComfyCanvasSettings) {
    const mapping = Object.fromEntries(Object.entries(settings.mapping || {}).filter(([, refs]) => refs?.length));
    const outputNodes = (settings.outputNodes || []).filter((id) => workflow[id]);
    const clean = { ...(Object.keys(mapping).length ? { mapping } : {}), ...(outputNodes.length ? { outputNodes } : {}), ...(settings.seedMode === "fixed" ? { seedMode: "fixed" } : {}) };
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

/** 画布没有对应输入、但常需要调的数值参数：采样器的步数、CFG、重绘幅度，视频的帧数和帧率。 */
const TUNABLE_INPUTS = ["steps", "cfg", "denoise", "guidance", "length", "frames", "num_frames", "video_frames", "fps", "frame_rate", "strength_model", "strength_clip"];

/** 从 ComfyUI 候选列表里选值的参数：模型文件、LoRA、采样器和调度器。 */
const CHOICE_INPUT = /^(ckpt_name|unet_name|vae_name|clip_name\d*|lora_name|control_net_name|model_name|sampler_name|scheduler)$/;

/** 列出可以用下拉框切换的参数（模型文件、LoRA、采样器等，只列直接填值的），按节点顺序。 */
export function listComfyChoiceInputs(workflow: ComfyWorkflow): ComfyInputOption[] {
    return listComfyInputs(workflow).filter((item) => typeof item.value === "string" && CHOICE_INPUT.test(item.input));
}

/**
 * 从 /object_info 读出某个节点参数的候选值。兼容两种写法：
 * 旧版 [["a.safetensors", …], {…}]，新版 ["COMBO", { options: [...] }]。拿不到时返回 undefined。
 */
export function comfyInputChoices(objectInfo: ComfyObjectInfo | null | undefined, classType: string, input: string): string[] | undefined {
    const definition = objectInfo?.[classType]?.input;
    const spec = definition?.required?.[input] || definition?.optional?.[input];
    if (!spec) return undefined;
    const [type, options] = spec as [unknown, Record<string, unknown>?];
    const list = Array.isArray(type) ? type : type === "COMBO" && Array.isArray(options?.options) ? options.options : undefined;
    return list?.filter((item): item is string => typeof item === "string");
}

/** 列出可在编辑器里直接改的数值参数（只列直接填数字的，连线输入不列），按节点顺序。 */
export function listComfyTunableInputs(workflow: ComfyWorkflow): ComfyInputOption[] {
    return listComfyInputs(workflow).filter((item) => typeof item.value === "number" && TUNABLE_INPUTS.includes(item.input));
}

/** 返回改了一个节点参数后的新工作流；参数不存在或是连线输入时原样返回。 */
export function setComfyInputValue(workflow: ComfyWorkflow, ref: ComfyInputRef, value: string | number | boolean): ComfyWorkflow {
    const result = structuredClone(workflow);
    setInput(result, ref, value);
    return result;
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
            // 宽高连到分辨率选择节点（例如 TTResolutionSelector）时也算：画布指定了尺寸就直接填数字替换连线。
            if (typeof inputs.width === "number" || isLinkValue(inputs.width)) result.width?.push(`${id}.width`);
            if (typeof inputs.height === "number" || isLinkValue(inputs.height)) result.height?.push(`${id}.height`);
            if (typeof inputs.batch_size === "number") result.count?.push(`${id}.batch_size`);
        }
        if (!NON_SAMPLER_SEED_CLASS.test(node.class_type || "")) {
            if (typeof inputs.seed === "number") result.seed?.push(`${id}.seed`);
            if (typeof inputs.noise_seed === "number") result.seed?.push(`${id}.noise_seed`);
        }
        if (node.class_type === "LoadImage" && node.inputs) result.image?.push(`${id}.image`);
    }
    return result;
}

function setInput(workflow: ComfyWorkflow, ref: ComfyInputRef, value: unknown, replaceLink = false) {
    const parts = splitRef(ref);
    const inputs = parts ? workflow[parts[0]]?.inputs : undefined;
    if (!parts || !inputs || !(parts[1] in inputs) || (Array.isArray(inputs[parts[1]]) && !replaceLink)) return;
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
            if (settings.seedMode === "fixed" && vars.seed === undefined) continue;
            refs.forEach((ref) => setInput(result, ref, manual || vars.seed !== undefined ? seed : Math.floor(Math.random() * MAX_SEED)));
            continue;
        }
        const value = { prompt: vars.prompt, width: vars.width, height: vars.height, count: vars.count, seconds: vars.seconds }[param];
        if (value === undefined || value === "" || (param !== "prompt" && !value)) continue;
        // 只有自动识别出的 Empty*Latent 宽高可以替换连线；手动映射只能选直接填值的参数。
        refs.forEach((ref) => setInput(result, ref, value, !manual && (param === "width" || param === "height")));
    }
    applySamplerOverrides(result, vars);
    return result;
}

/** ComfyUI 单次覆盖的上下限：步数 1–COMFY_MAX_STEPS 的整数，CFG 0–COMFY_MAX_CFG，种子 0–COMFY_MAX_SEED 的整数。
 * 随机种子仍在 0–2^32-1 里取；能填、能记录的种子放宽到 JS 能精确表示的最大整数，工作流里自带的大种子（例如 156680208700286）也能复用。 */
export const COMFY_MAX_STEPS = 1000;
export const COMFY_MAX_CFG = 100;
export const COMFY_MAX_SEED = Number.MAX_SAFE_INTEGER;
export const COMFY_RANDOM_SEED_MAX = MAX_SEED;

/** 把设置里填的步数、CFG、种子（字符串）转成数字；空的、不是数字或超出范围的当作没填。 */
export function parseComfyOverrides(values: { comfySteps?: string; comfyCfg?: string; comfySeed?: string }) {
    const read = (raw: string | undefined, min: number, max: number, integer: boolean) => {
        if (raw === undefined || raw.trim() === "") return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return undefined;
        return value;
    };
    const result: { steps?: number; cfg?: number; seed?: number } = {};
    const steps = read(values.comfySteps, 1, COMFY_MAX_STEPS, true);
    const cfg = read(values.comfyCfg, 0, COMFY_MAX_CFG, false);
    const seed = read(values.comfySeed, 0, COMFY_MAX_SEED, true);
    if (steps !== undefined) result.steps = steps;
    if (cfg !== undefined) result.cfg = cfg;
    if (seed !== undefined) result.seed = seed;
    return result;
}

/** 一次生成多张时每张图单独跑一次工作流；填了固定种子就依次加 1，免得几张图一模一样。 */
export function comfySeedForImage(seed: string | undefined, index: number) {
    const value = parseComfyOverrides({ comfySeed: seed }).seed;
    return value === undefined || !index ? seed : String(value + index > COMFY_MAX_SEED ? value + index - COMFY_MAX_SEED - 1 : value + index);
}

/** 单次覆盖步数和 CFG：改所有采样类节点里直接填数值的 steps、cfg（放大、修复类节点除外）。 */
function applySamplerOverrides(workflow: ComfyWorkflow, overrides: { steps?: number; cfg?: number }) {
    for (const node of Object.values(workflow)) {
        if (!node?.inputs || NON_SAMPLER_SEED_CLASS.test(node.class_type || "")) continue;
        for (const key of ["steps", "cfg"] as const) {
            const value = overrides[key];
            if (value !== undefined && Number.isFinite(value) && typeof node.inputs[key] === "number") node.inputs[key] = value;
        }
    }
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

async function comfyFetch<T>(config: Pick<AiConfig, "baseUrl" | "apiKey">, path: string, init: RequestInit = {}, workflow?: ComfyWorkflow): Promise<T> {
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
    if (!response.ok) throw new Error(comfyErrorMessage(payload, workflow) || text.slice(0, 300) || apiText("httpFailed", { status: response.status }));
    return payload as T;
}

type ComfyNodeError = { type?: string; message?: string; details?: string; extra_info?: { input_name?: string; received_value?: unknown } };

/** 错误里显示的节点名：优先用工作流里的标题，其次节点类型，最后节点 id。 */
function comfyNodeLabel(id: string | undefined, classType: string | undefined, workflow?: ComfyWorkflow) {
    const node = id ? workflow?.[id] : undefined;
    const name = node?._meta?.title || classType || node?.class_type || "";
    return id ? (name ? apiText("comfyNodeLabel", { name, id }) : `#${id}`) : name || "ComfyUI";
}

const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i;
const MISSING_NODE = /node\s+(\S+?)\s+does not exist/i;

/** 把 ComfyUI 校验错误翻成用户能看懂的原因，原文附在后面方便排查。 */
function comfyNodeErrorReason(error: ComfyNodeError) {
    const input = error.extra_info?.input_name || error.details?.match(/^(\w+)/)?.[1] || "";
    const received = error.extra_info?.received_value ?? error.details?.match(/'([^']*)'\s+not in/)?.[1];
    const raw = [error.message, error.details].filter(Boolean).join(": ");
    if (error.type === "value_not_in_list") {
        const value = String(received ?? "");
        return value && MODEL_FILE.test(value) ? apiText("comfyMissingModel", { file: value, input }) : apiText("comfyValueNotInList", { value, input });
    }
    if (error.type === "required_input_missing") return apiText("comfyInputMissing", { input });
    if (error.type === "value_bigger_than_max" || error.type === "value_smaller_than_min") return apiText("comfyValueOutOfRange", { input, detail: raw });
    return raw || error.type || "";
}

/** 整理 /prompt 返回的错误：总体原因 + 每个出错节点一行「节点名：原因」。 */
export function comfyErrorMessage(payload: unknown, workflow?: ComfyWorkflow) {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as { error?: ComfyNodeError | string; node_errors?: Record<string, { errors?: ComfyNodeError[]; class_type?: string }> };
    const nodeErrors = Object.entries(record.node_errors || {}).flatMap(([id, item]) => (item.errors || []).map((error) => apiText("comfyNodeError", { node: comfyNodeLabel(id, item.class_type, workflow), reason: comfyNodeErrorReason(error) })));
    const error = typeof record.error === "string" ? { message: record.error } : record.error;
    const missingNode = [error?.message, error?.details].join(" ").match(MISSING_NODE)?.[1];
    const main = missingNode
        ? apiText("comfyMissingNodeType", { node: missingNode.replace(/^#/, "") })
        : error?.type === "prompt_outputs_failed_validation"
          ? apiText("comfyValidationFailed")
          : error?.type === "prompt_no_outputs"
            ? apiText("comfyNoOutputNode")
            : [error?.message, error?.details].filter(Boolean).join(": ");
    return [main, ...nodeErrors].filter(Boolean).join("\n");
}

const OUT_OF_MEMORY = /out of memory|OutOfMemory|Allocation on device/i;

/** 整理执行失败的 execution_error：哪个节点出错、原因；显存不足时给出处理建议。 */
export function comfyExecutionErrorMessage(failure: { node_id?: string; node_type?: string; exception_type?: string; exception_message?: string } | undefined, workflow?: ComfyWorkflow) {
    if (!failure) return apiText("requestFailed");
    const label = comfyNodeLabel(failure.node_id, failure.node_type, workflow);
    const detail = (failure.exception_message || failure.exception_type || "").trim();
    if (OUT_OF_MEMORY.test(`${failure.exception_type || ""} ${detail}`)) return apiText("comfyOutOfMemory", { node: label });
    return apiText("comfyExecutionFailed", { node: label, detail: detail.slice(0, 500) });
}

/** 参考图上传到 ComfyUI input 目录下的这个子目录。 */
export const COMFY_UPLOAD_SUBFOLDER = "infinite-canvas";

/** 把参考图上传到 ComfyUI 的 input 目录，返回工作流里 LoadImage 可用的文件名。 */
export async function uploadComfyImage(config: Pick<AiConfig, "baseUrl" | "apiKey">, dataUrl: string, options?: RequestOptions) {
    const file = dataUrlToFile({ id: nanoid(), name: "reference", type: "", dataUrl });
    const form = new FormData();
    form.append("image", file, `canvas-${nanoid(8)}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`);
    // 放进单独的子目录，避免和用户自己放在 input 里的图片重名。
    form.append("subfolder", COMFY_UPLOAD_SUBFOLDER);
    form.append("type", "input");
    form.append("overwrite", "true");
    const result = await comfyFetch<{ name?: string; subfolder?: string }>(config, "/upload/image", { method: "POST", body: form, signal: options?.signal });
    if (!result?.name) throw new Error(apiText("requestFailed"));
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

/**
 * 给已上传的图片加蒙版：ComfyUI 把蒙版的透明度写进原图的 alpha 通道，另存为新文件，LoadImage 的 MASK 输出就是涂抹区域。
 * imagePath 是 uploadComfyImage 返回的「子目录/文件名」。返回带蒙版的新文件路径。
 */
export async function uploadComfyMask(config: Pick<AiConfig, "baseUrl" | "apiKey">, imagePath: string, maskDataUrl: string, options?: RequestOptions) {
    const slash = imagePath.lastIndexOf("/");
    const subfolder = slash >= 0 ? imagePath.slice(0, slash) : "";
    const filename = slash >= 0 ? imagePath.slice(slash + 1) : imagePath;
    const file = dataUrlToFile({ id: nanoid(), name: "mask", type: "", dataUrl: maskDataUrl });
    const form = new FormData();
    form.append("image", file, `${filename.replace(/\.[^.]+$/, "")}-mask.png`);
    form.append("original_ref", JSON.stringify({ filename, subfolder, type: "input" }));
    form.append("subfolder", subfolder);
    form.append("type", "input");
    form.append("overwrite", "true");
    const result = await comfyFetch<{ name?: string; subfolder?: string }>(config, "/upload/mask", { method: "POST", body: form, signal: options?.signal });
    if (!result?.name) throw new Error(apiText("requestFailed"));
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

type ComfyQueue = { queue_running?: unknown[]; queue_pending?: unknown[] };

/** 队列里的一项：旧版是 [序号, prompt_id, ...]，也兼容写成 { number, prompt_id } 的对象。 */
function queueEntry(item: unknown): { number: number; id: unknown } | null {
    if (Array.isArray(item)) return { number: Number(item[0]), id: item[1] };
    if (item && typeof item === "object") {
        const record = item as { number?: unknown; prompt_id?: unknown; id?: unknown };
        return { number: Number(record.number), id: record.prompt_id ?? record.id };
    }
    return null;
}

/** 队列里的条目都认得出来时才能断定「任务不在队列里」；格式认不出来时不下这个结论。 */
export function comfyQueueReadable(queue: ComfyQueue | undefined) {
    const lists = [queue?.queue_running, queue?.queue_pending];
    return lists.every((list) => Array.isArray(list) && list.every((item) => typeof queueEntry(item)?.id === "string"));
}

/** 在 /queue 里找到任务：正在执行返回 0，排队中返回前面还有几个任务 + 1，找不到返回 undefined。 */
export function comfyQueuePosition(queue: ComfyQueue | undefined, promptId: string) {
    const entries = (list: unknown) => (Array.isArray(list) ? list.map(queueEntry).filter((item): item is { number: number; id: unknown } => Boolean(item)) : []);
    if (entries(queue?.queue_running).some((item) => item.id === promptId)) return 0;
    const pending = entries(queue?.queue_pending).sort((a, b) => (Number.isFinite(a.number) && Number.isFinite(b.number) ? a.number - b.number : 0));
    const index = pending.findIndex((item) => item.id === promptId);
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
    const clientId = `${COMFY_CLIENT_PREFIX}${nanoid(8)}`;
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
        }, workflow);
        promptId = queued?.prompt_id;
        if (!promptId) throw new Error(comfyErrorMessage(queued, workflow) || apiText("requestFailed"));
        try {
            /** 队列和历史里都连续找不到这个任务的次数：任务被别处删掉或 ComfyUI 重启过，不再干等。 */
            let missing = 0;
            for (let poll = 0; ; poll += 1) {
                // 开始执行前每次都查排队位置；执行中隔几次查一下，确认任务还在。查询失败不影响等待结果。
                const queue = !running || poll % RUNNING_QUEUE_CHECK_EVERY === 0
                    ? await comfyFetch<ComfyQueue>(config, "/queue", { signal: options?.signal }).catch((error) => {
                          if (error instanceof DOMException && error.name === "AbortError") throw error;
                          return undefined;
                      })
                    : undefined;
                const position = comfyQueuePosition(queue, promptId);
                const lost = Boolean(queue) && position === undefined && comfyQueueReadable(queue);
                if (!running) {
                    if (position !== undefined && position > 0) report({ phase: "queued", position });
                    // 正在执行，或者队列格式认不出来：至少显示「执行中」，不让节点一直只有转圈。
                    else if (queue && !lost) report({ phase: "running" });
                }
                await delay(POLL_INTERVAL_MS, options?.signal);
                const history = await comfyFetch<ComfyHistory>(config, `/history/${encodeURIComponent(promptId)}`, { signal: options?.signal });
                const entry = history?.[promptId];
                if (!entry) {
                    if (queue) missing = lost ? missing + 1 : 0;
                    if (missing >= COMFY_LOST_CHECKS) throw new Error(apiText("comfyPromptLost"));
                    continue;
                }
                if (entry.status?.status_str === "error") {
                    const failure = entry.status.messages?.find(([type]) => type === "execution_error")?.[1] as Parameters<typeof comfyExecutionErrorMessage>[0];
                    throw new Error(comfyExecutionErrorMessage(failure, workflow));
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

/** 工作流能接收几张参考图：写了 {{image}}、{{image2}}… 时按最大序号算，否则按映射或自动识别的 LoadImage 个数。 */
export function comfyImageSlots(workflow: ComfyWorkflow, settings: ComfyCanvasSettings = {}) {
    const indexes = Array.from(JSON.stringify(workflow).matchAll(PLACEHOLDER), (match) => match[1].match(/^image(\d*)$/)?.[1]).filter((value): value is string => value !== undefined);
    if (indexes.length) return Math.max(...indexes.map((value) => Number(value || 1)));
    return (settings.mapping?.image?.length ? settings.mapping.image : autoComfyInputs(workflow).image || []).length;
}

/** 同一条提示在这段时间内只弹一次：一次生成多张图时每张图各跑一次工作流，不重复提示。 */
const WARNING_DEDUPE_MS = 5000;
const recentWarnings = new Map<string, number>();

/** 生成不中断，只在页面上提示一下；没有页面（例如测试环境）时跳过。 */
function notifyWarning(text: string) {
    if (typeof document === "undefined") return;
    const now = Date.now();
    if (now - (recentWarnings.get(text) ?? -Infinity) < WARNING_DEDUPE_MS) return;
    recentWarnings.set(text, now);
    void message.warning({ content: text, key: `comfy-warning:${text}` });
}

/** 只上传工作流用得上的参考图；多出来的不上传，并提示只用了前几张。 */
async function uploadComfyReferences(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflow: ComfyWorkflow, settings: ComfyCanvasSettings, references: string[] = [], options?: RequestOptions, mask?: string) {
    if (!references.length) return [];
    const slots = comfyImageSlots(workflow, settings);
    if (references.length > slots) notifyWarning(slots ? apiText("comfyExtraReferences", { used: slots, total: references.length }) : apiText("comfyNoReferenceInput", { total: references.length }));
    const paths = await Promise.all(references.slice(0, slots).map((dataUrl) => uploadComfyImage(config, dataUrl, options)));
    // 局部重绘：蒙版加到第一张参考图（原图）上。
    if (mask && paths[0]) paths[0] = await uploadComfyMask(config, paths[0], mask, options);
    return paths;
}

/** 用工作流生成图片，返回 data URL 列表。 */
export async function generateComfyImages(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[]; mask?: string }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const settings = parseComfySettings(workflowText);
    const images = await uploadComfyReferences(config, workflow, settings, vars.references, options, vars.mask);
    const built = buildComfyWorkflow(workflow, { ...vars, images }, settings);
    const files = (await runComfyWorkflow(config, built, { ...options, outputNodes: settings.outputNodes })).filter((file) => file.kind === "image");
    if (!files.length) throw new Error(apiText("comfyNoOutput"));
    return { images: await Promise.all(files.map(async (file) => readFileAsDataUrl(await comfyImageFile(config, file, options)))), seed: comfyWorkflowSeed(built, settings) };
}

/** 实际提交的工作流里用的种子（手动映射的，没映射就取自动识别的采样器）。只有所有种子都是同一个值时才返回：
 * 「用这个种子」会把同一个值填进所有种子，几个采样器种子不同时填回去就复现不了，这时返回 undefined。 */
export function comfyWorkflowSeed(workflow: ComfyWorkflow, settings: ComfyCanvasSettings = {}) {
    const refs = settings.mapping?.seed?.length ? settings.mapping.seed : autoComfyInputs(workflow).seed || [];
    const values = new Set<number>();
    for (const ref of refs) {
        const [nodeId, input] = splitRef(ref) || [];
        const value = nodeId && input ? workflow[nodeId]?.inputs?.[input] : undefined;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
        values.add(value);
    }
    return values.size === 1 ? [...values][0] : undefined;
}

/** 用工作流生成视频，返回第一个视频文件。 */
export async function generateComfyVideo(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[] }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const settings = parseComfySettings(workflowText);
    const images = await uploadComfyReferences(config, workflow, settings, vars.references, options);
    const file = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }, settings), { ...options, outputNodes: settings.outputNodes })).find((item) => item.kind === "video");
    if (!file) throw new Error(apiText("comfyNoOutput"));
    return fetchComfyFile(config, file, options);
}

const AUDIO_TYPES: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/ogg" };

/** 用工作流生成音频（SaveAudio 等节点），返回第一个音频文件。 */
export async function generateComfyAudio(config: Pick<AiConfig, "baseUrl" | "apiKey">, workflowText: string, vars: Omit<ComfyVariables, "images"> & { references?: string[] }, options?: RequestOptions) {
    const workflow = parseComfyWorkflow(workflowText);
    const settings = parseComfySettings(workflowText);
    const images = await uploadComfyReferences(config, workflow, settings, vars.references, options);
    const file = (await runComfyWorkflow(config, buildComfyWorkflow(workflow, { ...vars, images }, settings), { ...options, outputNodes: settings.outputNodes })).find((item) => item.kind === "audio");
    if (!file) throw new Error(apiText("comfyNoOutput"));
    const blob = await fetchComfyFile(config, file, options);
    // ComfyUI 没给音频类型时按扩展名补上，方便画布播放和保存。
    return blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: AUDIO_TYPES[file.filename.split(".").pop()?.toLowerCase() || ""] || "audio/flac" });
}

/** 测试 ComfyUI 是否可连通；顺便读一下队列，读不到不影响结果。 */
export async function checkComfyConnection(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    const summary = summarizeComfyStats(await comfyFetch<unknown>(config, "/system_stats"));
    const queue = await comfyFetch<ComfyQueue>(config, "/queue").catch(() => undefined);
    return queue ? { ...summary, queue: summarizeComfyQueue(queue) } : summary;
}

export type ComfyQueueSummary = { running: number; pending: number; mine: number };
export type ComfySystemSummary = { version?: string; devices: Array<{ name: string; vramTotalGb?: number; vramFreeGb?: number }>; queue?: ComfyQueueSummary };

/** 本站提交的任务都用这个前缀做 client_id，用来区分队列里哪些是自己的。 */
export const COMFY_CLIENT_PREFIX = "infinite-canvas-";

/** 队列里排队中的任务里，本站提交的那些的 prompt_id。旧版条目是 [序号, prompt_id, prompt, extra_data, ...]。 */
export function ownPendingComfyPrompts(queue: ComfyQueue | undefined): string[] {
    return (Array.isArray(queue?.queue_pending) ? queue.queue_pending : []).flatMap((item) => {
        const [id, extra] = Array.isArray(item) ? [item[1], item[3]] : item && typeof item === "object" ? [(item as { prompt_id?: unknown }).prompt_id, (item as { extra_data?: unknown }).extra_data] : [undefined, undefined];
        const clientId = extra && typeof extra === "object" ? (extra as { client_id?: unknown }).client_id : undefined;
        return typeof id === "string" && typeof clientId === "string" && clientId.startsWith(COMFY_CLIENT_PREFIX) ? [id] : [];
    });
}

export function summarizeComfyQueue(queue: ComfyQueue | undefined): ComfyQueueSummary {
    const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
    return { running: count(queue?.queue_running), pending: count(queue?.queue_pending), mine: ownPendingComfyPrompts(queue).length };
}

/** 让 ComfyUI 卸载已加载的模型并释放显存（POST /free），下一次生成会重新加载模型。 */
export async function freeComfyMemory(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    await comfyFetch<unknown>(config, "/free", { method: "POST", headers: comfyHeaders(config, "application/json"), body: JSON.stringify({ unload_models: true, free_memory: true }) });
}

/** 删除本站提交、还在排队的任务，不动别人的任务和正在执行的任务；返回删除的个数。 */
export async function clearOwnComfyQueue(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    const ids = ownPendingComfyPrompts(await comfyFetch<ComfyQueue>(config, "/queue"));
    if (ids.length) await comfyFetch<unknown>(config, "/queue", { method: "POST", headers: comfyHeaders(config, "application/json"), body: JSON.stringify({ delete: ids }) });
    return ids.length;
}
const GB = 1024 ** 3;

/** 整理 /system_stats：ComfyUI 版本和每块显卡的名称、显存，用于「测试连接」里展示。 */
export function summarizeComfyStats(stats: unknown): ComfySystemSummary {
    const record = (stats && typeof stats === "object" ? stats : {}) as { system?: { comfyui_version?: unknown }; devices?: unknown };
    const version = typeof record.system?.comfyui_version === "string" ? record.system.comfyui_version : undefined;
    const devices = (Array.isArray(record.devices) ? record.devices : []).flatMap((device) => {
        if (!device || typeof device !== "object") return [];
        const item = device as { name?: unknown; type?: unknown; vram_total?: unknown; vram_free?: unknown };
        // 原始名称形如「cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync」，只保留显卡型号。
        const name = String(item.name || item.type || "")
            .replace(/^\w+:\d+\s+/, "")
            .replace(/\s+:\s+.*$/, "")
            .trim();
        if (!name) return [];
        const gb = (value: unknown) => (typeof value === "number" && value > 0 ? Math.round((value / GB) * 10) / 10 : undefined);
        return [{ name, vramTotalGb: gb(item.vram_total), vramFreeGb: gb(item.vram_free) }];
    });
    return { version, devices };
}

export type ComfyHistoryWorkflow = {
    id: string;
    /** 开始执行的时间（毫秒），ComfyUI 没给时为空。 */
    time?: number;
    workflow: ComfyWorkflow;
    capability: "image" | "video" | "audio";
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
        const audio = !video && (outputs.length ? outputs.some((file) => file.kind === "audio") && !outputs.some((file) => file.kind === "image") : nodes.some((node) => /SaveAudio/i.test(node.class_type || "")));
        const models = nodes.flatMap((node) => MODEL_INPUTS.map((key) => node.inputs?.[key]).filter((value): value is string => typeof value === "string" && Boolean(value)));
        const sampler = nodes.find((node) => SAMPLER_CLASS.test(node.class_type || ""))?.class_type;
        const start = entry.status?.messages?.find(([type]) => type === "execution_start")?.[1]?.timestamp;
        return [
            {
                id,
                order: typeof prompt[0] === "number" ? prompt[0] : -1,
                time: typeof start === "number" ? start : undefined,
                workflow,
                capability: video ? ("video" as const) : audio ? ("audio" as const) : ("image" as const),
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

/** 读取 ComfyUI 的节点定义，用来把普通保存格式转成 API 格式，以及检查缺少的节点。 */
export async function fetchComfyObjectInfo(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    const info = await comfyFetch<ComfyObjectInfo>(config, "/object_info");
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(apiText("requestFailed"));
    return info;
}

/** 列出 ComfyUI 用户目录里保存的工作流文件（相对 workflows 目录的路径）。 */
export async function fetchComfySavedWorkflows(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    const files = await comfyFetch<unknown>(config, "/api/userdata?dir=workflows&recurse=true&split=false");
    if (!Array.isArray(files)) return [];
    return files
        .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : ""))
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .sort((a, b) => a.localeCompare(b));
}

/** 读取一个保存的工作流文件，返回原始 JSON 对象。 */
export async function fetchComfySavedWorkflow(config: Pick<AiConfig, "baseUrl" | "apiKey">, file: string) {
    return comfyFetch<unknown>(config, `/api/userdata/${encodeURIComponent(`workflows/${file}`)}`);
}

/**
 * 把任意格式的工作流整理成 API 格式：普通保存格式用节点定义转换，API 格式原样返回；
 * 两种情况都检查 ComfyUI 是否装了用到的节点，缺少时报错并列出名称。
 */
export function toComfyApiWorkflow(value: unknown, objectInfo: ComfyObjectInfo): ComfyWorkflow {
    let workflow: ComfyWorkflow;
    if (isComfyUiWorkflow(value)) {
        let missing: string[];
        try {
            ({ workflow, missing } = convertComfyUiWorkflow(value, objectInfo));
        } catch (error) {
            if (error instanceof ComfySubgraphError) throw new Error(apiText("comfyWorkflowSubgraph"));
            throw error;
        }
        if (missing.length) throw new Error(apiText("comfyWorkflowMissingNodes", { nodes: missing.join("、") }));
        if (!Object.keys(workflow).length) throw new Error(apiText("comfyWorkflowInvalid"));
        return workflow;
    }
    workflow = parseComfyWorkflow(JSON.stringify(value));
    const missing = Array.from(new Set(Object.values(workflow).map((node) => node.class_type || "").filter((type) => type && !objectInfo[type])));
    if (missing.length) throw new Error(apiText("comfyWorkflowMissingNodes", { nodes: missing.join("、") }));
    return workflow;
}

/** 复制工作流时生成不重名的名称：「名称 副本」「名称 副本 2」… */
export function comfyCopyName(name: string, existing: string[], suffix: string): string {
    const taken = new Set(existing);
    const base = `${name} ${suffix}`;
    if (!taken.has(base)) return base;
    for (let index = 2; ; index++) if (!taken.has(`${base} ${index}`)) return `${base} ${index}`;
}

/** 导出单个工作流用的文件名：去掉文件系统不允许的字符。 */
export function comfyWorkflowFileName(name: string): string {
    return `${name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "workflow"}.json`;
}
