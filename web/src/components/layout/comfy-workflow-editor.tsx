import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Modal, Segmented, Select, Spin } from "antd";
import { ChevronDown, ChevronRight, History, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    autoComfyInputs,
    COMFY_PARAMS,
    comfyPlaceholderParams,
    fetchComfyHistoryWorkflows,
    listComfyInputs,
    listComfyOutputNodes,
    parseComfySettings,
    parseComfyWorkflow,
    serializeComfyWorkflow,
    type ComfyCanvasSettings,
    type ComfyHistoryWorkflow,
    type ComfyInputRef,
    type ComfyParam,
    type ComfyWorkflow,
} from "@/services/api/comfyui";
import type { ModelCapability, ModelChannel } from "@/stores/use-config-store";

export type ComfyWorkflowDraft = { name: string; capability: ModelCapability; workflow: string };

/** 把保存的 JSON 拆成编辑框里的工作流文本和画布设置；没有设置时保留原文。 */
function splitStoredWorkflow(text: string): { workflow: string; settings: ComfyCanvasSettings } {
    const settings = parseComfySettings(text);
    if (!settings.mapping && !settings.outputNodes) return { workflow: text, settings: {} };
    try {
        return { workflow: JSON.stringify(parseComfyWorkflow(text), null, 2), settings };
    } catch {
        return { workflow: text, settings: {} };
    }
}

function tryParseWorkflow(text: string): ComfyWorkflow | null {
    try {
        return text.trim() ? parseComfyWorkflow(text) : null;
    } catch {
        return null;
    }
}

