/** Claude Agent 使用的模型接口：不填时用本机 Claude 登录的官方账号；填了就把请求转到兼容 Anthropic 接口的第三方服务或本地网关。 */
export type ClaudeProviderConfig = { baseUrl?: string; authToken?: string; model?: string };
/** 返回给网页的摘要：不含 Token 本身，只告诉网页是否已经设置。 */
export type ClaudeProviderSummary = { baseUrl: string; model: string; hasToken: boolean };
/** 网页提交的修改：authToken 为 undefined 时保留原值，空字符串表示清除。 */
export type ClaudeProviderPatch = { baseUrl?: unknown; authToken?: unknown; model?: unknown };

const MAX_FIELD_LENGTH = 2000;
const MAX_MODEL_LENGTH = 200;

export function claudeProviderSummary(provider: ClaudeProviderConfig | undefined): ClaudeProviderSummary {
    return { baseUrl: provider?.baseUrl || "", model: provider?.model || "", hasToken: Boolean(provider?.authToken) };
}

/** 校验并合并网页提交的设置；地址只接受 http(s)，所有字段都限制长度、不允许换行。 */
export function mergeClaudeProvider(current: ClaudeProviderConfig | undefined, patch: ClaudeProviderPatch): ClaudeProviderConfig {
    const next: ClaudeProviderConfig = { ...current };
    if (patch.baseUrl !== undefined) {
        const baseUrl = cleanField(patch.baseUrl, MAX_FIELD_LENGTH).replace(/\/+$/, "");
        if (baseUrl && !isHttpUrl(baseUrl)) throw new Error("接口地址必须是 http:// 或 https:// 开头的完整地址");
        next.baseUrl = baseUrl || undefined;
    }
    if (patch.authToken !== undefined) next.authToken = cleanField(patch.authToken, MAX_FIELD_LENGTH) || undefined;
    if (patch.model !== undefined) next.model = cleanField(patch.model, MAX_MODEL_LENGTH) || undefined;
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value)) as ClaudeProviderConfig;
}

const CLOUD_PROVIDER_SELECTORS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** 生成 Claude Code 子进程的环境变量；没有任何自定义设置时返回 undefined，沿用默认继承。 */
export function claudeProviderEnv(provider: ClaudeProviderConfig | undefined, baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> | undefined {
    if (!provider?.baseUrl && !provider?.authToken && !provider?.model) return undefined;
    const env: Record<string, string | undefined> = { ...baseEnv };
    if (provider.baseUrl) {
        env.ANTHROPIC_BASE_URL = provider.baseUrl;
        // 换成第三方地址时，绝不能把本机官方账号的凭据（API Key、登录令牌）发过去：
        // 去掉环境里的官方凭据，并总是给出自定义 Token，避免 Claude Code 回退到钥匙串里的登录令牌。
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        // 继承来的自定义请求头可能带着原来的凭据（例如 x-api-key），也不能发给新地址。
        delete env.ANTHROPIC_CUSTOM_HEADERS;
        // 环境里选了 Bedrock、Vertex 或 Foundry 时，Claude Code 会忽略 ANTHROPIC_BASE_URL，这里改回直连自定义地址。
        for (const key of CLOUD_PROVIDER_SELECTORS) delete env[key];
        env.ANTHROPIC_AUTH_TOKEN = provider.authToken || "none";
    } else if (provider.authToken) {
        env.ANTHROPIC_AUTH_TOKEN = provider.authToken;
        // 同时存在时 Claude Code 会优先用 API Key 或登录令牌，自定义 Token 就不生效了。
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (provider.model) {
        env.ANTHROPIC_MODEL = provider.model;
        // 第三方服务通常没有 Claude 的小模型，后台的辅助调用也用同一个模型。
        env.ANTHROPIC_SMALL_FAST_MODEL = provider.model;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.model;
    }
    return env;
}

function cleanField(value: unknown, maxLength: number) {
    if (typeof value !== "string") throw new Error("设置格式不正确");
    const text = value.trim();
    if (/[\r\n\0]/.test(text)) throw new Error("设置里不能包含换行");
    if (text.length > maxLength) throw new Error("设置内容太长");
    return text;
}

function isHttpUrl(value: string) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}
