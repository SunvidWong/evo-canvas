import type { ApiCallFormat } from "@/stores/use-config-store";

/** 渠道预设：选中后自动填好协议、接口地址和渠道名称，API Key 仍需自己填。 */
export type ChannelPreset = {
    id: string;
    name: string;
    /** 英文界面下显示的名称；不填时用 name。 */
    nameEn?: string;
    apiFormat: ApiCallFormat;
    baseUrl: string;
    group: "official" | "compatible" | "local";
    /** 本地服务一般不需要 API Key。 */
    local?: boolean;
};

export const CHANNEL_PRESETS: ChannelPreset[] = [
    { id: "openai", name: "OpenAI", apiFormat: "openai", baseUrl: "https://api.openai.com", group: "official" },
    { id: "anthropic", name: "Anthropic Claude", apiFormat: "anthropic", baseUrl: "https://api.anthropic.com", group: "official" },
    { id: "gemini", name: "Google Gemini", apiFormat: "gemini", baseUrl: "https://generativelanguage.googleapis.com", group: "official" },
    { id: "deepseek", name: "DeepSeek", apiFormat: "openai-chat", baseUrl: "https://api.deepseek.com/v1", group: "compatible" },
    { id: "qwen", name: "通义千问（阿里云百炼）", nameEn: "Qwen (Alibaba Cloud Model Studio)", apiFormat: "openai-chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", group: "compatible" },
    { id: "doubao", name: "豆包（火山方舟）", nameEn: "Doubao (Volcano Ark)", apiFormat: "openai-chat", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", group: "compatible" },
    { id: "kimi", name: "Kimi（月之暗面）", nameEn: "Kimi (Moonshot AI)", apiFormat: "openai-chat", baseUrl: "https://api.moonshot.cn/v1", group: "compatible" },
    { id: "zhipu", name: "智谱 GLM", nameEn: "Zhipu GLM", apiFormat: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", group: "compatible" },
    { id: "minimax", name: "MiniMax", apiFormat: "openai-chat", baseUrl: "https://api.minimaxi.com/v1", group: "compatible" },
    { id: "qianfan", name: "百度千帆", nameEn: "Baidu Qianfan", apiFormat: "openai-chat", baseUrl: "https://qianfan.baidubce.com/v2", group: "compatible" },
    { id: "hunyuan", name: "腾讯混元", nameEn: "Tencent Hunyuan", apiFormat: "openai-chat", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", group: "compatible" },
    { id: "siliconflow", name: "硅基流动 SiliconFlow", nameEn: "SiliconFlow", apiFormat: "openai-chat", baseUrl: "https://api.siliconflow.cn/v1", group: "compatible" },
    { id: "openrouter", name: "OpenRouter", apiFormat: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", group: "compatible" },
    { id: "xai", name: "xAI Grok", apiFormat: "openai-chat", baseUrl: "https://api.x.ai/v1", group: "compatible" },
    { id: "mistral", name: "Mistral", apiFormat: "openai-chat", baseUrl: "https://api.mistral.ai/v1", group: "compatible" },
    { id: "groq", name: "Groq", apiFormat: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", group: "compatible" },
    { id: "together", name: "Together AI", apiFormat: "openai-chat", baseUrl: "https://api.together.xyz/v1", group: "compatible" },
    { id: "ollama", name: "Ollama", apiFormat: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", group: "local", local: true },
    { id: "lmstudio", name: "LM Studio", apiFormat: "openai-chat", baseUrl: "http://127.0.0.1:1234/v1", group: "local", local: true },
    { id: "vllm", name: "vLLM", apiFormat: "openai-chat", baseUrl: "http://127.0.0.1:8000/v1", group: "local", local: true },
    { id: "llamacpp", name: "llama.cpp server", apiFormat: "openai-chat", baseUrl: "http://127.0.0.1:8080/v1", group: "local", local: true },
    { id: "comfyui", name: "ComfyUI", apiFormat: "comfyui", baseUrl: "http://127.0.0.1:8188", group: "local", local: true },
];

/** 按协议和地址找出当前渠道对应的预设，用于在编辑时回显。 */
export function findChannelPreset(apiFormat: ApiCallFormat, baseUrl: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
    return CHANNEL_PRESETS.find((preset) => preset.apiFormat === apiFormat && preset.baseUrl.toLowerCase() === normalized);
}

export function channelPresetName(preset: ChannelPreset, locale: string | undefined) {
    return locale === "zh-CN" ? preset.name : preset.nameEn || preset.name;
}
