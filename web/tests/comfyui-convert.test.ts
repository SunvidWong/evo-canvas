import { describe, expect, test } from "bun:test";

import { ComfySubgraphError, convertComfyUiWorkflow, isComfyUiWorkflow, type ComfyObjectInfo, type ComfyUiWorkflow } from "../src/services/api/comfyui-convert";

const objectInfo: ComfyObjectInfo = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"]] } }, display_name: "Load Checkpoint" },
    CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } }, display_name: "CLIP Text Encode (Prompt)" },
    EmptyLatentImage: { input: { required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] } } },
    KSampler: {
        input: {
            required: {
                model: ["MODEL"],
                seed: ["INT", { control_after_generate: true }],
                steps: ["INT"],
                cfg: ["FLOAT"],
                sampler_name: [["euler", "dpmpp_2m"]],
                scheduler: [["normal", "karras"]],
                positive: ["CONDITIONING"],
                negative: ["CONDITIONING"],
                latent_image: ["LATENT"],
                denoise: ["FLOAT"],
            },
        },
        input_order: { required: ["model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative", "latent_image", "denoise"] },
    },
    VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } },
    VAEEncode: { input: { required: { pixels: ["IMAGE"], vae: ["VAE"] } } },
    SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } } },
    LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
    LoraLoader: { input: { required: { model: ["MODEL"], clip: ["CLIP"], lora_name: [["detail.safetensors"]], strength_model: ["FLOAT"], strength_clip: ["FLOAT"] } } },
    UNETLoader: { input: { required: { unet_name: [["flux1-dev.safetensors"]], weight_dtype: [["default", "fp8_e4m3fn"]] } } },
    DualCLIPLoader: { input: { required: { clip_name1: [["t5xxl.safetensors"]], clip_name2: [["clip_l.safetensors"]], type: [["flux"]] }, optional: { device: [["default", "cpu"]] } } },
    RandomNoise: { input: { required: { noise_seed: ["INT", { control_after_generate: true }] } } },
    VHS_VideoCombine: {
        input: {
            required: {
                images: ["IMAGE"],
                frame_rate: ["FLOAT"],
                loop_count: ["INT"],
                filename_prefix: ["STRING"],
                format: [
                    ["image/gif", "video/h264-mp4"],
                    {
                        formats: {
                            "video/h264-mp4": [
                                ["pix_fmt", ["yuv420p", "yuv420p10le"]],
                                ["crf", "INT", { default: 19 }],
                                ["save_metadata", "BOOLEAN", { default: true }],
                            ],
                        },
                    },
                ],
            },
            optional: { audio: ["AUDIO"] },
        },
    },
    TextSampler: { input: { required: { text: ["STRING", { forceInput: true }], steps: ["INT"], denoise: ["FLOAT"] } } },
    PrimitiveText: { input: { required: { value: ["STRING"] } } },
};

/** SDXL 文生图：ComfyUI 默认工作流加一个 Note。 */
const sdxl: ComfyUiWorkflow = {
    nodes: [
        { id: 4, type: "CheckpointLoaderSimple", widgets_values: ["sdxl.safetensors"] },
        { id: 6, type: "CLIPTextEncode", inputs: [{ name: "clip", type: "CLIP", link: 3 }], widgets_values: ["a cat"] },
        { id: 7, type: "CLIPTextEncode", title: "Negative", inputs: [{ name: "clip", type: "CLIP", link: 5 }], widgets_values: ["blurry"] },
        { id: 5, type: "EmptyLatentImage", widgets_values: [1024, 1024, 1] },
        {
            id: 3,
            type: "KSampler",
            inputs: [
                { name: "model", type: "MODEL", link: 1 },
                { name: "positive", type: "CONDITIONING", link: 4 },
                { name: "negative", type: "CONDITIONING", link: 6 },
                { name: "latent_image", type: "LATENT", link: 2 },
            ],
            widgets_values: [156680208700286, "randomize", 20, 8, "euler", "normal", 1],
        },
        {
            id: 8,
            type: "VAEDecode",
            inputs: [
                { name: "samples", type: "LATENT", link: 7 },
                { name: "vae", type: "VAE", link: 8 },
            ],
        },
        { id: 9, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 9 }], widgets_values: ["ComfyUI"] },
        { id: 10, type: "Note", widgets_values: ["remember to change the prompt"] },
    ],
    links: [
        [1, 4, 0, 3, 0, "MODEL"],
        [2, 5, 0, 3, 3, "LATENT"],
        [3, 4, 1, 6, 0, "CLIP"],
        [4, 6, 0, 3, 1, "CONDITIONING"],
        [5, 4, 1, 7, 0, "CLIP"],
        [6, 7, 0, 3, 2, "CONDITIONING"],
        [7, 3, 0, 8, 0, "LATENT"],
        [8, 4, 2, 8, 1, "VAE"],
        [9, 8, 0, 9, 0, "IMAGE"],
    ],
};

