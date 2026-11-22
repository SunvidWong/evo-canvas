import { useEffect, useState } from "react";
import { App, Button, Input, Switch, Tooltip } from "antd";
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { addAgentMemory, deleteAgentMemory, fetchAgentMemory, setAgentMemoryEnabled, updateAgentMemory, type AgentMemoryItem } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

/** 查看和管理本地 Agent 的全局记忆；保存在本机，所有画布和会话共用。 */
export function AgentMemoryView({ endpoint, token, connected, theme }: { endpoint: string; token: string; connected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const memory = useAgentStore((state) => state.memory);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const [draft, setDraft] = useState("");
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const reload = async () => {
        const state = (await fetchAgentMemory(endpoint, token)).data;
        if (state) setAgentState({ memory: state });
    };

    useEffect(() => {
        if (connected) void reload().catch((error) => message.error(error instanceof Error ? error.message : t("agent.memory.loadFailed")));
    }, [connected, endpoint, token]); // eslint-disable-line react-hooks/exhaustive-deps

    /** 执行一次修改；成功后服务端会广播最新列表，这里再读一次兜底。 */
    const run = async (task: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await task();
            await reload();
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.memory.saveFailed"));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const add = async () => {
        const text = draft.trim();
        if (!text) return;
        if (await run(() => addAgentMemory(endpoint, token, text))) setDraft("");
    };

    const saveEdit = async () => {
        if (!editing) return;
        const text = editing.text.trim();
        if (!text) return;
        if (await run(() => updateAgentMemory(endpoint, token, editing.id, { text }))) setEditing(null);
    };

    const remove = (item: AgentMemoryItem) => modal.confirm({
        title: t("agent.memory.deleteTitle"),
        content: item.text,
        okButtonProps: { danger: true },
        onOk: () => run(() => deleteAgentMemory(endpoint, token, item.id)),
    });

    if (!connected) {
        return <div className="flex flex-1 items-center justify-center p-6 text-center text-sm" style={{ color: theme.node.muted }}>{t("agent.memory.disconnected")}</div>;
    }

    const items = memory?.items || [];
    const enabled = memory?.enabled !== false;
    return (
        <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                <div className="min-w-0">
                    <div className="text-sm font-medium" style={{ color: theme.node.text }}>{t("agent.memory.inject")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.memory.injectHint")}</div>
                </div>
                <Switch size="small" checked={enabled} disabled={busy || !memory} aria-label={t("agent.memory.inject")} onChange={(checked) => void run(() => setAgentMemoryEnabled(endpoint, token, checked))} />
            </div>

            <div className="flex gap-2">
                <Input.TextArea
                    value={draft}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    placeholder={t("agent.memory.addPlaceholder")}
                    aria-label={t("agent.memory.addPlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onPressEnter={(event) => {
                        if (event.shiftKey || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        void add();
                    }}
                />
                <Button icon={<Plus className="size-3.5" />} disabled={busy || !draft.trim()} onClick={() => void add()}>{t("agent.memory.add")}</Button>
            </div>

            {items.length ? (
                <ul className="flex flex-col gap-2">
                    {items.map((item) => (
                        <li key={item.id} className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke, opacity: item.enabled && enabled ? 1 : 0.6 }}>
                            {editing?.id === item.id ? (
                                <div className="flex flex-col gap-2">
                                    <Input.TextArea value={editing.text} autoSize={{ minRows: 2, maxRows: 6 }} aria-label={t("agent.memory.edit")} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} />
                                    <div className="flex justify-end gap-2">
                                        <Button size="small" icon={<X className="size-3.5" />} onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                                        <Button size="small" type="primary" icon={<Check className="size-3.5" />} disabled={busy || !editing.text.trim()} onClick={() => void saveEdit()}>{t("common.save")}</Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex items-start gap-2">
                                    <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: theme.node.text }}>{item.text}</div>
                                    <Tooltip title={item.enabled ? t("agent.memory.disable") : t("agent.memory.enable")}>
                                        <Switch size="small" className="mt-1" checked={item.enabled} disabled={busy} aria-label={item.enabled ? t("agent.memory.disable") : t("agent.memory.enable")} onChange={(checked) => void run(() => updateAgentMemory(endpoint, token, item.id, { enabled: checked }))} />
                                    </Tooltip>
                                    <Tooltip title={t("agent.memory.edit")}>
                                        <Button size="small" type="text" aria-label={t("agent.memory.edit")} icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => setEditing({ id: item.id, text: item.text })} />
                                    </Tooltip>
                                    <Tooltip title={t("agent.memory.delete")}>
                                        <Button size="small" type="text" danger aria-label={t("agent.memory.delete")} icon={<Trash2 className="size-3.5" />} disabled={busy} onClick={() => remove(item)} />
                                    </Tooltip>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm" style={{ color: theme.node.muted }}>
                    <Brain className="size-6" />
                    <div>{t("agent.memory.empty")}</div>
                </div>
            )}
        </div>
    );
}
