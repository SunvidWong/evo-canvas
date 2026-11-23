import { expect, test } from "bun:test";

// comfyui.ts 会加载 i18n，它在初始化时读 localStorage。
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { clearOwnComfyQueue, comfyQueueReadable, ownPendingComfyPrompts, runComfyWorkflow, summarizeComfyQueue } = await import("../src/services/api/comfyui");

const queue = {
    queue_running: [[1, "run-1", {}, { client_id: "infinite-canvas-aaa" }, []]],
    queue_pending: [
        [2, "mine-1", {}, { client_id: "infinite-canvas-bbb" }, []],
        [3, "other-1", {}, { client_id: "someone-else" }, []],
        [4, "mine-2", {}, { client_id: "infinite-canvas-ccc" }, []],
        [5, "no-client", {}, {}, []],
    ],
};

test("finds only this site's pending prompts", () => {
    expect(ownPendingComfyPrompts(queue)).toEqual(["mine-1", "mine-2"]);
    expect(ownPendingComfyPrompts(undefined)).toEqual([]);
    expect(ownPendingComfyPrompts({ queue_pending: [{ prompt_id: "obj", extra_data: { client_id: "infinite-canvas-x" } }] })).toEqual(["obj"]);
});

test("summarizes running, pending and own counts", () => {
    expect(summarizeComfyQueue(queue)).toEqual({ running: 1, pending: 4, mine: 2 });
    expect(summarizeComfyQueue({})).toEqual({ running: 0, pending: 0, mine: 0 });
});

test("only trusts a queue whose entries it can read", () => {
    expect(comfyQueueReadable(queue)).toBe(true);
    expect(comfyQueueReadable({ queue_running: [], queue_pending: [] })).toBe(true);
    expect(comfyQueueReadable({ queue_running: [{ foo: 1 }], queue_pending: [] })).toBe(false);
    expect(comfyQueueReadable({})).toBe(false);
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
    const calls: Array<{ url: string; body?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
        return new Response(JSON.stringify(handler(url, init) ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
}

test("deletes only own pending prompts", async () => {
    const mock = mockFetch((url) => (url.endsWith("/queue") ? queue : {}));
    try {
        expect(await clearOwnComfyQueue({ baseUrl: "http://comfy.test", apiKey: "" })).toBe(2);
        const post = mock.calls.find((call) => call.body);
        expect(JSON.parse(post!.body!)).toEqual({ delete: ["mine-1", "mine-2"] });
    } finally {
        mock.restore();
    }
});

test("gives up when the prompt vanished from both queue and history", async () => {
    const mock = mockFetch((url) => (url.endsWith("/prompt") ? { prompt_id: "gone" } : url.endsWith("/queue") ? { queue_running: [], queue_pending: [] } : {}));
    try {
        const workflow = { "9": { class_type: "SaveImage", inputs: {} } };
        await expect(runComfyWorkflow({ baseUrl: "http://comfy.test", apiKey: "" }, workflow)).rejects.toThrow(/找不到|no longer/);
    } finally {
        mock.restore();
    }
}, 10000);
