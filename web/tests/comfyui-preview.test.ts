import { expect, test } from "bun:test";

// comfyui.ts 会加载 i18n，它在初始化时读 localStorage。
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { parseComfyPreviewFrame } = await import("../src/services/api/comfyui");
const { clearComfyProgress, bindComfyProgressNode, getComfyNodePreview, setComfyPreview, unbindComfyProgress } = await import("../src/lib/comfy-progress");

function frame(event: number, second: number, body: Uint8Array) {
    const buffer = new ArrayBuffer(8 + body.length);
    const view = new DataView(buffer);
    view.setUint32(0, event);
    view.setUint32(4, second);
    new Uint8Array(buffer, 8).set(body);
    return buffer;
}

test("parses legacy preview frames by format", () => {
    const jpeg = parseComfyPreviewFrame(frame(1, 1, new Uint8Array([0xff, 0xd8, 0xff])));
    expect(jpeg?.type).toBe("image/jpeg");
    expect([...(jpeg?.data || [])]).toEqual([0xff, 0xd8, 0xff]);
    expect(parseComfyPreviewFrame(frame(1, 2, new Uint8Array([0x89])))?.type).toBe("image/png");
    expect(parseComfyPreviewFrame(frame(1, 9, new Uint8Array([1])))).toBeUndefined();
    expect(parseComfyPreviewFrame(frame(3, 1, new Uint8Array([1])))).toBeUndefined();
    expect(parseComfyPreviewFrame(new ArrayBuffer(8))).toBeUndefined();
});

test("parses metadata preview frames and skips other prompts", () => {
    const meta = new TextEncoder().encode(JSON.stringify({ image_type: "image/png", prompt_id: "p1" }));
    const body = new Uint8Array([...meta, 7, 8]);
    const buffer = frame(4, meta.length, body);
    expect(parseComfyPreviewFrame(buffer, "p1")).toEqual({ type: "image/png", data: new Uint8Array([7, 8]) });
    expect(parseComfyPreviewFrame(buffer, "p2")).toBeUndefined();
    expect(parseComfyPreviewFrame(frame(4, 99, body), "p1")).toBeUndefined();
    expect(parseComfyPreviewFrame(frame(4, 2, new Uint8Array([0x7b, 0x7d]))), "metadata without image bytes").toBeUndefined();
});

test("keeps the latest preview per key and revokes old urls", () => {
    let next = 0;
    const revoked: string[] = [];
    URL.createObjectURL = () => `blob:${(next += 1)}`;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    const controller = new AbortController();
    bindComfyProgressNode(controller.signal, "node-a");
    setComfyPreview(controller.signal, "run-1", new Blob([]));
    setComfyPreview(controller.signal, "run-1", new Blob([]));
    expect(getComfyNodePreview("node-a")).toBe("blob:2");
    expect(revoked).toEqual(["blob:1"]);
    setComfyPreview(controller.signal, "run-2", new Blob([]));
    setComfyPreview(controller.signal, "run-1", new Blob([]));
    expect(getComfyNodePreview("node-a")).toBe("blob:4");
    clearComfyProgress(controller.signal, "run-1");
    expect(getComfyNodePreview("node-a")).toBe("blob:3");
    unbindComfyProgress(controller.signal);
    expect(getComfyNodePreview("node-a")).toBeUndefined();
    expect(revoked).toEqual(["blob:1", "blob:2", "blob:4", "blob:3"]);
});