/** 编辑 ComfyUI 渠道里的一个工作流：名称、能力（生图/视频）和 API 格式 JSON。 */
export function ComfyWorkflowEditor({
    open,
    value,
    existingNames,
    channel,
    onSave,
    onClose,
}: {
    open: boolean;
    /** 为空表示新增。 */
    value: ComfyWorkflowDraft | null;
    existingNames: string[];
    /** 用来读取 ComfyUI 的运行历史；不传时不显示「从最近运行导入」。 */
    channel?: Pick<ModelChannel, "baseUrl" | "apiKey">;
    onSave: (draft: ComfyWorkflowDraft, previousName?: string) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ComfyWorkflowDraft>({ name: "", capability: "image", workflow: "" });
    const [error, setError] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    const [history, setHistory] = useState<{ loading: boolean; items: ComfyHistoryWorkflow[]; error: string } | null>(null);
    const [settings, setSettings] = useState<ComfyCanvasSettings>({});
    const [showMapping, setShowMapping] = useState(false);

    useEffect(() => {
        if (!open) return;
        const stored = splitStoredWorkflow(value?.workflow || "");
        setDraft(value ? { ...value, workflow: stored.workflow } : { name: "", capability: "image", workflow: "" });
        setSettings(stored.settings);
        setShowMapping(Boolean(stored.settings.mapping || stored.settings.outputNodes));
        setError("");
        setHistory(null);
    }, [open, value]);

    const parsed = useMemo(() => tryParseWorkflow(draft.workflow), [draft.workflow]);
    const inputs = useMemo(() => (parsed ? listComfyInputs(parsed) : []), [parsed]);
    const outputs = useMemo(() => (parsed ? listComfyOutputNodes(parsed) : []), [parsed]);
    const auto = useMemo(() => (parsed ? autoComfyInputs(parsed) : {}), [parsed]);
    const placeholders = useMemo(() => new Set(parsed ? comfyPlaceholderParams(parsed) : []), [parsed]);
    const inputLabel = (ref: ComfyInputRef) => {
        const item = inputs.find((option) => option.ref === ref);
        return item ? `#${item.nodeId} ${item.title || item.classType} · ${item.input}` : ref;
    };
    const setMapping = (param: ComfyParam, refs: ComfyInputRef[]) => setSettings((current) => ({ ...current, mapping: { ...current.mapping, [param]: refs } }));

    const loadHistory = async () => {
        if (!channel) return;
        setHistory({ loading: true, items: [], error: "" });
        try {
            setHistory({ loading: false, items: await fetchComfyHistoryWorkflows(channel), error: "" });
        } catch (loadError) {
            setHistory({ loading: false, items: [], error: loadError instanceof Error ? loadError.message : String(loadError) });
        }
    };

    const pickHistory = (item: ComfyHistoryWorkflow) => {
        const fallbackName =
            item.models[0]
                ?.split(/[\\/]/)
                .pop()
                ?.replace(/\.(safetensors|ckpt|gguf|pt|bin)$/i, "") || `workflow-${item.id.slice(0, 8)}`;
        setDraft((current) => ({ ...current, workflow: JSON.stringify(item.workflow, null, 2), capability: item.capability, name: current.name || fallbackName }));
        setSettings({});
        setHistory(null);
        setError("");
    };

    const save = () => {
        const name = draft.name.trim();
        if (!name) return setError(t("config.comfyWorkflow.nameRequired"));
        if (name !== value?.name && existingNames.includes(name)) return setError(t("config.comfyWorkflow.nameExists"));
        let workflow: ComfyWorkflow;
        try {
            workflow = parseComfyWorkflow(draft.workflow);
        } catch (parseError) {
            return setError(parseError instanceof Error ? parseError.message : String(parseError));
        }
        // 只保留当前工作流里还存在的参数和输出节点。
        const valid = new Set(listComfyInputs(workflow).map((item) => item.ref));
        const mapping = Object.fromEntries(Object.entries(settings.mapping || {}).map(([param, refs]) => [param, (refs || []).filter((ref) => valid.has(ref))]));
        const cleaned = { mapping, outputNodes: settings.outputNodes };
        const hasSettings = Object.values(mapping).some((refs) => refs.length) || (settings.outputNodes || []).some((id) => workflow[id]);
        onSave({ ...draft, name, workflow: hasSettings ? serializeComfyWorkflow(workflow, cleaned) : draft.workflow.trim() }, value?.name);
        onClose();
    };

    const importFile = async (file: File | undefined) => {
        if (!file) return;
        const stored = splitStoredWorkflow(await file.text());
        setDraft((current) => ({ ...current, workflow: stored.workflow, name: current.name || file.name.replace(/\.json$/i, "") }));
        setSettings(stored.settings);
        setError("");
    };

    return (
        <Modal open={open} width={760} title={value ? t("config.comfyWorkflow.editTitle") : t("config.comfyWorkflow.addTitle")} onCancel={onClose} onOk={save} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
            <div className="space-y-4" data-canvas-no-zoom>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("config.comfyWorkflow.name")}</span>
                        <Input value={draft.name} placeholder={t("config.comfyWorkflow.namePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("config.comfyWorkflow.capability")}</span>
                        <Segmented
                            value={draft.capability}
                            options={(["image", "video"] as const).map((value) => ({ value, label: t(`config.channelEditor.capabilities.${value}`) }))}
                            onChange={(capability) => setDraft({ ...draft, capability: capability as ModelCapability })}
                        />
                    </label>
                </div>
                <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{t("config.comfyWorkflow.json")}</span>
                        <div className="flex flex-wrap justify-end gap-2">
                            {channel ? (
                                <Button size="small" icon={<History className="size-3.5" />} loading={history?.loading} onClick={() => void loadHistory()}>
                                    {t("config.comfyWorkflow.importHistory")}
                                </Button>
                            ) : null}
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                                {t("config.comfyWorkflow.import")}
                            </Button>
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={(event) => {
                                void importFile(event.target.files?.[0]);
                                event.target.value = "";
                            }}
                        />
                    </div>
                    {history && !history.loading ? (
                        <div className="mb-2 rounded-lg border border-stone-200 p-2 dark:border-stone-700" data-testid="comfy-history">
                            <div className="mb-1 flex items-center justify-between text-xs text-stone-500">
                                <span>{t("config.comfyWorkflow.historyTitle")}</span>
                                <Button size="small" type="text" onClick={() => setHistory(null)}>
                                    {t("config.comfyWorkflow.historyClose")}
                                </Button>
                            </div>
                            {history.error ? (
                                <Alert type="error" showIcon message={history.error} />
                            ) : history.items.length ? (
                                <div className="max-h-56 space-y-1 overflow-y-auto">
                                    {history.items.map((item) => (
                                        <button key={item.id} type="button" className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => pickHistory(item)}>
                                            <span className="min-w-0 truncate">{item.summary || t("config.comfyWorkflow.historyUnnamed")}</span>
                                            <span className="shrink-0 text-xs text-stone-500">
                                                {t(`config.channelEditor.capabilities.${item.capability}`)} · {t("config.comfyWorkflow.historyNodes", { count: item.nodeCount })}
                                                {item.time ? ` · ${new Date(item.time).toLocaleString()}` : ""}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.comfyWorkflow.historyEmpty")} />
                            )}
                        </div>
                    ) : history?.loading ? (
                        <div className="mb-2 flex justify-center py-3">
                            <Spin size="small" />
                        </div>
                    ) : null}
                    <Input.TextArea
                        value={draft.workflow}
                        autoSize={{ minRows: 10, maxRows: 18 }}
                        className="font-mono !text-xs"
                        placeholder={t("config.comfyWorkflow.jsonPlaceholder")}
                        aria-label={t("config.comfyWorkflow.json")}
                        onChange={(event) => {
                            setDraft({ ...draft, workflow: event.target.value });
                            setError("");
                        }}
                    />
                </div>
                {parsed ? (
                    <div className="rounded-lg border border-stone-200 dark:border-stone-700" data-testid="comfy-mapping">
                        <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium" onClick={() => setShowMapping((value) => !value)}>
                            {showMapping ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            {t("config.comfyWorkflow.mappingTitle")}
                        </button>
                        {showMapping ? (
                            <div className="space-y-3 border-t border-stone-200 px-3 py-3 dark:border-stone-700">
                                <div className="text-xs leading-5 text-stone-500">{t("config.comfyWorkflow.mappingHint")}</div>
                                <div className="grid gap-2">
                                    {COMFY_PARAMS.map((param) => {
                                        const autoRefs = auto[param] || [];
                                        const placeholder = placeholders.has(param)
                                            ? t("config.comfyWorkflow.mappingPlaceholder")
                                            : autoRefs.length
                                              ? t("config.comfyWorkflow.mappingAuto", { target: autoRefs.map(inputLabel).join("、") })
                                              : t("config.comfyWorkflow.mappingNone");
                                        return (
                                            <label key={param} className="grid items-center gap-1 md:grid-cols-[120px_minmax(0,1fr)]">
                                                <span className="text-xs font-medium">{t(`config.comfyWorkflow.params.${param}`)}</span>
                                                <Select
                                                    size="small"
                                                    mode="multiple"
                                                    allowClear
                                                    showSearch
                                                    optionFilterProp="label"
                                                    data-testid={`comfy-map-${param}`}
                                                    disabled={placeholders.has(param)}
                                                    value={placeholders.has(param) ? [] : settings.mapping?.[param] || []}
                                                    placeholder={placeholder}
                                                    options={inputs.map((item) => ({ value: item.ref, label: `${inputLabel(item.ref)} = ${String(item.value).slice(0, 40)}` }))}
                                                    onChange={(refs: ComfyInputRef[]) => setMapping(param, refs)}
                                                />
                                            </label>
                                        );
                                    })}
                                </div>
                                <div>
                                    <div className="mb-1 text-xs font-medium">{t("config.comfyWorkflow.outputTitle")}</div>
                                    {outputs.length ? (
                                        <Checkbox.Group
                                            className="flex flex-wrap gap-x-4 gap-y-1"
                                            value={settings.outputNodes || []}
                                            options={outputs.map((item) => ({ value: item.nodeId, label: `#${item.nodeId} ${item.title || item.classType} (${t(`config.channelEditor.capabilities.${item.kind}`)})` }))}
                                            onChange={(ids) => setSettings((current) => ({ ...current, outputNodes: ids as string[] }))}
                                        />
                                    ) : null}
                                    <div className="mt-1 text-xs leading-5 text-stone-500">{outputs.length ? t("config.comfyWorkflow.outputHint") : t("config.comfyWorkflow.outputNone")}</div>
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {error ? <Alert type="error" showIcon message={error} /> : null}
                <div className="rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900/50 dark:text-stone-300">
                    <div className="mb-1 font-medium">{t("config.comfyWorkflow.helpTitle")}</div>
                    <ol className="list-decimal space-y-0.5 pl-4">
                        <li>{t("config.comfyWorkflow.helpExport")}</li>
                        <li>{t("config.comfyWorkflow.helpPlaceholders")}</li>
                        <li>{t("config.comfyWorkflow.helpAuto")}</li>
                        <li>{t("config.comfyWorkflow.helpCors")}</li>
                    </ol>
                </div>
            </div>
        </Modal>
    );
}
