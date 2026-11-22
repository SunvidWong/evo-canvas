import i18n from "@/i18n";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";
import type { ChatMessage } from "./openai-chat";

type RequestOptions = { signal?: AbortSignal };
type AnthropicContent = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } };
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContent[] };
type AnthropicEvent = { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { message?: string } };

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const ANTHROPIC_VERSION = "2023-06-01";
/** Messages 接口要求必须给出回复长度上限；渠道没设置时用常见模型都支持的值。到达上限时在回复末尾提示被截断。 */
export const ANTHROPIC_MAX_TOKENS = 8192;

export function anthropicHeaders(apiKey: string, contentType?: string) {
    return {
        "x-api-key": apiKey.trim(),
        "anthropic-version": ANTHROPIC_VERSION,
        // 浏览器直连 Anthropic 需要显式声明，否则接口不返回 CORS 头。
        "anthropic-dangerous-direct-browser-access": "true",
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function toAnthropicContent(content: ChatMessage["content"]): AnthropicContent[] {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
    return content.flatMap((part): AnthropicContent[] => {
        if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
        const url = part.image_url.url;
        const match = url.match(/^data:([^;,]+);base64,(.*)$/);
        if (match) return [{ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }];
        return [{ type: "image", source: { type: "url", url } }];
    });
}

/** 把通用消息转成 Messages 接口格式：system 单独放，连续同角色消息合并。 */
export function toAnthropicRequest(messages: ChatMessage[]) {
    const system = messages
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")))
        .filter(Boolean)
        .join("\n\n");
    const result: AnthropicMessage[] = [];
    for (const message of messages) {
        if (message.role === "system") continue;
        const content = toAnthropicContent(message.content);
        if (!content.length) continue;
        const last = result[result.length - 1];
        if (last?.role === message.role) last.content.push(...content);
        else result.push({ role: message.role, content });
    }
    return { ...(system ? { system } : {}), messages: result };
}

async function readError(response: Response) {
    const body = await response.text();
    try {
        return (JSON.parse(body) as AnthropicEvent).error?.message || body.slice(0, 300);
    } catch {
        return body.slice(0, 300) || apiText("httpFailed", { status: response.status });
    }
}

/** 从一段 SSE 文本中取出文字增量、错误和结束原因。 */
export function parseAnthropicEvents(block: string) {
    let text = "";
    let error = "";
    let stopReason = "";
    for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        let event: AnthropicEvent;
        try {
            event = JSON.parse(line.slice(5).trim()) as AnthropicEvent;
        } catch {
            continue;
        }
        if (event.type === "error") error ||= event.error?.message || apiText("requestFailed");
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text || "";
        if (event.type === "message_delta" && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    }
    return { text, error, stopReason };
}

/** 通过 Anthropic Messages 接口流式生成文本。 */
export async function requestAnthropicMessage(config: AiConfig, messages: ChatMessage[], onDelta?: (text: string) => void, options?: RequestOptions) {
    const maxTokens = config.maxTokens || ANTHROPIC_MAX_TOKENS;
    const response = await fetch(buildApiUrl(config.baseUrl, "/messages"), {
        method: "POST",
        headers: { ...anthropicHeaders(config.apiKey, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, max_tokens: maxTokens, stream: true, ...toAnthropicRequest(messages) }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error(apiText("requestFailed"));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let stopReason = "";
    const consume = (block: string) => {
        const result = parseAnthropicEvents(block);
        if (result.error) throw new Error(result.error);
        if (result.stopReason) stopReason = result.stopReason;
        if (result.text) {
            text += result.text;
            onDelta?.(text);
        }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        blocks.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (stopReason === "max_tokens") {
        text += `\n\n${apiText("anthropicMaxTokens", { limit: maxTokens })}`;
        onDelta?.(text);
    }
    return text;
}

/** 拉取 Anthropic 可用模型列表（自动翻页）。 */
export async function fetchAnthropicModels(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    const ids: string[] = [];
    let afterId = "";
    for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ limit: "1000", ...(afterId ? { after_id: afterId } : {}) });
        const response = await fetch(buildApiUrl(config.baseUrl, `/models?${query}`), { headers: anthropicHeaders(config.apiKey) });
        if (!response.ok) throw new Error(await readError(response));
        let payload: { data?: Array<{ id?: string }>; has_more?: boolean; last_id?: string };
        try {
            payload = await response.json();
        } catch {
            throw new Error(apiText("invalidModelList"));
        }
        if (!Array.isArray(payload?.data)) throw new Error(apiText("invalidModelList"));
        ids.push(...payload.data.map((item) => item.id).filter((id): id is string => Boolean(id)));
        if (!payload.has_more || !payload.last_id) break;
        afterId = payload.last_id;
    }
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}
