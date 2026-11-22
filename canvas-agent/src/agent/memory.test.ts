import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentMemoryStore, memoryPromptContext } from "./memory.js";

async function createStore() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    return { file: path.join(directory, "agent-memory.json"), store: new AgentMemoryStore(path.join(directory, "agent-memory.json")) };
}

test("记忆的新增、修改、停用和删除", async () => {
    const { file, store } = await createStore();
    assert.deepEqual(await store.list(), { version: 1, enabled: true, items: [] });
    const { result: item } = await store.add("  默认使用 16:9 画幅  ");
    assert.equal(item.text, "默认使用 16:9 画幅");
    const { result: duplicate } = await store.add("默认使用 16:9 画幅");
    assert.equal(duplicate.id, item.id);
    await store.add("标题用中文");
    assert.match(await store.promptContext(), /1\. 默认使用 16:9 画幅\n2\. 标题用中文/);

    await store.update(item.id, { enabled: false });
    assert.doesNotMatch(await store.promptContext(), /16:9/);
    await store.update(item.id, { text: "默认使用 9:16 画幅", enabled: true });
    assert.match(await store.promptContext(), /9:16/);

    await store.setEnabled(false);
    assert.equal(await store.promptContext(), "");
    await store.setEnabled(true);

    await store.remove(item.id);
    const state = await store.list();
    assert.deepEqual(state.items.map((entry) => entry.text), ["标题用中文"]);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.items.length, 1);
});

test("拒绝空记忆和不存在的记忆", async () => {
    const { store } = await createStore();
    await assert.rejects(store.add("   "), /不能为空/);
    await assert.rejects(store.update("missing", { enabled: false }), (error: Error & { statusCode?: number }) => error.statusCode === 404);
    await assert.rejects(store.remove("missing"), /不存在/);
});

test("并发写入记忆不会丢失", async () => {
    const { store } = await createStore();
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.add(`记忆 ${index}`)));
    assert.equal((await store.list()).items.length, 10);
});

test("没有启用的记忆时不注入提示词", () => {
    assert.equal(memoryPromptContext({ version: 1, enabled: true, items: [] }), "");
    assert.equal(memoryPromptContext({ version: 1, enabled: true, items: [{ id: "a", text: "x", enabled: false, createdAt: 0, updatedAt: 0 }] }), "");
});
