import { useState } from "react";
import { Button, Dropdown, Input, Modal, Tooltip } from "antd";
import { LayoutTemplate, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AGENT_TEMPLATE_SELECTION, expandAgentTemplate } from "@/lib/agent/agent-templates";
import { buildCanvasResourceReferences } from "@/lib/canvas/canvas-resource-references";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentTemplateStore } from "@/stores/use-agent-template-store";
import { agentReferenceMarker } from "./agent-chat-inline-tokens";

const PRESET_TEMPLATES = ["arrange", "summarize", "expand", "illustrate"] as const;

/** 常用画布动作模板：选中后填入输入框，并自动引用画布上当前选中的节点。 */
export function AgentTemplateMenu({ theme, disabled }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; disabled?: boolean }) {
    const { t } = useTranslation();
    const templates = useAgentTemplateStore((state) => state.templates);
    const addTemplate = useAgentTemplateStore((state) => state.addTemplate);
    const removeTemplate = useAgentTemplateStore((state) => state.removeTemplate);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState("");
    const [prompt, setPrompt] = useState("");

    const apply = (template: string) => {
        const state = useAgentStore.getState();
        const snapshot = state.canvasContext?.snapshot;
        const selected = new Set(snapshot?.selectedNodeIds || []);
        const references = buildCanvasResourceReferences(snapshot?.nodes || []).filter((item) => selected.has(item.nodeId));
        state.setAgentState({ prompt: expandAgentTemplate(template, references.map(agentReferenceMarker), t("agent.templates.wholeCanvas")), canvasReferences: references });
        setOpen(false);
    };

    const save = () => {
        if (!title.trim() || !prompt.trim()) return;
        addTemplate(title, prompt);
        setEditing(false);
        setTitle("");
        setPrompt("");
    };

    const presetItems = PRESET_TEMPLATES.map((key) => ({ key: `preset:${key}`, label: t(`agent.templates.presets.${key}.title`), onClick: () => apply(t(`agent.templates.presets.${key}.prompt`, { selection: AGENT_TEMPLATE_SELECTION, interpolation: { escapeValue: false } })) }));
    const customItems = templates.map((item) => ({
        key: `custom:${item.id}`,
        label: (
            <span className="flex min-w-44 items-center justify-between gap-3">
                <span className="min-w-0 truncate">{item.title}</span>
                <button type="button" className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100" aria-label={t("agent.templates.remove", { name: item.title })} onClick={(event) => { event.stopPropagation(); removeTemplate(item.id); }}>
                    <X className="size-3.5" />
                </button>
            </span>
        ),
        onClick: () => apply(item.prompt),
    }));

    return (
        <>
            <Tooltip title={t("agent.templates.label")} placement="top" open={open ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Dropdown
                        trigger={["click"]}
                        placement="topLeft"
                        open={open}
                        disabled={disabled}
                        onOpenChange={setOpen}
                        menu={{
                            items: [
                                { type: "group", key: "presets", label: t("agent.templates.presetGroup"), children: presetItems },
                                ...(customItems.length ? [{ type: "group" as const, key: "custom", label: t("agent.templates.customGroup"), children: customItems }] : []),
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-3.5" />, label: t("agent.templates.create"), onClick: () => { setOpen(false); setEditing(true); } },
                            ],
                        }}
                    >
                        <Button type="text" shape="circle" className="!h-9 !w-9 !min-w-9" disabled={disabled} style={{ color: theme.node.muted }} icon={<LayoutTemplate className="size-4" />} aria-label={t("agent.templates.label")} />
                    </Dropdown>
                </span>
            </Tooltip>
            <Modal open={editing} title={t("agent.templates.create")} okText={t("agent.templates.save")} cancelText={t("agent.templates.cancel")} okButtonProps={{ disabled: !title.trim() || !prompt.trim() }} onOk={save} onCancel={() => setEditing(false)} destroyOnHidden>
                <div className="space-y-3">
                    <Input value={title} maxLength={40} placeholder={t("agent.templates.titlePlaceholder")} onChange={(event) => setTitle(event.target.value)} aria-label={t("agent.templates.titleLabel")} />
                    <Input.TextArea value={prompt} autoSize={{ minRows: 4, maxRows: 10 }} placeholder={t("agent.templates.promptPlaceholder", { selection: AGENT_TEMPLATE_SELECTION, interpolation: { escapeValue: false } })} onChange={(event) => setPrompt(event.target.value)} aria-label={t("agent.templates.promptLabel")} />
                    <div className="text-xs leading-5 opacity-60">{t("agent.templates.hint", { selection: AGENT_TEMPLATE_SELECTION, interpolation: { escapeValue: false } })}</div>
                </div>
            </Modal>
        </>
    );
}