/** 和 ComfyUI「导出（API）」得到的内容一致。 */
const sdxlApi = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" }, _meta: { title: "Load Checkpoint" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] }, _meta: { title: "CLIP Text Encode (Prompt)" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["4", 1] }, _meta: { title: "Negative" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: "EmptyLatentImage" } },
    "3": {
        class_type: "KSampler",
        inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] },
        _meta: { title: "KSampler" },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] }, _meta: { title: "VAEDecode" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] }, _meta: { title: "SaveImage" } },
};

describe("ComfyUI 普通保存格式转 API 格式", () => {
    test("识别普通保存格式", () => {
        expect(isComfyUiWorkflow(sdxl)).toBe(true);
        expect(isComfyUiWorkflow(sdxlApi)).toBe(false);
        expect(isComfyUiWorkflow(null)).toBe(false);
    });

    test("SDXL 文生图：widgets_values 按定义顺序对应，跳过种子后的控制值，去掉 Note", () => {
        const { workflow, missing } = convertComfyUiWorkflow(sdxl, objectInfo);
        expect(missing).toEqual([]);
        expect(workflow).toEqual(sdxlApi);
    });

    test("图生图：Reroute 穿透、PrimitiveNode 值写入、绕过节点直通、静音节点删除", () => {
        const ui: ComfyUiWorkflow = {
            nodes: [
                { id: 4, type: "CheckpointLoaderSimple", widgets_values: ["sdxl.safetensors"] },
                {
                    id: 20,
                    type: "LoraLoader",
                    mode: 4,
                    inputs: [
                        { name: "model", type: "MODEL", link: 30 },
                        { name: "clip", type: "CLIP", link: 31 },
                    ],
                    widgets_values: ["detail.safetensors", 1, 1],
                },
                { id: 21, type: "Reroute", inputs: [{ name: "", type: "*", link: 32 }] },
                { id: 22, type: "PrimitiveNode", widgets_values: [42, "fixed"] },
                { id: 10, type: "LoadImage", widgets_values: ["photo.png", "image"] },
                {
                    id: 11,
                    type: "VAEEncode",
                    inputs: [
                        { name: "pixels", type: "IMAGE", link: 33 },
                        { name: "vae", type: "VAE", link: 34 },
                    ],
                },
                { id: 6, type: "CLIPTextEncode", inputs: [{ name: "clip", type: "CLIP", link: 35 }], widgets_values: ["oil painting"] },
                {
                    id: 3,
                    type: "KSampler",
                    inputs: [
                        { name: "model", type: "MODEL", link: 36 },
                        { name: "positive", type: "CONDITIONING", link: 37 },
                        { name: "negative", type: "CONDITIONING", link: 38 },
                        { name: "latent_image", type: "LATENT", link: 39 },
                        { name: "seed", type: "INT", link: 40, widget: { name: "seed" } },
                    ],
                    widgets_values: [1, "fixed", 25, 6.5, "dpmpp_2m", "karras", 0.6],
                },
                {
                    id: 8,
                    type: "VAEDecode",
                    inputs: [
                        { name: "samples", type: "LATENT", link: 41 },
                        { name: "vae", type: "VAE", link: 42 },
                    ],
                },
                { id: 9, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 43 }], widgets_values: ["i2i"] },
                { id: 12, type: "SaveImage", mode: 2, inputs: [{ name: "images", type: "IMAGE", link: 44 }], widgets_values: ["muted"] },
            ],
            links: [
                [30, 4, 0, 20, 0, "MODEL"],
                [31, 4, 1, 20, 1, "CLIP"],
                [32, 4, 2, 21, 0, "VAE"],
                [33, 10, 0, 11, 0, "IMAGE"],
                [34, 21, 0, 11, 1, "VAE"],
                [35, 20, 1, 6, 0, "CLIP"],
                [36, 20, 0, 3, 0, "MODEL"],
                [37, 6, 0, 3, 1, "CONDITIONING"],
                [38, 6, 0, 3, 2, "CONDITIONING"],
                [39, 11, 0, 3, 3, "LATENT"],
                [40, 22, 0, 3, 4, "INT"],
                [41, 3, 0, 8, 0, "LATENT"],
                [42, 21, 0, 8, 1, "VAE"],
                [43, 8, 0, 9, 0, "IMAGE"],
                [44, 8, 0, 12, 0, "IMAGE"],
            ],
        };
        const { workflow, missing } = convertComfyUiWorkflow(ui, objectInfo);
        expect(missing).toEqual([]);
        expect(Object.keys(workflow).sort()).toEqual(["10", "11", "3", "4", "6", "8", "9"]);
        expect(workflow["10"].inputs).toEqual({ image: "photo.png" });
        expect(workflow["11"].inputs).toEqual({ pixels: ["10", 0], vae: ["4", 2] });
        expect(workflow["6"].inputs).toEqual({ text: "oil painting", clip: ["4", 1] });
        expect(workflow["3"].inputs).toEqual({ seed: 42, steps: 25, cfg: 6.5, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 0.6, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["11", 0] });
        expect(workflow["8"].inputs).toEqual({ samples: ["3", 0], vae: ["4", 2] });
    });

    test("Flux 和视频节点：可选输入、noise_seed 控制值、字典格式的 widgets_values", () => {
        const ui: ComfyUiWorkflow = {
            nodes: [
                { id: 1, type: "UNETLoader", widgets_values: ["flux1-dev.safetensors", "fp8_e4m3fn"] },
                { id: 2, type: "DualCLIPLoader", widgets_values: ["t5xxl.safetensors", "clip_l.safetensors", "flux", "default"] },
                { id: 3, type: "RandomNoise", widgets_values: [123, "randomize"] },
                {
                    id: 4,
                    type: "VHS_VideoCombine",
                    inputs: [
                        { name: "images", type: "IMAGE", link: null },
                        { name: "audio", type: "AUDIO", link: null },
                    ],
                    widgets_values: { frame_rate: 8, loop_count: 0, filename_prefix: "clip", format: "video/h264-mp4", pix_fmt: "yuv420p10le", crf: 35, save_metadata: true, videopreview: { hidden: false } },
                },
            ],
            links: [],
        };
        const { workflow } = convertComfyUiWorkflow(ui, objectInfo);
        expect(workflow["1"].inputs).toEqual({ unet_name: "flux1-dev.safetensors", weight_dtype: "fp8_e4m3fn" });
        expect(workflow["2"].inputs).toEqual({ clip_name1: "t5xxl.safetensors", clip_name2: "clip_l.safetensors", type: "flux", device: "default" });
        expect(workflow["3"].inputs).toEqual({ noise_seed: 123 });
        expect(workflow["4"].inputs).toEqual({ frame_rate: 8, loop_count: 0, filename_prefix: "clip", format: "video/h264-mp4", pix_fmt: "yuv420p10le", crf: 35, save_metadata: true });
    });

    test("forceInput 的参数不占 widgets_values 的位置", () => {
        const { workflow } = convertComfyUiWorkflow(
            {
                nodes: [
                    { id: 1, type: "PrimitiveText", widgets_values: ["hello"] },
                    { id: 2, type: "TextSampler", inputs: [{ name: "text", type: "STRING", link: 1 }], widgets_values: [20, 0.7] },
                ],
                links: [[1, 1, 0, 2, 0, "STRING"]],
            },
            objectInfo,
        );
        expect(workflow["2"].inputs).toEqual({ text: ["1", 0], steps: 20, denoise: 0.7 });
    });

    test("列出没安装的节点，子图直接报错", () => {
        const { missing } = convertComfyUiWorkflow({ nodes: [...sdxl.nodes, { id: 30, type: "KreaSampler" }, { id: 31, type: "KreaSampler" }], links: sdxl.links }, objectInfo);
        expect(missing).toEqual(["KreaSampler"]);
        expect(() => convertComfyUiWorkflow({ ...sdxl, definitions: { subgraphs: [{ id: "x" }] } }, objectInfo)).toThrow(ComfySubgraphError);
    });
});
