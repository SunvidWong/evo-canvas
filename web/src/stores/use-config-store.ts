import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";

/**
 * 渠道协议：
 * - openai：OpenAI 官方接口（文本走 /v1/responses）
 * - openai-chat：OpenAI 兼容接口（文本走 /chat/completions，适合 DeepSeek、通义、Kimi、Ollama 等）
 * - anthropic：Anthropic Messages 接口（Claude，只支持文本）
 * - gemini：Google Gemini 接口
 * - comfyui：ComfyUI 工作流（每个模型对应一份 API 格式工作流）
 */
export type ApiCallFormat = "openai" | "openai-chat" | "anthropic" | "gemini" | "comfyui";
export const API_CALL_FORMATS: ApiCallFormat[] = ["openai", "openai-chat", "anthropic", "gemini", "comfyui"];
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
    /** ComfyUI 渠道的 API 格式工作流 JSON。 */
    workflow?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    /** 文本回复长度上限（token）。不填时：Anthropic 用 8192，其他协议不传，由服务端决定。 */
    maxTokens?: number;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** 当前请求所用渠道的回复长度上限，由 resolveModelRequestConfig 带上。 */
    maxTokens?: number;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    autoFocusOnSelect: boolean;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const COMFYUI_BASE_URL = "http://127.0.0.1:8188";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-5.5", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-5.5",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: ["default::gpt-image-2", "default::grok-imagine-video", "default::gpt-5.5", "default::gpt-4o-mini-tts"],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
    nodeRegenerateBehavior: "new-node",
    autoFocusOnSelect: false,
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};


export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
/** 名字里明确写了用途的，优先按用途判断（例如 wan2.1-t2i 是生图，kling-image 是生图，jimeng-video 是视频）。 */
const EXPLICIT_VIDEO = /video|t2v|i2v|v2v/;
const EXPLICIT_IMAGE = /t2i|i2i|image/;
const VIDEO_BRANDS = /sora|veo|kling|\bwan(?!x)|hailuo|seedance|vidu|pixverse|cogvideo|ltx-?v|mochi|runway|gen-?3|luma|pika/;
const AUDIO_BRANDS = /audio|tts|speech|voice|music|sound|cosyvoice|suno|sambert|elevenlabs/;
const IMAGE_BRANDS = /seedream|seededit|dall-?e|imagen|flux|sdxl|sd3|stable-diffusion|midjourney|cogview|kolors|jimeng|wanx|ideogram|recraft|kontext|hidream/;

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (EXPLICIT_VIDEO.test(value)) return "video";
    if (EXPLICIT_IMAGE.test(value)) return "image";
    if (VIDEO_BRANDS.test(value)) return "video";
    if (AUDIO_BRANDS.test(value)) return "audio";
    if (IMAGE_BRANDS.test(value)) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    for (const model of [currentModel, defaultModel]) {
        if (!model) continue;
        const configuredCapability = modelCapabilityOf(config, model);
        // Keep unavailable selections visible so the readiness check blocks the
        // request. Only a known capability switch may choose another model.
        if (!configuredCapability || configuredCapability === capability) return model;
    }
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

/** ComfyUI 渠道里模型对应的工作流 JSON；不是 ComfyUI 模型时返回空字符串。 */
export function resolveModelWorkflow(config: AiConfig, value: string) {
    const match = findChannelModel(config, value);
    return match?.channel.apiFormat === "comfyui" ? match.model.workflow?.trim() || "" : "";
}

