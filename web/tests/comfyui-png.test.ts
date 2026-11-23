import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

// comfyui.ts 会加载 i18n，它在初始化时读 localStorage。
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { comfyWorkflowFromPng, readPngTextChunks } = await import("../src/services/api/comfyui");

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

function chunk(type: string, data: Uint8Array) {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(latin1(type), 4);
    out.set(data, 8);
    return out; // CRC 留 0，读取时不校验。
}

function png(...chunks: Uint8Array[]) {
    const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", new Uint8Array(13)), ...chunks, chunk("IEND", new Uint8Array())];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) out.set(part, (offset += part.length) - part.length);
    return out;
}

const tEXt = (key: string, text: string) => chunk("tEXt", latin1(`${key}\0${text}`));
function iTXt(key: string, text: string, compressed = false) {
    const body = compressed ? new Uint8Array(deflateSync(Buffer.from(text))) : new TextEncoder().encode(text);
    return chunk("iTXt", new Uint8Array([...latin1(key), 0, compressed ? 1 : 0, 0, 0, 0, ...body]));
}

const API = { "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } } };
const UI = { nodes: [{ id: 3, type: "KSampler" }], links: [] };

test("reads tEXt prompt as API workflow", async () => {
    const result = await comfyWorkflowFromPng(png(tEXt("prompt", JSON.stringify(API)), tEXt("workflow", JSON.stringify(UI))));
    expect(result?.format).toBe("api");
    expect(JSON.parse(result?.text || "")).toEqual(API);
});

test("reads iTXt with non-latin text, plain and compressed", async () => {
    const workflow = { "6": { class_type: "CLIPTextEncode", inputs: { text: "一只狐狸" } } };
    expect(JSON.parse((await comfyWorkflowFromPng(png(iTXt("prompt", JSON.stringify(workflow)))))?.text || "")).toEqual(workflow);
    expect(JSON.parse((await comfyWorkflowFromPng(png(iTXt("prompt", JSON.stringify(workflow), true))))?.text || "")).toEqual(workflow);
});

test("falls back to the UI workflow and rejects images without one", async () => {
    expect((await comfyWorkflowFromPng(png(tEXt("prompt", "not json"), tEXt("workflow", JSON.stringify(UI)))))?.format).toBe("ui");
    expect(await comfyWorkflowFromPng(png(tEXt("Software", "GIMP")))).toBeUndefined();
    expect(await readPngTextChunks(new TextEncoder().encode("{}"))).toEqual({});
});
