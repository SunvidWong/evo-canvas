import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../config.js";

/** 一条本地记忆；enabled 为 false 时保留但不注入对话。 */
export type AgentMemoryItem = { id: string; text: string; enabled: boolean; createdAt: number; updatedAt: number };
/** 记忆列表与总开关；enabled 为 false 时所有记忆都不注入对话。 */
export type AgentMemoryState = { version: 1; enabled: boolean; items: AgentMemoryItem[] };

const MEMORY_FILE = path.join(CONFIG_DIR, "agent-memory.json");

export class AgentMemoryError extends Error {
    constructor(message: string, readonly statusCode = 400) {
        super(message);
        this.name = "AgentMemoryError";
    }
}

/** 全局共享的 Agent 记忆，保存在本机配置目录，所有画布和会话共用。 */
export class AgentMemoryStore {
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private file = MEMORY_FILE) {}

    list() {
        return this.run(() => this.read());
    }

    add(text: unknown) {
        return this.mutate((state) => {
            const value = memoryText(text);
            const existing = state.items.find((item) => item.text === value);
            if (existing) return existing;
            const now = Date.now();
            const item: AgentMemoryItem = { id: crypto.randomUUID(), text: value, enabled: true, createdAt: now, updatedAt: now };
            state.items.push(item);
            return item;
        });
    }

    update(id: string, patch: { text?: unknown; enabled?: unknown }) {
        return this.mutate((state) => {
            const item = state.items.find((entry) => entry.id === id);
            if (!item) throw new AgentMemoryError("记忆不存在", 404);
            if (patch.text !== undefined) item.text = memoryText(patch.text);
            if (patch.enabled !== undefined) item.enabled = Boolean(patch.enabled);
            item.updatedAt = Date.now();
            return item;
        });
    }

    remove(id: string) {
        return this.mutate((state) => {
            const index = state.items.findIndex((entry) => entry.id === id);
            if (index < 0) throw new AgentMemoryError("记忆不存在", 404);
            state.items.splice(index, 1);
            return { id };
        });
    }

    setEnabled(enabled: unknown) {
        return this.mutate((state) => {
            state.enabled = Boolean(enabled);
            return { enabled: state.enabled };
        });
    }

    /** 生成追加到本轮提示词的记忆说明；没有启用的记忆时返回空字符串。 */
    async promptContext() {
        const state = await this.list();
        return memoryPromptContext(state);
    }

    private mutate<T>(change: (state: AgentMemoryState) => T) {
        return this.run(async () => {
            const state = await this.read();
            const result = change(state);
            await writeState(this.file, state);
            return { result: structuredClone(result), state };
        });
    }

    private run<T>(task: () => Promise<T>) {
        const next = this.queue.then(task, task);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async read(): Promise<AgentMemoryState> {
        try {
            const value = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<AgentMemoryState>;
            const items = Array.isArray(value.items) ? value.items.filter(isMemoryItem) : [];
            return { version: 1, enabled: value.enabled !== false, items };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, enabled: true, items: [] };
            throw error;
        }
    }
}

/** 把启用的记忆整理为提示词片段。 */
export function memoryPromptContext(state: AgentMemoryState) {
    if (!state.enabled) return "";
    const items = state.items.filter((item) => item.enabled);
    if (!items.length) return "";
    const list = items.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
    return `用户确认保存的长期记忆（偏好与约定，回答和操作时遵守；与本轮用户要求冲突时以本轮要求为准）：\n${list}`;
}

function memoryText(value: unknown) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) throw new AgentMemoryError("记忆内容不能为空");
    return text;
}

function isMemoryItem(value: unknown): value is AgentMemoryItem {
    const item = value as AgentMemoryItem;
    return Boolean(item) && typeof item.id === "string" && typeof item.text === "string" && typeof item.enabled === "boolean";
}

async function writeState(file: string, state: AgentMemoryState) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
        await fs.rename(temporaryFile, file);
    } finally {
        await fs.rm(temporaryFile, { force: true });
    }
}

export const agentMemoryStore = new AgentMemoryStore();
