import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_PROVIDER_KEY_ENV, codexProviderArgs, codexProviderEnv, codexProviderModels, codexProviderSummary, mergeCodexProvider } from "./codex-provider.js";

test("摘要不返回 Key，地址和模型都填了才算启用", () => {
    assert.deepEqual(codexProviderSummary({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "secret", model: "qwen3" }), { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3", hasKey: true, active: true });
    assert.deepEqual(codexProviderSummary({ baseUrl: "http://127.0.0.1:11434/v1" }), { baseUrl: "http://127.0.0.1:11434/v1", model: "", hasKey: false, active: false });
    assert.deepEqual(codexProviderSummary(undefined), { baseUrl: "", model: "", hasKey: false, active: false });
});

test("合并设置：Key 不传时保留，传空字符串时清除", () => {
    const first = mergeCodexProvider(undefined, { baseUrl: "https://api.example.com/v1/", apiKey: "k", model: " gpt-oss " });
    assert.deepEqual(first, { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "gpt-oss" });
    assert.deepEqual(mergeCodexProvider(first, { model: "glm-4.6" }), { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "glm-4.6" });
    assert.deepEqual(mergeCodexProvider(first, { apiKey: "" }), { baseUrl: "https://api.example.com/v1", model: "gpt-oss" });
    assert.deepEqual(mergeCodexProvider(first, { baseUrl: "", apiKey: "", model: "" }), {});
});

test("拒绝非 http 地址、换行和非字符串", () => {
    assert.throws(() => mergeCodexProvider(undefined, { baseUrl: "file:///etc/passwd" }));
    assert.throws(() => mergeCodexProvider(undefined, { model: "a\"\nmodel_provider=\"openai" }));
    assert.throws(() => mergeCodexProvider(undefined, { apiKey: 1 }));
});

test("启用时生成 -c 覆盖参数，Key 只放环境变量", () => {
    const provider = { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "sk-secret", model: "qwen3:32b" };
    const args = codexProviderArgs(provider);
    assert.deepEqual(args, [
        "-c", 'model_providers.infinite_canvas.name="Infinite Canvas"',
        "-c", 'model_providers.infinite_canvas.base_url="http://127.0.0.1:11434/v1"',
        "-c", 'model_providers.infinite_canvas.wire_api="responses"',
        "-c", `model_providers.infinite_canvas.env_key="${CODEX_PROVIDER_KEY_ENV}"`,
        "-c", 'model_provider="infinite_canvas"',
        "-c", 'model="qwen3:32b"',
    ]);
    assert.ok(!args.join(" ").includes("sk-secret"));
    assert.equal(codexProviderEnv(provider, { PATH: "/bin" })?.[CODEX_PROVIDER_KEY_ENV], "sk-secret");
    // 本地模型不填 Key 时不设置 env_key，也不继承同名环境变量。
    assert.ok(!codexProviderArgs({ ...provider, apiKey: undefined }).join(" ").includes("env_key"));
    assert.equal(codexProviderEnv({ ...provider, apiKey: undefined }, { [CODEX_PROVIDER_KEY_ENV]: "old" })?.[CODEX_PROVIDER_KEY_ENV], undefined);
});

test("值里的引号和反斜杠按 TOML 字符串转义", () => {
    assert.ok(codexProviderArgs({ baseUrl: "http://h/v1", model: 'a"b\\c' }).includes('model="a\\"b\\\\c"'));
});

test("未启用时不改启动参数、环境和模型列表", () => {
    assert.deepEqual(codexProviderArgs(undefined), []);
    assert.deepEqual(codexProviderArgs({ baseUrl: "http://h/v1" }), []);
    assert.equal(codexProviderEnv({ model: "x" }), undefined);
    assert.equal(codexProviderModels(undefined), null);
    assert.equal(codexProviderModels({ baseUrl: "http://h/v1", model: "qwen3" })?.data[0].model, "qwen3");
});
