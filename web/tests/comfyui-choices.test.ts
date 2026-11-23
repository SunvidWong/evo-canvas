import { expect, test } from "bun:test";

import type { ComfyWorkflow } from "../src/services/api/comfyui";

// comfyui.ts 会加载 i18n，它在初始化时读 localStorage。
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { comfyInputChoices, listComfyChoiceInputs, listComfyTunableInputs } = await import("../src/services/api/comfyui");

const workflow: ComfyWorkflow = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
    "5": { class_type: "LoraLoader", inputs: { lora_name: "style.safetensors", strength_model: 0.8, strength_clip: 1, model: ["4", 0], clip: ["4", 1] } },
    "3": { class_type: "KSampler", inputs: { sampler_name: "euler", scheduler: "normal", steps: 20, model: ["5", 0] } },
    "6": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5.safetensors", clip_name2: "l.safetensors", type: "flux" } },
};

test("lists model, lora and sampler inputs that hold plain values", () => {
    expect(listComfyChoiceInputs(workflow).map((item) => item.ref)).toEqual(["3.sampler_name", "3.scheduler", "4.ckpt_name", "5.lora_name", "6.clip_name1", "6.clip_name2"]);
});

test("lists custom model loaders whose value is a model file", () => {
    const custom: ComfyWorkflow = {
        "10": { class_type: "SeedVR2LoadDiTModel", inputs: { model: "seedvr2_ema_3b_fp16.safetensors", device: "cuda:0" } },
        "11": { class_type: "SeedVR2LoadVAEModel", inputs: { model: "ema_vae_fp16.safetensors", device: "cuda:0" } },
        "12": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-UltraSharp.pth" } },
        "13": { class_type: "CLIPTextEncode", inputs: { text: "a photo of model.safetensors", clip: ["4", 1] } },
    };
    expect(listComfyChoiceInputs(custom).map((item) => item.ref)).toEqual(["10.model", "11.model", "12.model_name"]);
});

test("lists lora strengths as tunables", () => {
    expect(listComfyTunableInputs(workflow).map((item) => item.ref)).toEqual(["3.steps", "5.strength_model", "5.strength_clip"]);
});

test("reads choices from old and new object_info formats", () => {
    const info = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "b.safetensors"]] } } },
        KSampler: { input: { required: { sampler_name: ["COMBO", { options: ["euler", "dpmpp_2m"] }] } } },
    } as never;
    expect(comfyInputChoices(info, "CheckpointLoaderSimple", "ckpt_name")).toEqual(["a.safetensors", "b.safetensors"]);
    expect(comfyInputChoices(info, "KSampler", "sampler_name")).toEqual(["euler", "dpmpp_2m"]);
    expect(comfyInputChoices(info, "KSampler", "scheduler")).toBeUndefined();
    expect(comfyInputChoices(null, "KSampler", "sampler_name")).toBeUndefined();
});
