import assert from "node:assert/strict";
import test from "node:test";

import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { applyTurnOutcomes, ClaudeEventMapper, claudeHistoryTurns, persistTurnOutcome } from "./claude.js";
import type { CodexSupplementalHistoryTurn } from "./codex-history.js";
import { threadMessages } from "./codex-history.js";

const toolUse = { type: "tool_use", id: "toolu_1", name: "mcp__infinite-canvas__canvas_apply_ops", input: { ops: [] } };

function liveEvents(messages: unknown[]) {
    const events: Array<Record<string, any>> = [];
    const mapper = new ClaudeEventMapper((type, payload) => type === "agent_event" && events.push(payload as Record<string, any>));
    mapper.start();
    messages.forEach((message) => mapper.handle(message as SDKMessage));
    mapper.finish("completed");
    return events;
}

const streamAndMessages = [
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_a" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的" } } },
    { type: "assistant", message: { id: "msg_a", content: [{ type: "text", text: "好的" }] } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: toolUse } },
    { type: "assistant", message: { id: "msg_a", content: [toolUse] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{\"nodes\":[]}" }] }] } },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg_b" } } },
    { type: "assistant", message: { id: "msg_b", content: [{ type: "text", text: "完成" }] } },
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 } },
];

test("Claude 消息流转换为与 Codex 相同的 turn 和 item 事件", () => {
    const events = liveEvents(streamAndMessages);
    assert.deepEqual(events.map((event) => `${event.type}${event.item ? `:${event.item.type}:${event.item.id}` : ""}`), [
        "turn.started",
        "item.started:agent_message:msg_a:0",
        "item.updated:agent_message:msg_a:0",
        "item.completed:agent_message:msg_a:0",
        "item.started:mcp_tool_call:toolu_1",
        "item.updated:mcp_tool_call:toolu_1",
        "item.completed:mcp_tool_call:toolu_1",
        "item.completed:agent_message:msg_b:0",
        "usage.updated",
        "turn.completed",
    ]);
    const tool = events.find((event) => event.type === "item.completed" && event.item.type === "mcp_tool_call")!.item;
    assert.equal(tool.tool, "canvas_apply_ops");
    assert.equal(tool.status, "completed");
    assert.deepEqual(events.find((event) => event.type === "usage.updated")!.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 });
    assert.equal(events.at(-1)!.status, "completed");
});

test("Claude 执行失败时 turn 以 failed 结束，未完成的工具标记为失败", () => {
    const events = liveEvents([
        { type: "assistant", message: { id: "msg_a", content: [toolUse] } },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] },
    ]);
    const tool = events.find((event) => event.type === "item.completed")!.item;
    assert.equal(tool.status, "failed");
    assert.equal(events.at(-1)!.status, "failed");
    assert.equal(events.at(-1)!.error.message, "boom");
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
});

test("Claude 历史记录的消息 ID 与实时事件一致", () => {
    const entry = (type: SessionMessage["type"], uuid: string, message: unknown): SessionMessage => ({ type, uuid, session_id: "s1", message, parent_tool_use_id: null, parent_agent_id: null });
    const turns = claudeHistoryTurns([
        entry("user", "turn-1", { role: "user", content: "整理画布" }),
        entry("assistant", "a1", { id: "msg_a", content: [{ type: "text", text: "好的" }] }),
        entry("assistant", "a2", { id: "msg_a", content: [toolUse] }),
        entry("user", "r1", { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"nodes\":[]}" }] }),
        entry("assistant", "a3", { id: "msg_b", content: [{ type: "text", text: "完成" }] }),
        entry("user", "turn-2", { role: "user", content: "再来" }),
    ], "turn-2");
    assert.deepEqual(turns.map((turn) => [turn.id, turn.status]), [["turn-1", "completed"], ["turn-2", "inProgress"]]);
    const messages = threadMessages({ id: "s1", turns });
    assert.deepEqual(messages.map((message) => message.id), ["s1:turn-1:synthetic:user", "s1:turn-1:msg_a:0", "s1:turn-1:toolu_1", "s1:turn-1:msg_b:0"]);
    const live = liveEvents(streamAndMessages).filter((event) => event.type === "item.completed").map((event) => event.item.id);
    assert.deepEqual(live, ["msg_a:0", "toolu_1", "msg_b:0"]);
    assert.equal(messages.find((message) => message.itemId === "toolu_1")!.role, "tool");
});

test("Claude 失败的 turn 刷新后仍保留失败状态和错误提示", async () => {
    const recorded: CodexSupplementalHistoryTurn[] = [];
    const store = { recordTurn: async (entry: CodexSupplementalHistoryTurn) => void recorded.push(entry) };
    await persistTurnOutcome("s1", "turn-1", { status: "completed", error: "" }, "", store);
    assert.equal(recorded.length, 0);
    await persistTurnOutcome("s1", "turn-1", { status: "failed", error: "Claude 运行失败：网络断开" }, "", store);
    const entry = (type: SessionMessage["type"], uuid: string, message: unknown): SessionMessage => ({ type, uuid, session_id: "s1", message, parent_tool_use_id: null, parent_agent_id: null });
    const turns = applyTurnOutcomes(claudeHistoryTurns([entry("user", "turn-1", { role: "user", content: "整理画布" })]), recorded);
    assert.deepEqual(turns.map((turn) => [turn.id, turn.status]), [["turn-1", "failed"]]);
    const error = threadMessages({ id: "s1", turns }).find((message) => message.role === "error")!;
    assert.equal(error.id, "s1:turn-1:synthetic:error");
    assert.equal(error.text, "Claude 运行失败：网络断开");
});

test("Claude turn 在保存终态后才发出 turn.completed", () => {
    const events: Array<Record<string, any>> = [];
    const mapper = new ClaudeEventMapper((type, payload) => type === "agent_event" && events.push(payload as Record<string, any>));
    mapper.start();
    mapper.handle({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] } as unknown as SDKMessage);
    mapper.settle("completed");
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.deepEqual(mapper.outcome, { status: "failed", error: "boom" });
    mapper.complete();
    mapper.complete();
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
});

test("Claude 历史显示用户输入的原文，而不是带画布上下文的完整提示词", async () => {
    const recorded: CodexSupplementalHistoryTurn[] = [];
    const store = { recordTurn: async (entry: CodexSupplementalHistoryTurn) => void recorded.push(entry) };
    await persistTurnOutcome("s1", "turn-1", { status: "completed", error: "" }, "总结 @文本1", store);
    const entry = (type: SessionMessage["type"], uuid: string, message: unknown): SessionMessage => ({ type, uuid, session_id: "s1", message, parent_tool_use_id: null, parent_agent_id: null });
    const turns = applyTurnOutcomes(claudeHistoryTurns([entry("user", "turn-1", { role: "user", content: "总结 @文本1\n\n本轮引用的当前画布素材：……" })]), recorded);
    assert.equal(turns[0]!.status, "completed");
    const user = threadMessages({ id: "s1", turns }).find((message) => message.role === "user")!;
    assert.equal(user.text, "总结 @文本1");
});
