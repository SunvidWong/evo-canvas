import assert from "node:assert/strict";
import test from "node:test";

import { claudeProviderEnv, claudeProviderSummary, mergeClaudeProvider } from "./claude-provider.js";

test("摘要不返回 Token 本身", () => {
    assert.deepEqual(claudeProviderSummary({ baseUrl: "https://api.example.com/anthropic", authToken: "secret", model: "glm-4.6" }), { baseUrl: "https://api.example.com/anthropic", model: "glm-4.6", hasToken: true });
    assert.deepEqual(claudeProviderSummary(undefined), { baseUrl: "", model: "", hasToken: false });
});

test("合并设置：Token 不传时保留，传空字符串时清除，地址去掉末尾斜杠", () => {
    const first = mergeClaudeProvider(undefined, { baseUrl: "http://127.0.0.1:4000/", authToken: "tok", model: " qwen3 " });
    assert.deepEqual(first, { baseUrl: "http://127.0.0.1:4000", authToken: "tok", model: "qwen3" });
    assert.deepEqual(mergeClaudeProvider(first, { model: "kimi-k2" }), { baseUrl: "http://127.0.0.1:4000", authToken: "tok", model: "kimi-k2" });
    assert.deepEqual(mergeClaudeProvider(first, { authToken: "" }), { baseUrl: "http://127.0.0.1:4000", model: "qwen3" });
    assert.deepEqual(mergeClaudeProvider(first, { baseUrl: "", authToken: "", model: "" }), {});
});

test("拒绝非 http 地址、换行和非字符串", () => {
    assert.throws(() => mergeClaudeProvider(undefined, { baseUrl: "file:///etc/passwd" }));
    assert.throws(() => mergeClaudeProvider(undefined, { baseUrl: "javascript:alert(1)" }));
    assert.throws(() => mergeClaudeProvider(undefined, { authToken: "a\nANTHROPIC_BASE_URL=x" }));
    assert.throws(() => mergeClaudeProvider(undefined, { model: 42 }));
    assert.throws(() => mergeClaudeProvider(undefined, { model: "x".repeat(201) }));
});

test("没有自定义设置时不改子进程环境", () => {
    assert.equal(claudeProviderEnv(undefined), undefined);
    assert.equal(claudeProviderEnv({}), undefined);
});

test("注入地址、Token 和模型，保留其他环境变量并移除 API Key", () => {
    const env = claudeProviderEnv({ baseUrl: "https://api.deepseek.com/anthropic", authToken: "sk-x", model: "deepseek-chat" }, { PATH: "/bin", ANTHROPIC_API_KEY: "official" });
    assert.equal(env?.PATH, "/bin");
    assert.equal(env?.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "sk-x");
    assert.equal("ANTHROPIC_API_KEY" in (env || {}), false);
    assert.equal(env?.ANTHROPIC_MODEL, "deepseek-chat");
    assert.equal(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-chat");
    const onlyModel = claudeProviderEnv({ model: "claude-x" }, { ANTHROPIC_API_KEY: "keep" });
    assert.equal(onlyModel?.ANTHROPIC_API_KEY, "keep");
});

test("换成第三方地址时不带官方凭据，即使没填 Token", () => {
    const env = claudeProviderEnv({ baseUrl: "http://127.0.0.1:4000" }, { ANTHROPIC_API_KEY: "official", CLAUDE_CODE_OAUTH_TOKEN: "oauth", PATH: "/bin" });
    assert.equal("ANTHROPIC_API_KEY" in (env || {}), false);
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in (env || {}), false);
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "none");
    assert.equal(env?.ANTHROPIC_MODEL, undefined);
    assert.equal(env?.PATH, "/bin");
});

test("换成第三方地址时去掉带凭据的自定义请求头和云厂商路由", () => {
    const base = { ANTHROPIC_CUSTOM_HEADERS: "x-api-key: official", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", PATH: "/bin" };
    const env = claudeProviderEnv({ baseUrl: "http://127.0.0.1:4000" }, base);
    for (const key of ["ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) assert.equal(key in (env || {}), false);
    // 只换模型时仍走原来的路由，不动这些设置。
    assert.equal(claudeProviderEnv({ model: "x" }, base)?.CLAUDE_CODE_USE_BEDROCK, "1");
});