/** 本机或局域网地址（Ollama、LM Studio、vLLM、ComfyUI 等本地服务），通常不需要 API Key。 */
export function isLocalBaseUrl(baseUrl: string) {
    let hostname = "";
    try {
        hostname = new URL(baseUrl.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
        return false;
    }
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "::1") return true;
    const parts = hostname.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** 渠道是否必须填写 API Key：ComfyUI 和本机/局域网地址可以不填。 */
export function channelNeedsApiKey(channel: Pick<ModelChannel, "baseUrl" | "apiFormat">) {
    return channel.apiFormat !== "comfyui" && !isLocalBaseUrl(channel.baseUrl);
}

/** 渠道的地址和（需要时的）API Key 是否都已填写。 */
export function hasChannelCredentials(channel: Pick<ModelChannel, "baseUrl" | "apiFormat" | "apiKey">) {
    return Boolean(channel.baseUrl.trim()) && (Boolean(channel.apiKey.trim()) || !channelNeedsApiKey(channel));
}

function isAiConfigReady(config: AiConfig, model: string) {
    const match = findChannelModel(config, model);
    return Boolean(match && hasChannelCredentials(match.channel));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) set({ config: result.config });
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                if (!Array.isArray(persistedConfig.channels)) config.channels = [];
                const channels = normalizeChannels(config);
                const models = modelOptionsFromChannels(channels);
                return {
                    ...current,
                    webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                    config: {
                        ...config,
                        channelMode: "local",
                        apiFormat: normalizeApiFormat(config.apiFormat),
                        channels,
                        models,
                        imageModel: normalizeModelOptionValue(config.imageModel || config.model, channels),
                        videoModel: normalizeModelOptionValue(config.videoModel, channels),
                        textModel: normalizeModelOptionValue(config.textModel || config.model, channels),
                        audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, channels),
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        reasoningEffort: config.reasoningEffort || "auto",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        videoMode: config.videoMode === "reference" ? "reference" : "frames",
                        canvasImageCount: config.canvasImageCount || "3",
                        proxyEnabled: Boolean(config.proxyEnabled),
                        proxyUrl: config.proxyUrl || DEFAULT_LOCAL_PROXY_URL,
                        nodeRegenerateBehavior: config.nodeRegenerateBehavior === "overwrite" ? "overwrite" : "new-node",
                        autoFocusOnSelect: Boolean(config.autoFocusOnSelect),
                    },
                };
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        const workflow = typeof item === "string" ? undefined : item.workflow?.trim() || undefined;
        result.push({ name, capability, script, ...(workflow ? { workflow } : {}) });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
        ...(normalizeMaxTokens(channel?.maxTokens) ? { maxTokens: normalizeMaxTokens(channel?.maxTokens) } : {}),
    };
}

/** 回复长度上限只接受正整数，其余视为未设置。 */
export function normalizeMaxTokens(value: unknown) {
    const number = typeof value === "string" ? Number(value.trim()) : value;
    return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        return stripTrailingApiVersion(normalizeImportedBaseUrl(baseUrl));
    } catch {
        return stripTrailingApiVersion(baseUrl.trim().replace(/\/+$/, ""));
    }
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function stripTrailingApiVersion(baseUrl: string) {
    return baseUrl.replace(/\/v1$/i, "");
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
        maxTokens: channel.maxTokens,
    };
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) =>
        createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            models: normalizeChannelModels(channel.models),
        }),
    );
    if (!channels.length) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

/** 协议在界面上的名称。 */
export function apiFormatName(apiFormat: ApiCallFormat) {
    return i18n.t(`config.channelEditor.protocols.${apiFormat}`);
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    if (apiFormat === "anthropic") return ANTHROPIC_BASE_URL;
    if (apiFormat === "comfyui") return COMFYUI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return API_CALL_FORMATS.includes(apiFormat as ApiCallFormat) ? (apiFormat as ApiCallFormat) : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    // 已经带版本号的地址（如 /v1、智谱 /api/paas/v4、火山方舟 /api/v3）不再追加 /v1。
    const apiBaseUrl = /\/v\d+$/.test(lowerBaseUrl) ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return withLocalProxy(`${apiBaseUrl}${path}`);
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS. */
export function withLocalProxy(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    if (!proxyEnabled || !/^https?:\/\//i.test(url)) return url;
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base || url.startsWith(`${base}/`)) return url;
    return `${base}/${url}`;
}
