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

const { buildApiUrl, channelNeedsApiKey, guessCapability, upsertChannelCredentials, createModelChannel, hasChannelCredentials, isLocalBaseUrl, normalizeChannelModels } = await import("../src/stores/use-config-store");
const { autoComfyInputs, generateComfyVideo, buildComfyWorkflow, collectComfyOutputs, comfyPlaceholderParams, listComfyInputs, listComfyOutputNodes, parseComfyHistoryWorkflows, parseComfySettings, parseComfyWorkflow, serializeComfyWorkflow } =
    await import("../src/services/api/comfyui");
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
        expect(createModelChannel({ maxTokens: 4096 }).maxTokens).toBe(4096);
        expect(createModelChannel({ maxTokens: -1 }).maxTokens).toBeUndefined();
        expect(createModelChannel({ maxTokens: "2048" as never }).maxTokens).toBe(2048);
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

describe("模型能力识别", () => {
    test("覆盖国内外常见生图、视频、语音模型，文本和看图模型不误判", () => {
        const cases: Record<string, string> = {
            "qwen-image": "image",
            "hunyuan-image-3.0": "image",
            "cogview-4": "image",
            "Kwai-Kolors/Kolors": "image",
            "jimeng-3.1": "image",
            "wanx2.1-t2i-turbo": "image",
            "flux-kontext-pro": "image",
            "runwayml/stable-diffusion-v1-5": "image",
            "runwayml/stable-diffusion-inpainting": "image",
            "luma-photon-1": "image",
            "runway-gen4-turbo": "video",
            "luma-ray-2": "video",
            "gpt-image-1": "image",
            "doubao-seedream-4-0": "image",
            "kling-v2-image": "image",
            "gemini-2.5-flash-image": "image",
            "ideogram-v3": "image",
            "doubao-seedance-1-0-pro": "video",
            "wan2.2-i2v-plus": "video",
            "Wan-AI/Wan2.1-T2V-14B": "video",
            "cogvideox-5b": "video",
            "hunyuan-video": "video",
            "jimeng-video-3.0": "video",
            "vidu-q1": "video",
            "MiniMax-Hailuo-02": "video",
            "kling-v2-1-master": "video",
            "veo-3": "video",
            "ltxv-13b": "video",
            "cosyvoice-v2": "audio",
            "fishaudio/fish-speech-1.5": "audio",
            "speech-02-hd": "audio",
            "gpt-4o-mini-tts": "audio",
            "suno-v4": "audio",
            "qwen3:8b": "text",
            "deepseek-chat": "text",
            "claude-sonnet-4-5": "text",
            "qwen-vl-max": "text",
            "glm-4.5": "text",
            "kimi-k2": "text",
            "swan-7b": "text",
        };
        for (const [name, capability] of Object.entries(cases)) expect([name, guessCapability(name)]).toEqual([name, capability]);
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
        expect(parseAnthropicEvents(block)).toEqual({ text: "Hi", error: "", stopReason: "" });
        expect(parseAnthropicEvents('data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}').stopReason).toBe("max_tokens");
        expect(parseAnthropicEvents('data: {"type":"error","error":{"message":"overloaded"}}').error).toBe("overloaded");
        const request = toAnthropicRequest([
            { role: "system", content: "规则" },
            {
                role: "user",
                content: [
                    { type: "text", text: "看图" },
                    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
                ],
            },
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

    test("手动映射优先于自动识别，占位符优先于手动映射", () => {
        const result = buildComfyWorkflow(
            workflow,
            { prompt: "cat", negativePrompt: "ugly", width: 800, seed: 7, images: ["a.png"] },
            { mapping: { prompt: ["7.text"], negative_prompt: ["6.text"], seed: ["3.seed", "3.steps"], width: ["missing.width", "3.positive"] } },
        );
        expect(result["7"].inputs?.text).toBe("cat");
        expect(result["6"].inputs?.text).toBe("ugly");
        expect(result["3"].inputs?.seed).toBe(7);
        expect(result["3"].inputs?.steps).toBe(7);
        // 不存在的节点和连线输入都跳过，宽度只按映射填，不再自动填 Latent。
        expect(result["3"].inputs?.positive).toEqual(["6", 0]);
        expect(result["5"].inputs?.width).toBe(512);
        expect(result["10"].inputs?.image).toBe("a.png");
        const templated = { ...workflow, "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["4", 1] } } };
        const placeholder = buildComfyWorkflow(templated, { prompt: "dog" }, { mapping: { prompt: ["7.text"] } });
        expect(placeholder["6"].inputs?.text).toBe("dog");
        expect(placeholder["7"].inputs?.text).toBe("blurry");
        expect(comfyPlaceholderParams(templated)).toEqual(["prompt"]);
    });

    test("列出可映射参数、自动识别结果和输出节点", () => {
        const refs = listComfyInputs(workflow).map((item) => item.ref);
        expect(refs).toContain("6.text");
        expect(refs).not.toContain("3.positive");
        expect(autoComfyInputs(workflow)).toMatchObject({ prompt: ["6.text"], width: ["5.width"], count: ["5.batch_size"], seed: ["3.seed"], image: ["10.image"] });
        const outputs = listComfyOutputNodes({ ...workflow, "9": { class_type: "SaveImage", inputs: {} }, "12": { class_type: "VHS_VideoCombine", inputs: {} }, "13": { class_type: "SaveAudio", inputs: {} } });
        expect(outputs.map((item) => [item.nodeId, item.kind])).toEqual([
            ["9", "image"],
            ["12", "video"],
            ["13", "audio"],
        ]);
    });

    test("设置和工作流一起保存，读取时丢掉无效内容", () => {
        expect(serializeComfyWorkflow(workflow, {})).toBe(JSON.stringify(workflow, null, 2));
        const text = serializeComfyWorkflow(workflow, { mapping: { prompt: ["6.text"], width: [] }, outputNodes: ["10", "gone"] });
        expect(Object.keys(parseComfyWorkflow(text))).toHaveLength(5);
        expect(parseComfySettings(text)).toEqual({ mapping: { prompt: ["6.text"] }, outputNodes: ["10"] });
        expect(parseComfySettings(JSON.stringify({ prompt: workflow, infinite_canvas: { mapping: { prompt: ["bad", 3, "6.text", "6.text"], other: ["1.x"] }, outputNodes: "x" } }))).toEqual({ mapping: { prompt: ["6.text"] } });
        expect(parseComfySettings("not json")).toEqual({});
    });

    test("选了输出节点时只取这些节点的结果，都没产出时退回全部", () => {
        const outputs = { "9": { images: [{ filename: "final.png", type: "output" }] }, "15": { images: [{ filename: "mid.png", type: "output" }] } };
        expect(collectComfyOutputs(outputs, ["9"]).map((file) => file.filename)).toEqual(["final.png"]);
        expect(collectComfyOutputs(outputs, ["99"]).map((file) => file.filename)).toEqual(["final.png", "mid.png"]);
    });

    test("生成时按保存的映射提交，并只从选中的输出节点取视频", async () => {
        const originalFetch = globalThis.fetch;
        const calls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
            if (url.endsWith("/prompt")) return new Response(JSON.stringify({ prompt_id: "p1" }));
            if (url.includes("/history/p1"))
                return new Response(JSON.stringify({ p1: { status: { status_str: "success", completed: true }, outputs: { "11": { gifs: [{ filename: "mid.mp4", type: "output" }] }, "12": { gifs: [{ filename: "final.mp4", type: "output" }] } } } }));
            if (url.includes("/view")) return new Response(new Blob(["v"], { type: "video/mp4" }));
            return new Response("{}", { status: 404 });
        }) as typeof fetch;
        try {
            const text = serializeComfyWorkflow({ ...workflow, "11": { class_type: "VHS_VideoCombine", inputs: {} }, "12": { class_type: "VHS_VideoCombine", inputs: {} } }, { mapping: { prompt: ["7.text"] }, outputNodes: ["12"] });
            await generateComfyVideo({ baseUrl: "http://comfy.local", apiKey: "" }, text, { prompt: "river" });
            const submitted = JSON.parse(calls.find((call) => call.url.endsWith("/prompt"))?.body || "{}").prompt;
            expect(submitted["7"].inputs.text).toBe("river");
            expect(submitted["6"].inputs.text).toBe("old prompt");
            expect(calls.find((call) => call.url.includes("/view"))?.url).toContain("filename=final.mp4");
        } finally {
            globalThis.fetch = originalFetch;
        }
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

    test("从运行历史取出 API 工作流，最新的在前，按输出识别视频", () => {
        const items = parseComfyHistoryWorkflows({
            old: {
                prompt: [0, "old", { "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } }, "5": { class_type: "KSampler", inputs: {} } }, {}, ["9"]],
                outputs: { "9": { images: [{ filename: "a.png", type: "output" }] } },
            },
            fresh: {
                prompt: [1, "fresh", { "1": { class_type: "KSamplerAdvanced", inputs: {} }, "2": { class_type: "SaveAnimatedWEBP", inputs: {} } }, {}, []],
                outputs: { "2": { gifs: [{ filename: "v.mp4", type: "output", format: "video/h264-mp4" }] } },
                status: { messages: [["execution_start", { timestamp: 123 }]] },
            },
            broken: { prompt: [2, "broken", { nodes: [] }] },
        });
        expect(items.map((item) => [item.id, item.capability, item.summary, item.time])).toEqual([
            ["fresh", "video", "KSamplerAdvanced", 123],
            ["old", "image", "flux1-dev.safetensors", undefined],
        ]);
        expect(parseComfyHistoryWorkflows(null)).toEqual([]);
        const vhsImage = parseComfyHistoryWorkflows({
            a: { prompt: [0, "a", { "1": { class_type: "VHS_LoadImagesPath", inputs: {} }, "2": { class_type: "SaveImage", inputs: {} } }], outputs: { "2": { images: [{ filename: "x.png", type: "output" }] } } },
        });
        expect(vhsImage[0].capability).toBe("image");
        const noOutputs = parseComfyHistoryWorkflows({ b: { prompt: [0, "b", { "1": { class_type: "VHS_VideoCombine", inputs: {} } }] } });
        expect(noOutputs[0].capability).toBe("video");
    });
});

describe("链接导入渠道", () => {
    const empty = { channels: [] } as never;
    const created = (input: Parameters<typeof upsertChannelCredentials>[1]) => {
        const result = upsertChannelCredentials(empty, input);
        return (result.config as { channels: Array<{ name: string; apiFormat: string; baseUrl: string; apiKey: string }> }).channels[0];
    };

    test("按地址匹配预设推断协议和名称", () => {
        expect(created({ baseUrl: "https://api.deepseek.com/v1", apiKey: "sk" })).toMatchObject({ apiFormat: "openai-chat", name: "DeepSeek" });
        expect(created({ baseUrl: "https://api.anthropic.com" })).toMatchObject({ apiFormat: "anthropic" });
        expect(created({ baseUrl: "https://relay.example.com/v1" })).toMatchObject({ apiFormat: "openai", name: "relay.example.com" });
    });

    test("显式协议和名称优先，未知协议忽略", () => {
        expect(created({ baseUrl: "http://10.10.20.10:8188", apiFormat: "ComfyUI", name: "家里的 ComfyUI" })).toMatchObject({ apiFormat: "comfyui", name: "家里的 ComfyUI" });
        expect(created({ baseUrl: "https://relay.example.com/v1", apiFormat: "bogus" })).toMatchObject({ apiFormat: "openai" });
    });

    test("已有同地址渠道时可改协议，不改名称", () => {
        const first = upsertChannelCredentials(empty, { baseUrl: "https://relay.example.com/v1", apiKey: "a", name: "中转" });
        const second = upsertChannelCredentials(first.config, { baseUrl: "https://relay.example.com/v1", apiFormat: "anthropic" });
        const channels = (second.config as { channels: Array<{ name: string; apiFormat: string; apiKey: string }> }).channels;
        expect(second.status).toBe("updated");
        expect(channels).toHaveLength(1);
        expect(channels[0]).toMatchObject({ name: "中转", apiFormat: "anthropic", apiKey: "a" });
    });
});
