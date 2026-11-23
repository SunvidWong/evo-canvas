import { cleanField, isHttpUrl } from "./claude-provider.js";
import type { CodexModel } from "./codex-protocol.js";

/** Codex Agent 使用的模型接口：不填时用本机 Codex 登录的官方账号；填了就走兼容 OpenAI Responses 接口的第三方服务或本地模型（Ollama、LM Studio、vLLM 等）。 */
export type CodexProviderConfig = { baseUrl?: string; apiKey?: string; model?: string };
/** 返回给网页的摘要：不含 Key 本身。 */
export type CodexProviderSummary = { baseUrl: string; model: string; hasKey: boolean; active: boolean };
/** 网页提交的修改：apiKey 为 undefined 时保留原值，空字符串表示清除。 */
export type CodexProviderPatch = { baseUrl?: unknown; apiKey?: unknown; model?: unknown };

const MAX_FIELD_LENGTH = 2000;
const MAX_MODEL_LENGTH = 200;
/** 写进 Codex 配置的提供方 id，以及传 Key 用的环境变量名；Key 只走环境变量，不出现在命令行参数里。 */
export const CODEX_PROVIDER_ID = "infinite_canvas";
export const CODEX_PROVIDER_KEY_ENV = "INFINITE_CANVAS_CODEX_API_KEY";

/** 只有地址和模型都填了才启用；只填一半时仍用官方账号。 */
export function codexProviderActive(provider: CodexProviderConfig | undefined): provider is Required<Pick<CodexProviderConfig, "baseUrl" | "model">> & CodexProviderConfig {
    return Boolean(provider?.baseUrl && provider?.model);
}

export function codexProviderSummary(provider: CodexProviderConfig | undefined): CodexProviderSummary {
    return { baseUrl: provider?.baseUrl || "", model: provider?.model || "", hasKey: Boolean(provider?.apiKey), active: codexProviderActive(provider) };
}

/** 校验并合并网页提交的设置；地址只接受 http(s)，所有字段限制长度、不允许换行。 */
export function mergeCodexProvider(current: CodexProviderConfig | undefined, patch: CodexProviderPatch): CodexProviderConfig {
    const next: CodexProviderConfig = { ...current };
    if (patch.baseUrl !== undefined) {
        const baseUrl = cleanField(patch.baseUrl, MAX_FIELD_LENGTH).replace(/\/+$/, "");
        if (baseUrl && !isHttpUrl(baseUrl)) throw new Error("接口地址必须是 http:// 或 https:// 开头的完整地址");
        next.baseUrl = baseUrl || undefined;
    }
    if (patch.apiKey !== undefined) next.apiKey = cleanField(patch.apiKey, MAX_FIELD_LENGTH) || undefined;
    if (patch.model !== undefined) next.model = cleanField(patch.model, MAX_MODEL_LENGTH) || undefined;
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value)) as CodexProviderConfig;
}

/** TOML 基本字符串：JSON 字符串的转义规则与之兼容（字段已禁止换行和控制字符）。 */
function tomlString(value: string) {
    return JSON.stringify(value);
}

/** 启动 app-server 时追加的 -c 覆盖参数：注册一个自定义提供方并设为默认。未启用时返回空数组。 */
export function codexProviderArgs(provider: CodexProviderConfig | undefined): string[] {
    if (!codexProviderActive(provider)) return [];
    const prefix = `model_providers.${CODEX_PROVIDER_ID}`;
    const settings = [
        `${prefix}.name=${tomlString("Infinite Canvas")}`,
        `${prefix}.base_url=${tomlString(provider.baseUrl)}`,
        `${prefix}.wire_api=${tomlString("responses")}`,
        ...(provider.apiKey ? [`${prefix}.env_key=${tomlString(CODEX_PROVIDER_KEY_ENV)}`] : []),
        `model_provider=${tomlString(CODEX_PROVIDER_ID)}`,
        `model=${tomlString(provider.model)}`,
    ];
    return settings.flatMap((setting) => ["-c", setting]);
}

/** app-server 子进程的环境变量：启用时带上 Key；未启用时返回 undefined，沿用默认继承。 */
export function codexProviderEnv(provider: CodexProviderConfig | undefined, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
    if (!codexProviderActive(provider)) return undefined;
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    if (provider.apiKey) env[CODEX_PROVIDER_KEY_ENV] = provider.apiKey;
    else delete env[CODEX_PROVIDER_KEY_ENV];
    return env;
}

/** 自定义提供方只有一个模型；按 model/list 的格式返回，网页的模型选择器可以直接显示。 */
export function codexProviderModels(provider: CodexProviderConfig | undefined): { data: CodexModel[]; nextCursor: null } | null {
    if (!codexProviderActive(provider)) return null;
    return { data: [{ id: provider.model, model: provider.model, displayName: provider.model, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: true }], nextCursor: null };
}
