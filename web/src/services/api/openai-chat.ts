import i18n from "@/i18n";
import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

type ChatContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type ChatMessage = { role: "system" | "user" | "assistant"; content: ChatContent };
type RequestOptions = { signal?: AbortSignal };
type ChatChunk = { choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>; error?: { message?: string } | string; message?: string };

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/** OpenAI 兼容接口的请求头；本地服务没填 API Key 时不带 Authorization。 */
export function openAICompatibleHeaders(apiKey: string, contentType?: string) {
    return {
        ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function chunkError(chunk: ChatChunk) {
    if (typeof chunk.error === "string") return chunk.error;
    return chunk.error?.message || "";
}

/** 从一段 SSE 文本中取出 Chat Completions 的增量文字；返回本段文字和遇到的错误。 */
export function parseChatCompletionEvents(block: string) {
    let text = "";
    let error = "";
    for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: ChatChunk;
        try {
            chunk = JSON.parse(data) as ChatChunk;
        } catch {
            continue;
        }
        error ||= chunkError(chunk);
        const choice = chunk.choices?.[0];
        text += choice?.delta?.content || choice?.message?.content || "";
    }
    return { text, error };
}

async function readError(response: Response) {
    const body = await response.text();
    try {
        const payload = JSON.parse(body) as ChatChunk;
        return chunkError(payload) || payload.message || body.slice(0, 300) || apiText("httpFailed", { status: response.status });
    } catch {
        return body.slice(0, 300) || apiText("httpFailed", { status: response.status });
    }
}

/** 通过 OpenAI 兼容的 /chat/completions 流式生成文本，DeepSeek、通义、Kimi、Ollama、LM Studio、vLLM 等都支持。 */
export async function requestChatCompletion(config: AiConfig, messages: ChatMessage[], onDelta?: (text: string) => void, options?: RequestOptions) {
    const response = await fetch(buildApiUrl(config.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { ...openAICompatibleHeaders(config.apiKey, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages, stream: true, ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}) }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body || !response.headers.get("content-type")?.includes("event-stream")) {
        const payload = (await response.json()) as ChatChunk;
        const error = chunkError(payload);
        if (error) throw new Error(error);
        const text = payload.choices?.[0]?.message?.content || "";
        if (text) onDelta?.(text);
        return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const consume = (block: string) => {
        const result = parseChatCompletionEvents(block);
        if (result.error) throw new Error(result.error);
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
    return text;
}
