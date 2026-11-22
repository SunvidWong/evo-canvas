import { afterAll, describe, expect, test } from "bun:test";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { buildApiUrl, channelNeedsApiKey, createModelChannel, hasChannelCredentials, isLocalBaseUrl, normalizeChannelModels } = await import("../src/stores/use-config-store");
const { buildComfyWorkflow, collectComfyOutputs, parseComfyWorkflow } = await import("../src/services/api/comfyui");
const { parseChatCompletionEvents } = await import("../src/services/api/openai-chat");
const { parseAnthropicEvents, toAnthropicRequest } = await import("../src/services/api/anthropic");
const { CHANNEL_PRESETS, findChannelPreset } = await import("../src/lib/channel-presets");

describe("渠道协议与地址", () => {
    test("已带版本号的地址不再追加 /v1", () => {
        expect(buildApiUrl("https://api.openai.com", "/models")).toBe("https://api.openai.com/v1/models");
        expect(buildApiUrl("https://api.deepseek.com/v1/", "/chat/completions")).toBe("https://api.deepseek.com/v1/chat/completions");
        expect(buildApiUrl("https://open.bigmodel.cn/api/paas/v4", "/chat/completions")).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
        expect(buildApiUrl("https://ark.cn-beijing.volces.com/api/v3", "/chat/completions")).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    });

    test("本机和局域网地址可以不填 API Key", () => {
        expect(isLocalBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
        expect(isLocalBaseUrl("http://localhost:1234")).toBe(true);
        expect(isLocalBaseUrl("http://10.10.20.10:8188")).toBe(true);
        expect(isLocalBaseUrl("http://192.168.1.5:8000")).toBe(true);
        expect(isLocalBaseUrl("http://172.20.0.2:8000")).toBe(true);
        expect(isLocalBaseUrl("http://[::1]:8080")).toBe(true);
        expect(isLocalBaseUrl("https://api.openai.com")).toBe(false);
        expect(isLocalBaseUrl("http://172.32.0.1")).toBe(false);
        expect(channelNeedsApiKey({ apiFormat: "comfyui", baseUrl: "https://comfy.example.com" })).toBe(false);
        expect(channelNeedsApiKey({ apiFormat: "openai-chat", baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
        expect(hasChannelCredentials({ apiFormat: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "" })).toBe(true);
        expect(hasChannelCredentials({ apiFormat: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "" })).toBe(false);
    });

    test("新协议能保存，未知协议回退为 OpenAI，工作流随模型保留", () => {
        expect(createModelChannel({ apiFormat: "anthropic" }).baseUrl).toBe("https://api.anthropic.com");
        expect(createModelChannel({ apiFormat: "comfyui" }).baseUrl).toBe("http://127.0.0.1:8188");
        expect(createModelChannel({ apiFormat: "openai-chat" }).apiFormat).toBe("openai-chat");
        expect(createModelChannel({ apiFormat: "unknown" as never }).apiFormat).toBe("openai");
        expect(normalizeChannelModels([{ name: "t2i", capability: "image", workflow: " {} " }])).toEqual([{ name: "t2i", capability: "image", script: undefined, workflow: "{}" }]);
    });

    test("预设覆盖主流厂商和本地服务，并能按地址回显", () => {
        const ids = CHANNEL_PRESETS.map((preset) => preset.id);
        for (const id of ["openai", "anthropic", "gemini", "deepseek", "qwen", "doubao", "kimi", "zhipu", "openrouter", "ollama", "lmstudio", "vllm", "comfyui"]) expect(ids).toContain(id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(findChannelPreset("openai-chat", "https://api.deepseek.com/v1/")?.id).toBe("deepseek");
        expect(findChannelPreset("openai", "https://api.deepseek.com/v1")).toBeUndefined();
    });
});

describe("文本流解析", () => {
    test("Chat Completions 增量", () => {
        const block = 'data: {"choices":[{"delta":{"content":"你"}}]}\ndata: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]';
        expect(parseChatCompletionEvents(block)).toEqual({ text: "你好", error: "" });
        expect(parseChatCompletionEvents('data: {"error":{"message":"bad key"}}').error).toBe("bad key");
    });

    test("Anthropic 增量和消息转换", () => {
        const block = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}';
        expect(parseAnthropicEvents(block)).toEqual({ text: "Hi", error: "" });
        expect(parseAnthropicEvents('data: {"type":"error","error":{"message":"overloaded"}}').error).toBe("overloaded");
        const request = toAnthropicRequest([
            { role: "system", content: "规则" },
            { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
            { role: "user", content: "补充" },
        ]);
        expect(request.system).toBe("规则");
        expect(request.messages).toHaveLength(1);
        expect(request.messages[0].content).toEqual([
            { type: "text", text: "看图" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
            { type: "text", text: "补充" },
        ]);
    });
});

describe("ComfyUI 工作流", () => {
    const workflow = {
        "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
        "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
        "6": { class_type: "CLIPTextEncode", inputs: { text: "old prompt", clip: ["4", 1] } },
        "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] } },
        "10": { class_type: "LoadImage", inputs: { image: "example.png" } },
    };

    test("没有占位符时自动填提示词、尺寸、张数、参考图和随机种子", () => {
        const result = buildComfyWorkflow(workflow, { prompt: "一只猫", width: 1024, height: 768, count: 2, images: ["ref.png"] });
        expect(result["6"].inputs?.text).toBe("一只猫");
        expect(result["7"].inputs?.text).toBe("blurry");
        expect(result["5"].inputs).toEqual({ width: 1024, height: 768, batch_size: 2 });
        expect(result["10"].inputs?.image).toBe("ref.png");
        expect(typeof result["3"].inputs?.seed).toBe("number");
        expect(workflow["6"].inputs.text).toBe("old prompt");
    });

    test("占位符按类型替换，写了占位符的项不再自动填", () => {
        const templated = {
            "1": { class_type: "CLIPTextEncode", inputs: { text: "style, {{prompt}}" } },
            "2": { class_type: "EmptySD3LatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
            "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", positive: ["1", 0] } },
        };
        const result = buildComfyWorkflow(templated, { prompt: "cat", width: 640, height: 480, seed: 42 });
        expect(result["1"].inputs?.text).toBe("style, cat");
        expect(result["2"].inputs?.width).toBe(640);
        expect(result["2"].inputs?.height).toBe(480);
        expect(result["3"].inputs?.seed).toBe(42);
    });

    test("只接受 API 格式工作流", () => {
        expect(() => parseComfyWorkflow("not json")).toThrow();
        expect(() => parseComfyWorkflow(JSON.stringify({ nodes: [], links: [] }))).toThrow();
        expect(Object.keys(parseComfyWorkflow(JSON.stringify(workflow)))).toHaveLength(5);
        expect(Object.keys(parseComfyWorkflow(JSON.stringify({ prompt: workflow })))).toHaveLength(5);
    });

    test("收集输出文件，忽略已有正式输出时的预览图", () => {
        const files = collectComfyOutputs({
            "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
            "11": { images: [{ filename: "preview.png", type: "temp" }] },
            "12": { gifs: [{ filename: "clip.mp4", type: "output", format: "video/h264-mp4" }] },
        });
        expect(files.map((file) => [file.filename, file.kind])).toEqual([
            ["a.png", "image"],
            ["clip.mp4", "video"],
        ]);
        expect(collectComfyOutputs({ "11": { images: [{ filename: "preview.png", type: "temp" }] } })).toHaveLength(1);
    });
});
