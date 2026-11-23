import i18n from "@/i18n";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { AgentReasoningEffort } from "@/stores/use-agent-store";

type AgentConfigResponse = { ok?: boolean; protocolVersion?: number; url?: string; token?: string; hasToken?: boolean };
const AGENT_MESSAGE_ASSET_PATTERN = /^agent-asset:([a-f0-9]{64})\/([a-f0-9]{64}\.(?:gif|jpe?g|png|webp))$/;

export class AgentApiError<T = unknown> extends Error {
    constructor(readonly status: number, readonly response: T & { code?: string; error?: string; msg?: string }) {
        super(response.error || response.msg || i18n.t("agent.state.requestFailed"));
        this.name = "AgentApiError";
    }
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";
export type AgentSkillInterface = { displayName?: string | null; shortDescription?: string | null; defaultPrompt?: string | null };
export type AgentSkillSummary = {
    name: string;
    description: string;
    shortDescription?: string | null;
    interface?: AgentSkillInterface | null;
    dependencies?: unknown;
    path: string;
    scope: AgentSkillScope;
    enabled: boolean;
    managed: boolean;
};
export type AgentSkillDetail = {
    name: string;
    description: string;
    instructions: string;
    interface?: AgentSkillInterface | null;
    path: string;
    managed: true;
    revision: string;
};
export type AgentSkillInput = { name?: string; description: string; instructions: string; interface?: AgentSkillInterface | null; expectedRevision?: string };
export type AgentSkillDraft = { name: string; displayName: string; description: string; instructions: string; shortDescription: string; defaultPrompt: string };
export type AgentSkillDraftInput = { source: "conversation" | "canvas"; threadId: string; clientId: string; model?: string; effort?: AgentReasoningEffort };
export type AgentSkillsResponse = { ok?: boolean; data?: AgentSkillSummary[]; errors?: unknown[] };
export type AgentSkillResponse = { ok?: boolean; data?: AgentSkillDetail };
export type AgentSkillDraftResponse = { ok?: boolean; data?: AgentSkillDraft };

export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" });
    } catch {}
}

export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** 工具请求进入确认队列时暂停 Agent 端超时，批准后恢复计时。 */
export async function postToolHold(endpoint: string, token: string, clientId: string, requestId: string, held: boolean) {
    await fetchAgentJson(endpoint, token, `/canvas/hold?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, held }) });
}

export async function postCodexApproval(endpoint: string, token: string, requestId: string, decision: "accept" | "acceptForSession" | "decline") {
    await fetchAgentJson(endpoint, token, "/agent/codex/approval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, decision }) });
}

export async function interruptCodexTurn(endpoint: string, token: string, threadId?: string) {
    await fetchAgentJson(endpoint, token, "/agent/codex/interrupt", jsonPost({ threadId }));
}

export async function acknowledgeCodexHistory(endpoint: string, token: string, threadId: string, turnIds: string[]) {
    await fetchAgentJson(endpoint, token, "/agent/codex/history/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, turnIds }) });
}

export async function revealAgentLocalFile(endpoint: string, token: string, path: string) {
    await fetchAgentJson(endpoint, token, "/agent/local-file/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
}

export function resolveAgentMessageAssetUrl(endpoint: string, token: string, value: string) {
    const match = AGENT_MESSAGE_ASSET_PATTERN.exec(value);
    if (!match) return value.startsWith("agent-asset:") ? "" : value;
    const baseUrl = endpoint.trim().replace(/\/$/, "");
    return baseUrl && token ? `${baseUrl}/agent/message-assets/${match[1]}/${match[2]}?token=${encodeURIComponent(token)}` : "";
}

export function fetchCodexSkills(endpoint: string, token: string, forceReload = false) {
    return fetchAgentJson<AgentSkillsResponse>(endpoint, token, `/agent/codex/skills${forceReload ? "?forceReload=1" : ""}`);
}

export function fetchCodexSkill(endpoint: string, token: string, name: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}`);
}

export function createCodexSkill(endpoint: string, token: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, "/agent/codex/skills", jsonPost(input));
}

