import { afterAll, afterEach, describe, expect, test } from "bun:test";

const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
});
const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { testChannelConnection, isNetworkErrorMessage } = await import("../src/services/api/channel-test");
const { createModelChannel } = await import("../src/stores/use-config-store");

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        return handler(url, init);
    }) as typeof fetch;
    return calls;
}

describe("渠道测试连接", () => {
    test("缺 Key 时不发请求，本地地址不要求 Key", async () => {
        const calls = mockFetch(() => new Response("{}"));
        const result = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "" }));
        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    test("ComfyUI 请求 /system_stats", async () => {
        const calls = mockFetch(() => new Response(JSON.stringify({ system: {} }), { headers: { "content-type": "application/json" } }));
        let tick = 0;
        const result = await testChannelConnection(createModelChannel({ apiFormat: "comfyui", baseUrl: "http://10.10.20.10:8188/" }), () => (tick += 40));
        expect(result).toEqual({ ok: true, elapsedMs: 40 });
        expect(calls[0].url).toBe("http://10.10.20.10:8188/system_stats");
    });

    test("Anthropic 请求模型列表并返回模型数", async () => {
        const calls = mockFetch(() => new Response(JSON.stringify({ data: [{ id: "claude-a" }, { id: "claude-b" }], has_more: false }), { headers: { "content-type": "application/json" } }));
        const result = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "sk-ant" }));
        expect(result.ok && result.modelCount).toBe(2);
        expect(calls[0].url.startsWith("https://api.anthropic.com/v1/models?")).toBe(true);
    });

    test("连不上时标记为网络错误", async () => {
        mockFetch(() => {
            throw new TypeError("Failed to fetch");
        });
        const comfy = await testChannelConnection(createModelChannel({ apiFormat: "comfyui" }));
        expect(comfy.ok === false && comfy.network).toBe(true);
        const anthropic = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "k" }));
        expect(anthropic.ok === false && anthropic.network).toBe(true);
        expect(isNetworkErrorMessage("bad key")).toBe(false);
    });

    test("200 但不是模型列表时算失败，空列表算成功", async () => {
        mockFetch(() => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
        const html = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "k" }));
        expect(html.ok).toBe(false);
        mockFetch(() => new Response(JSON.stringify({ data: [], has_more: false }), { headers: { "content-type": "application/json" } }));
        const empty = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "k" }));
        expect(empty.ok && empty.modelCount).toBe(0);
    });

    test("服务端报错时显示原因，不算网络错误", async () => {
        mockFetch(() => new Response(JSON.stringify({ type: "error", error: { message: "invalid x-api-key" } }), { status: 401 }));
        const result = await testChannelConnection(createModelChannel({ apiFormat: "anthropic", apiKey: "bad" }));
        expect(result).toMatchObject({ ok: false, message: "invalid x-api-key", network: false });
    });
});
