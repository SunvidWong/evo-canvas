import { expect, test } from "bun:test";

import type { ComfyWorkflow } from "../src/services/api/comfyui";

// comfyui.ts 会加载 i18n，它在初始化时读 localStorage。
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { buildComfyWorkflow, comfySeedForImage, comfyWorkflowSeed, parseComfyOverrides } = await import("../src/services/api/comfyui");

const workflow: ComfyWorkflow = {
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "cat" } },
    "7": { class_type: "BasicScheduler", inputs: { steps: ["8", 0] } },
    "8": { class_type: "PrimitiveInt", inputs: { value: 30 } },
    "10": { class_type: "SeedVR2VideoUpscaler", inputs: { seed: 5, steps: 1, cfg: 1 } },
    "9": { class_type: "SaveImage", inputs: {} },
};

test("parses only valid overrides", () => {
    expect(parseComfyOverrides({ comfySteps: "8", comfyCfg: "3.5", comfySeed: "42" })).toEqual({ steps: 8, cfg: 3.5, seed: 42 });
    expect(parseComfyOverrides({ comfySteps: "", comfyCfg: " ", comfySeed: undefined })).toEqual({});
    expect(parseComfyOverrides({ comfySteps: "0", comfyCfg: "101", comfySeed: "1.5" })).toEqual({});
    expect(parseComfyOverrides({ comfySteps: "8.5", comfySeed: "-1" })).toEqual({});
    expect(parseComfyOverrides({ comfySeed: String(2 ** 32) })).toEqual({});
});

test("overrides sampler steps and cfg but leaves links and upscalers alone", () => {
    const built = buildComfyWorkflow(workflow, { prompt: "dog", steps: 8, cfg: 2.5 });
    expect(built["3"].inputs).toMatchObject({ steps: 8, cfg: 2.5 });
    expect(built["7"].inputs?.steps).toEqual(["8", 0]);
    expect(built["10"].inputs).toMatchObject({ steps: 1, cfg: 1 });
});

test("keeps workflow values when nothing is overridden", () => {
    const built = buildComfyWorkflow(workflow, { prompt: "dog" });
    expect(built["3"].inputs).toMatchObject({ steps: 20, cfg: 7 });
});

test("a fixed seed is used as is", () => {
    const built = buildComfyWorkflow(workflow, { prompt: "dog", seed: 42 }, { seedMode: "random" });
    expect(built["3"].inputs?.seed).toBe(42);
});

test("each extra image in a batch gets the next seed", () => {
    expect(comfySeedForImage("42", 0)).toBe("42");
    expect(comfySeedForImage("42", 2)).toBe("44");
    expect(comfySeedForImage(String(2 ** 32 - 1), 1)).toBe("0");
    expect(comfySeedForImage(undefined, 3)).toBeUndefined();
    expect(comfySeedForImage("abc", 1)).toBe("abc");
});

test("reads back the seed that was actually submitted", () => {
    const built = buildComfyWorkflow(workflow, { prompt: "dog" });
    const seed = comfyWorkflowSeed(built);
    expect(seed).toBe(built["3"].inputs?.seed as number);
    expect(comfyWorkflowSeed(buildComfyWorkflow(workflow, { prompt: "dog", seed: 7 }))).toBe(7);
    // 手动映射优先；节点 10 是放大器，自动识别会跳过它。
    expect(comfyWorkflowSeed(built, { mapping: { seed: ["10.seed"] } })).toBe(5);
    expect(comfyWorkflowSeed({ "1": { class_type: "SaveImage", inputs: {} } })).toBeUndefined();
});