export function createCodexSkillDraft(endpoint: string, token: string, input: AgentSkillDraftInput) {
    return fetchAgentJson<AgentSkillDraftResponse>(endpoint, token, "/agent/codex/skills/draft", jsonPost(input));
}

export function updateCodexSkill(endpoint: string, token: string, name: string, input: AgentSkillInput) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}`, jsonPost(input));
}

export type AgentSkillFile = { path: string; size: number; modifiedAt: number };
export type AgentSkillFileContent = AgentSkillFile & { text?: string; binary: boolean };

export function fetchCodexSkillFiles(endpoint: string, token: string, name: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentSkillFile[] }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/files`);
}

export function fetchCodexSkillFile(endpoint: string, token: string, name: string, path: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentSkillFileContent }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(path)}`);
}

/** content 为 base64；同路径已存在时覆盖。 */
export function uploadCodexSkillFile(endpoint: string, token: string, name: string, path: string, content: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentSkillFile }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/files`, jsonPost({ path, content }));
}

export function deleteCodexSkillFile(endpoint: string, token: string, name: string, path: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/files/delete`, jsonPost({ path }));
}

export type AgentMemoryItem = { id: string; text: string; enabled: boolean; createdAt: number; updatedAt: number };
export type AgentMemoryState = { version: 1; enabled: boolean; items: AgentMemoryItem[] };

export function fetchAgentMemory(endpoint: string, token: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentMemoryState }>(endpoint, token, "/agent/memory");
}

export function addAgentMemory(endpoint: string, token: string, text: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentMemoryItem }>(endpoint, token, "/agent/memory", jsonPost({ text }));
}

export function updateAgentMemory(endpoint: string, token: string, id: string, patch: { text?: string; enabled?: boolean }) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentMemoryItem }>(endpoint, token, `/agent/memory/${encodeURIComponent(id)}`, jsonPost(patch));
}

export function deleteAgentMemory(endpoint: string, token: string, id: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/memory/${encodeURIComponent(id)}/delete`, jsonPost({}));
}

export function setAgentMemoryEnabled(endpoint: string, token: string, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, "/agent/memory/settings", jsonPost({ enabled }));
}

/** Claude Agent 自定义模型接口的摘要；Token 不会回传给网页。 */
export type ClaudeProviderSummary = { baseUrl: string; model: string; hasToken: boolean };

export function fetchClaudeProvider(endpoint: string, token: string) {
    return fetchAgentJson<{ ok?: boolean; data?: ClaudeProviderSummary }>(endpoint, token, "/agent/claude/provider");
}

/** authToken 不传表示保留原值，传空字符串表示清除。 */
export function updateClaudeProvider(endpoint: string, token: string, patch: { baseUrl?: string; model?: string; authToken?: string }) {
    return fetchAgentJson<{ ok?: boolean; data?: ClaudeProviderSummary }>(endpoint, token, "/agent/claude/provider", jsonPost(patch));
}

export type AgentSkillInstallPreview = { id: string; name: string; description: string; source: string; instructions: string; files: AgentSkillFile[]; totalSize: number };

export function previewCodexSkillInstall(endpoint: string, token: string, url: string) {
    return fetchAgentJson<{ ok?: boolean; data?: AgentSkillInstallPreview }>(endpoint, token, "/agent/codex/skills/install/preview", jsonPost({ url }));
}

export function installCodexSkill(endpoint: string, token: string, previewId: string) {
    return fetchAgentJson<AgentSkillResponse>(endpoint, token, "/agent/codex/skills/install", jsonPost({ previewId }));
}

export function deleteCodexSkill(endpoint: string, token: string, name: string, expectedRevision: string) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(name)}/delete`, jsonPost({ expectedRevision }));
}

export function setCodexSkillEnabled(endpoint: string, token: string, skill: Pick<AgentSkillSummary, "name" | "path">, enabled: boolean) {
    return fetchAgentJson<{ ok?: boolean }>(endpoint, token, `/agent/codex/skills/${encodeURIComponent(skill.name)}/enabled`, jsonPost({ ...skill, enabled }));
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new AgentApiError(res.status, data);
    return data;
}

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${endpoint}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

function jsonPost(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
