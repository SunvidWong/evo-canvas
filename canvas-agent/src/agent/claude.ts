import crypto from "node:crypto";

import { createSdkMcpServer, deleteSession, getSessionInfo, getSessionMessages, listSessions, query, tool, type SDKMessage, type SDKUserMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { toolDescriptions, toolInputSchemas, toolNames } from "../canvas/schemas.js";
import { AGENT_PROMPT } from "../config.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
import { codexEventHistory } from "./codex-event-history.js";
import { threadMessages, type CodexSupplementalHistoryTurn } from "./codex-history.js";
import { messageMetadataStore } from "./message-metadata.js";
import type { AgentAttachment, AgentEmit } from "./types.js";

export const CLAUDE_MCP_SERVER = "infinite-canvas";
const MCP_PREFIX = `mcp__${CLAUDE_MCP_SERVER}__`;

type JsonRecord = Record<string, unknown>;
type ToolItem = { id: string; type: string; server: string; tool: string; arguments: unknown; status: string; result?: unknown; error?: { message: string } };
type HistoryItem = JsonRecord & { id: string; type: string };
type HistoryTurn = { id: string; status: string; items: HistoryItem[]; error?: { message: string }; messageText?: string };
type TurnStatus = "completed" | "failed" | "interrupted";
/** 只需持久化 Claude 会话记录里看不出来的失败、中断终态。 */
type TurnHistoryStore = Pick<typeof codexEventHistory, "recordTurn">;

export type ClaudeTurnOptions = {
    threadId: string;
    turnId: string;
    cwd: string;
    prompt: string;
    /** 用户在输入框里看到的文本；prompt 里还带有画布引用等上下文，历史里显示这一份。 */
    messageText?: string;
    attachments?: AgentAttachment[];
    /** 执行画布工具；与 Codex 走同一个 CanvasSession.callTool。 */
    callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
    emit: AgentEmit;
    onFinish?: () => void;
};

let running: { threadId: string; turnId: string; abort: AbortController } | null = null;

/** 当前正在运行的 Claude turn。 */
export function runningClaudeTurn() {
    return running ? { threadId: running.threadId, turnId: running.turnId } : null;
}

/** 使用 Claude Agent SDK 执行一轮对话：同一 threadId 续用同一 Claude 会话，并注入 infinite-canvas 工具。 */
export async function runClaudeTurn(options: ClaudeTurnOptions) {
    const { threadId, turnId, cwd, emit } = options;
    const abort = new AbortController();
    running = { threadId, turnId, abort };
    const mapper = new ClaudeEventMapper(emit);
    mapper.start();
    try {
        const exists = Boolean(await getSessionInfo(threadId, { dir: cwd }).catch(() => undefined));
        const stream = query({
            prompt: userInput(options),
            options: {
                cwd,
                abortController: abort,
                ...(exists ? { resume: threadId } : { sessionId: threadId }),
                includePartialMessages: true,
                // 只开放画布工具，不加载用户本机的 Claude 设置、文件和命令行工具。
                tools: [],
                settingSources: [],
                mcpServers: { [CLAUDE_MCP_SERVER]: canvasMcpServer(options.callTool) },
                allowedTools: [`${MCP_PREFIX}*`],
                systemPrompt: { type: "preset", preset: "claude_code", append: AGENT_PROMPT },
                stderr: (text) => emit("agent_log", { text }),
            },
        });
        for await (const message of stream) mapper.handle(message);
        mapper.settle(abort.signal.aborted ? "interrupted" : "completed");
    } catch (error) {
        if (abort.signal.aborted) mapper.settle("interrupted");
        else {
            logger.warn("Claude turn failed", { threadId, turnId, error });
            mapper.settle("failed", claudeErrorMessage(error));
        }
    }
    try {
        // 先保存终态再通知网页，避免网页收到 turn.completed 后同步历史时读到旧状态。
        await persistTurnOutcome(threadId, turnId, mapper.outcome, options.messageText);
        mapper.complete();
    } finally {
        if (running?.turnId === turnId) running = null;
        options.onFinish?.();
    }
}

/** Claude 会话记录不保存失败、中断和用户看到的原始输入，写入补充历史，读取时恢复。 */
export async function persistTurnOutcome(threadId: string, turnId: string, outcome: { status: TurnStatus; error: string }, messageText = "", store: TurnHistoryStore = codexEventHistory) {
    if (outcome.status === "completed" && !messageText) return;
    const turn = { id: turnId, status: outcome.status, ...(outcome.error ? { error: { message: outcome.error } } : {}), ...(messageText ? { messageText } : {}) };
    await store.recordTurn({ threadId, turnId, turn }).catch((error) => logger.warn("Failed to persist Claude turn outcome", { threadId, turnId, error }));
}

/** 用补充历史里的终态覆盖从会话记录推断出的 completed。 */
export function applyTurnOutcomes(turns: HistoryTurn[], outcomes: CodexSupplementalHistoryTurn[]) {
    const byId = new Map(outcomes.map((entry) => [entry.turnId, entry.turn]));
    return turns.map((turn) => {
        const outcome = byId.get(turn.id);
        if (!outcome || turn.status === "inProgress") return turn;
        const message = String((outcome.error as JsonRecord | undefined)?.message || "");
        const messageText = String(outcome.messageText || "");
        return { ...turn, status: String(outcome.status || turn.status), ...(message ? { error: { message } } : {}), ...(messageText ? { messageText } : {}) };
    });
}

/** 中断正在运行的 Claude turn。 */
export function interruptClaudeTurn(threadId?: string) {
    if (!running || (threadId && running.threadId !== threadId)) return false;
    running.abort.abort();
    return true;
}

/** 列出当前工作空间的 Claude 会话，字段与 Codex 线程摘要一致。 */
export async function listClaudeThreads(cwd: string) {
    const sessions = await listSessions({ dir: cwd, limit: 40 });
    const data = sessions
        .filter((item) => !item.archived)
        .map((item) => ({
            id: item.sessionId,
            sessionId: item.sessionId,
            preview: item.firstPrompt || "",
            name: item.customTitle || item.summary || null,
            cwd: item.cwd || cwd,
            status: "",
            createdAt: Math.floor((item.createdAt || item.lastModified) / 1000),
            updatedAt: Math.floor(item.lastModified / 1000),
        }));
    return { data, nextCursor: null, backwardsCursor: null };
}

/** 读取 Claude 会话历史，转换成与 Codex 相同的聊天消息结构。 */
export async function readClaudeThread(threadId: string, cwd: string) {
    const current = runningClaudeTurn();
    const [sessionMessages, supplemental] = await Promise.all([getSessionMessages(threadId, { dir: cwd }), codexEventHistory.readThread(threadId).catch(() => ({ items: [], turns: [] }))]);
    const turns = applyTurnOutcomes(claudeHistoryTurns(sessionMessages, current?.threadId === threadId ? current.turnId : ""), supplemental.turns);
    const raw = threadMessages({ id: threadId, turns }).map((item) => (item.role === "assistant" ? { ...item, title: "Claude" } : item));
    const messages = await messageMetadataStore.mergeThread(threadId, raw).catch((error) => {
        logger.warn("Failed to read Claude message metadata", { threadId, error });
        return raw;
    });
    const settledTurnIds = turns.filter((turn) => turn.status !== "inProgress").map((turn) => turn.id);
    return { thread: { id: threadId, sessionId: threadId, preview: "", name: null, cwd, status: "", createdAt: 0, updatedAt: 0 }, messages, settledTurnIds, historyReady: true };
}

/** 删除 Claude 会话及其消息元数据。 */
export async function deleteClaudeThread(threadId: string, cwd: string) {
    await deleteSession(threadId, { dir: cwd }).catch((error) => {
        if (!/not found/i.test(errorMessage(error))) throw error;
    });
    await messageMetadataStore.removeThread(threadId).catch((error) => logger.warn("Failed to remove Claude message metadata", { threadId, error }));
    await codexEventHistory.removeThread(threadId).catch((error) => logger.warn("Failed to remove Claude turn history", { threadId, error }));
}

/** 生成新 Claude 会话 ID；首轮用它创建会话，之后用它续用。 */
export function newClaudeThreadId() {
    return crypto.randomUUID();
}

/** 构造本轮用户消息：文本加图片附件，uuid 即 turnId，便于历史和实时事件对齐。 */
async function* userInput(options: ClaudeTurnOptions): AsyncGenerator<SDKUserMessage> {
    const images = (options.attachments || []).flatMap((item) => {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(item.dataUrl || "");
        return match ? [{ type: "image" as const, source: { type: "base64" as const, media_type: match[1] as "image/png", data: match[2] } }] : [];
    });
    yield {
        type: "user",
        uuid: options.turnId as SDKUserMessage["uuid"],
        session_id: options.threadId,
        parent_tool_use_id: null,
        message: { role: "user", content: images.length ? [{ type: "text", text: options.prompt }, ...images] : options.prompt },
    };
}

/** 把画布工具注册成进程内 MCP 服务，直接调用 CanvasSession。 */
function canvasMcpServer(callTool: ClaudeTurnOptions["callTool"]) {
    return createSdkMcpServer({
        name: CLAUDE_MCP_SERVER,
        tools: toolNames.map((name) =>
            tool(name, toolDescriptions[name], toolInputSchemas[name].shape, async (input) => {
                try {
                    const result = await callTool(name, input as Record<string, unknown>);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                } catch (error) {
                    return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
                }
            }),
        ),
    });
}

/** 把 Claude SDK 消息流转换为与 Codex 相同的 agent_event：turn.*、item.started/updated/completed、usage.updated。 */
export class ClaudeEventMapper {
    private readonly blockIndex = new Map<string, number>();
    private readonly streamBlocks = new Map<number, { id: string; type: string }>();
    private readonly tools = new Map<string, ToolItem>();
    private messageId = "";
    private settled = false;
    private completed = false;
    /** 本轮终态；settle 之后才有意义。 */
    outcome: { status: TurnStatus; error: string } = { status: "completed", error: "" };

    constructor(private readonly emit: AgentEmit) {}

    start() {
        this.event("turn.started", {});
    }

    handle(message: SDKMessage) {
        if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;
        if (message.type === "stream_event") return this.handleStream(message.event as unknown as JsonRecord);
        if (message.type === "assistant") return this.handleAssistant(message.message as unknown as JsonRecord);
        if (message.type === "user") return this.handleToolResults(message.message as unknown as JsonRecord);
        if (message.type === "result") {
            const usage = message.usage as unknown as JsonRecord | undefined;
            if (usage) this.event("usage.updated", { usage: { input_tokens: num(usage.input_tokens), cached_input_tokens: num(usage.cache_read_input_tokens), output_tokens: num(usage.output_tokens) } });
            if (message.subtype !== "success" || message.is_error) {
                const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("\n") : "";
                const result = "result" in message ? String(message.result || "") : "";
                this.settle("failed", errors || result || `Claude 运行失败（${message.subtype}）`);
            }
        }
    }

    /** 确定本轮终态并关闭未完成的工具；只有第一次调用生效。 */
    settle(status: TurnStatus, error = "") {
        if (this.settled) return;
        this.settled = true;
        this.outcome = { status, error };
        this.tools.forEach((item) => this.event("item.completed", { item: { ...item, status: status === "completed" ? "interrupted" : status, ...(status === "failed" && error ? { error: { message: error } } : {}) } }));
        this.tools.clear();
    }

    /** 发出唯一一次 turn.completed。 */
    complete() {
        if (this.completed) return;
        this.settle("completed");
        this.completed = true;
        const { status, error } = this.outcome;
        this.event("turn.completed", { status, ...(error ? { error: { message: error } } : {}) });
    }

    finish(status: TurnStatus, error = "") {
        this.settle(status, error);
        this.complete();
    }

    private handleStream(event: JsonRecord) {
        if (event.type === "message_start") {
            this.messageId = String((event.message as JsonRecord | undefined)?.id || "");
            this.streamBlocks.clear();
            return;
        }
        const index = Number(event.index);
        if (event.type === "content_block_start" && this.messageId) {
            const block = (event.content_block || {}) as JsonRecord;
            const id = block.type === "tool_use" ? String(block.id || "") : `${this.messageId}:${index}`;
            if (block.type === "text") this.event("item.started", { item: { id, type: "agent_message", text: "" } });
            else if (block.type === "thinking") this.event("item.started", { item: { id, type: "reasoning", summary: [] } });
            else if (block.type === "tool_use") this.event("item.started", { item: toolItem(block, {}, "inProgress") });
            else return;
            this.streamBlocks.set(index, { id, type: String(block.type) });
            return;
        }
        if (event.type === "content_block_delta") {
            const block = this.streamBlocks.get(index);
            const delta = (event.delta || {}) as JsonRecord;
            if (block?.type === "text" && delta.type === "text_delta") this.event("item.updated", { item: { id: block.id, type: "agent_message", delta: String(delta.text || "") } });
            if (block?.type === "thinking" && delta.type === "thinking_delta") this.event("item.updated", { item: { id: block.id, type: "reasoning", delta: String(delta.thinking || "") } });
        }
    }

    private handleAssistant(message: JsonRecord) {
        const messageId = String(message.id || "");
        contentBlocks(message.content).forEach((block) => {
            const index = nextBlockIndex(this.blockIndex, messageId);
            const id = `${messageId}:${index}`;
            if (block.type === "text") this.event("item.completed", { item: { id, type: "agent_message", text: String(block.text || "") } });
            if (block.type === "thinking") this.event("item.completed", { item: { id, type: "reasoning", summary: [String(block.thinking || "")] } });
            if (block.type === "tool_use") {
                const item = toolItem(block, block.input, "inProgress");
                this.tools.set(item.id, item);
                this.event("item.updated", { item });
            }
        });
    }

    private handleToolResults(message: JsonRecord) {
        contentBlocks(message.content).forEach((block) => {
            if (block.type !== "tool_result") return;
            const id = String(block.tool_use_id || "");
            const item = this.tools.get(id);
            if (!item) return;
            this.tools.delete(id);
            this.event("item.completed", { item: withToolResult(item, block) });
        });
    }

    private event(type: string, payload: JsonRecord) {
        this.emit("agent_event", { agent: "claude", type, ...payload });
    }
}

/** 将 Claude 会话记录按用户消息切分成与 Codex 相同的 turn/item 结构，供 threadMessages 复用。 */
export function claudeHistoryTurns(messages: SessionMessage[], runningTurnId = ""): HistoryTurn[] {
    const turns: HistoryTurn[] = [];
    const blockIndex = new Map<string, number>();
    const tools = new Map<string, ToolItem>();
    messages.forEach((entry) => {
        if (entry.parent_tool_use_id) return;
        const message = (entry.message || {}) as JsonRecord;
        const blocks = contentBlocks(message.content);
        if (entry.type === "user") {
            const results = blocks.filter((block) => block.type === "tool_result");
            if (results.length) {
                results.forEach((block) => {
                    const item = tools.get(String(block.tool_use_id || ""));
                    if (item) Object.assign(item, withToolResult(item, block));
                });
                return;
            }
            const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : blocks;
            turns.push({ id: entry.uuid, status: entry.uuid === runningTurnId ? "inProgress" : "completed", items: [{ id: entry.uuid, type: "userMessage", content }] });
            return;
        }
        const turn = turns[turns.length - 1];
        if (entry.type !== "assistant" || !turn) return;
        const messageId = String(message.id || entry.uuid);
        blocks.forEach((block) => {
            const id = `${messageId}:${nextBlockIndex(blockIndex, messageId)}`;
            if (block.type === "text" && String(block.text || "").trim()) turn.items.push({ id, type: "agentMessage", text: String(block.text) });
            if (block.type === "thinking" && String(block.thinking || "").trim()) turn.items.push({ id, type: "reasoning", summary: [String(block.thinking)] });
            if (block.type === "tool_use") {
                // 历史记录沿用 Codex 原生条目类型名，交给 threadMessages 统一转换。
                const item = { ...toolItem(block, block.input, turn.status === "inProgress" ? "inProgress" : "interrupted"), type: "mcpToolCall" };
                tools.set(item.id, item);
                turn.items.push(item as unknown as HistoryItem);
            }
        });
    });
    return turns;
}

function toolItem(block: JsonRecord, input: unknown, status: string): ToolItem {
    const name = String(block.name || "");
    const local = name.startsWith(MCP_PREFIX);
    return { id: String(block.id || ""), type: "mcp_tool_call", server: local ? CLAUDE_MCP_SERVER : "", tool: local ? name.slice(MCP_PREFIX.length) : name, arguments: input && typeof input === "object" ? input : {}, status };
}

function withToolResult(item: ToolItem, block: JsonRecord): ToolItem {
    const content = typeof block.content === "string" ? [{ type: "text", text: block.content }] : contentBlocks(block.content).filter((part) => part.type === "text");
    const text = content.map((part) => String(part.text || "")).join("\n");
    return block.is_error ? { ...item, status: "failed", error: { message: text || "工具调用失败" } } : { ...item, status: "completed", result: { content } };
}

function contentBlocks(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object") : [];
}

/** 同一条 API 消息可能被拆成多条记录，按出现顺序累计内容块序号，实时与历史得到相同 ID。 */
function nextBlockIndex(counter: Map<string, number>, messageId: string) {
    const index = counter.get(messageId) || 0;
    counter.set(messageId, index + 1);
    return index;
}

function num(value: unknown) {
    return Number(value) || 0;
}

function claudeErrorMessage(error: unknown) {
    const text = errorMessage(error);
    if (/ENOENT|not found|spawn/i.test(text)) return `无法启动 Claude Code：${text}`;
    if (/auth|login|credential|api key|401/i.test(text)) return `Claude Code 未登录或凭据无效，请先在终端运行 claude 并登录：${text}`;
    return `Claude 运行失败：${text}`;
}
