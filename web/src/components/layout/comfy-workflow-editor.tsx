import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Segmented, Select, Spin } from "antd";
import { ChevronDown, ChevronRight, FolderOpen, History, Upload, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    autoComfyInputs,
    comfyInputChoices,
    comfyWorkflowFromPng,
    isPngBytes,
    COMFY_MAX_REFS_PER_PARAM,
    COMFY_PARAMS,
    comfyPlaceholderParams,
    fetchComfyHistoryWorkflows,
    fetchComfyObjectInfo,
    fetchComfySavedWorkflow,
    fetchComfySavedWorkflows,
    listComfyChoiceInputs,
    listComfyInputs,
    listComfyOutputNodes,
    listComfyTunableInputs,
    parseComfySettings,
    parseComfyWorkflow,
    serializeComfyWorkflow,
    setComfyInputValue,
    toComfyApiWorkflow,
    type ComfyCanvasSettings,
    type ComfyHistoryWorkflow,
    type ComfyInputRef,
    type ComfyParam,
    type ComfyWorkflow,
} from "@/services/api/comfyui";
import { isComfyUiWorkflow, type ComfyObjectInfo } from "@/services/api/comfyui-convert";
import type { ModelCapability, ModelChannel } from "@/stores/use-config-store";

export type ComfyWorkflowDraft = { name: string; capability: ModelCapability; workflow: string };

/** 把保存的 JSON 拆成编辑框里的工作流文本和画布设置；没有设置时保留原文。 */
function splitStoredWorkflow(text: string): { workflow: string; settings: ComfyCanvasSettings } {
    const settings = parseComfySettings(text);
    if (!Object.keys(settings).length) return { workflow: text, settings: {} };
    try {
        return { workflow: JSON.stringify(parseComfyWorkflow(text), null, 2), settings };
    } catch {
        return { workflow: text, settings: {} };
    }
}

/** 编辑框里是不是 ComfyUI 普通保存格式（需要转换）。 */
function isUiFormatText(text: string) {
    try {
        return isComfyUiWorkflow(JSON.parse(text));
    } catch {
        return false;
    }
}

/** 按输出节点建议用途：有视频输出就是视频，否则是生图。 */
function suggestCapability(workflow: ComfyWorkflow): ModelCapability {
    const kinds = listComfyOutputNodes(workflow).map((node) => node.kind);
    return kinds.includes("video") ? "video" : kinds.length && kinds.every((kind) => kind === "audio") ? "audio" : "image";
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
    const [saved, setSaved] = useState<{ loading: boolean; items: string[]; error: string } | null>(null);
    const [converting, setConverting] = useState(false);
    /** 转换时显示的进度文字：第一次要从 ComfyUI 读取全部节点定义，节点多时要十几秒。 */
    const [convertStage, setConvertStage] = useState<"nodes" | "convert">("convert");
    // 节点定义很大，打开编辑框期间只取一次。
    const objectInfoRef = useRef<ComfyObjectInfo | null>(null);
    /** 每次打开编辑器换一个编号；上一次打开时还没返回的 /object_info 不再写回（渠道地址可能已经改了）。 */
    const session = useRef(0);
    /** 模型、LoRA、采样器的候选值来自节点定义；展开参数面板时才去读。 */
    const [choiceInfo, setChoiceInfo] = useState<{ loading: boolean; info: ComfyObjectInfo | null; error: string }>({ loading: false, info: null, error: "" });

    useEffect(() => {
        session.current += 1;
        if (!open) return;
        const stored = splitStoredWorkflow(value?.workflow || "");
        setDraft(value ? { ...value, workflow: stored.workflow } : { name: "", capability: "image", workflow: "" });
        setSettings(stored.settings);
        setShowMapping(Boolean(stored.settings.mapping || stored.settings.outputNodes));
        setError("");
        setHistory(null);
        setSaved(null);
        objectInfoRef.current = null;
        setChoiceInfo({ loading: false, info: null, error: "" });
    }, [open, value]);

    const objectInfo = async () => {
        if (!channel) throw new Error(t("config.comfyWorkflow.convertNeedsChannel"));
        if (objectInfoRef.current) return objectInfoRef.current;
        const current = session.current;
        setConvertStage("nodes");
        try {
            const info = await fetchComfyObjectInfo(channel);
            // 编辑器已经重新打开过时只把结果交给原调用方，不缓存给新的这次用。
            if (current === session.current) objectInfoRef.current = info;
            return info;
        } finally {
            setConvertStage("convert");
        }
    };

    /** 把普通保存格式或 API 格式整理成 API 格式填进编辑框，并检查缺少的节点。 */
    const applyConverted = async (raw: unknown, name?: string) => {
        const workflow = toComfyApiWorkflow(raw, await objectInfo());
        setDraft((current) => ({ ...current, workflow: JSON.stringify(workflow, null, 2), capability: suggestCapability(workflow), name: current.name || name || "" }));
        setSettings({});
        setError("");
    };

    const convertDraft = async () => {
        setConverting(true);
        try {
            await applyConverted(JSON.parse(draft.workflow));
        } catch (convertError) {
            setError(convertError instanceof Error ? convertError.message : String(convertError));
        } finally {
            setConverting(false);
        }
    };

    const loadSaved = async () => {
        if (!channel) return;
        setHistory(null);
        setSaved({ loading: true, items: [], error: "" });
        try {
            setSaved({ loading: false, items: await fetchComfySavedWorkflows(channel), error: "" });
        } catch (loadError) {
            setSaved({ loading: false, items: [], error: loadError instanceof Error ? loadError.message : String(loadError) });
        }
    };

    const pickSaved = async (file: string) => {
        if (!channel) return;
        setConverting(true);
        try {
            await applyConverted(
                await fetchComfySavedWorkflow(channel, file),
                file
                    .split("/")
                    .pop()
                    ?.replace(/\.json$/i, ""),
            );
            setSaved(null);
        } catch (convertError) {
            setSaved((current) => (current ? { ...current, error: convertError instanceof Error ? convertError.message : String(convertError) } : current));
        } finally {
            setConverting(false);
        }
    };

    const parsed = useMemo(() => tryParseWorkflow(draft.workflow), [draft.workflow]);
    const inputs = useMemo(() => (parsed ? listComfyInputs(parsed) : []), [parsed]);
    const outputs = useMemo(() => (parsed ? listComfyOutputNodes(parsed) : []), [parsed]);
    const tunables = useMemo(() => (parsed ? listComfyTunableInputs(parsed) : []), [parsed]);
    const choices = useMemo(() => (parsed ? listComfyChoiceInputs(parsed) : []), [parsed]);
    const needChoiceInfo = Boolean(open && showMapping && channel && choices.length);
    useEffect(() => {
        if (!needChoiceInfo || choiceInfo.info || choiceInfo.loading || choiceInfo.error) return;
        const current = session.current;
        setChoiceInfo({ loading: true, info: null, error: "" });
        objectInfo()
            .then((info) => {
                if (current === session.current) setChoiceInfo({ loading: false, info, error: "" });
            })
            .catch((reason: unknown) => {
                if (current === session.current) setChoiceInfo({ loading: false, info: null, error: reason instanceof Error ? reason.message : String(reason) });
            });
        // objectInfo 每次渲染都是新函数，只在需要且还没读过时触发。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needChoiceInfo, choiceInfo]);
    const setTunable = (ref: ComfyInputRef, next: number | string | null) => {
        if (!parsed || next === null || (typeof next === "number" && !Number.isFinite(next))) return;
        setDraft((current) => {
            const updated = setComfyInputValue(parsed, ref, next);
            // 粘贴的导出文件可能带着 { prompt, infinite_canvas } 外壳，只替换里面的工作流，保留映射等设置。
            let raw: unknown;
            try {
                raw = JSON.parse(current.workflow);
            } catch {
                raw = null;
            }
            const wrapped = raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { prompt?: unknown }).prompt && typeof (raw as { prompt?: unknown }).prompt === "object";
            return { ...current, workflow: JSON.stringify(wrapped ? { ...(raw as object), prompt: updated } : updated, null, 2) };
        });
    };
    const auto = useMemo(() => (parsed ? autoComfyInputs(parsed) : {}), [parsed]);
    const placeholders = useMemo(() => new Set(parsed ? comfyPlaceholderParams(parsed) : []), [parsed]);
    const inputLabel = (ref: ComfyInputRef) => {
        const item = inputs.find((option) => option.ref === ref);
        if (item) return `#${item.nodeId} ${item.title || item.classType} · ${item.input}`;
        // 自动识别可能指向连线输入（例如连到分辨率选择节点的宽高），列表里没有，按节点信息显示。
        const [nodeId, input] = [ref.slice(0, ref.indexOf(".")), ref.slice(ref.indexOf(".") + 1)];
        const node = parsed?.[nodeId];
        return node ? `#${nodeId} ${node._meta?.title || node.class_type} · ${input}` : ref;
    };
    const setMapping = (param: ComfyParam, refs: ComfyInputRef[]) => setSettings((current) => ({ ...current, mapping: { ...current.mapping, [param]: refs } }));

    const loadHistory = async () => {
        if (!channel) return;
        setSaved(null);
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
        const cleaned = { mapping, outputNodes: settings.outputNodes, seedMode: settings.seedMode };
        const hasSettings = Object.values(mapping).some((refs) => refs.length) || (settings.outputNodes || []).some((id) => workflow[id]) || settings.seedMode === "fixed";
        onSave({ ...draft, name, workflow: hasSettings ? serializeComfyWorkflow(workflow, cleaned) : draft.workflow.trim() }, value?.name);
        onClose();
    };

    const importFile = async (file: File | undefined) => {
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text: string;
        if (isPngBytes(bytes)) {
            // ComfyUI 生成的图片里带着工作流：优先用 API 格式，只有普通格式时走下面的转换。
            const fromPng = await comfyWorkflowFromPng(bytes);
            if (!fromPng) {
                setError(t("config.comfyWorkflow.pngNoWorkflow"));
                return;
            }
            text = fromPng.text;
        } else text = new TextDecoder().decode(bytes);
        const stored = splitStoredWorkflow(text);
        setDraft((current) => ({ ...current, workflow: stored.workflow, name: current.name || file.name.replace(/\.(json|png)$/i, "") }));
        setSettings(stored.settings);
        setError("");
        // 普通保存格式的文件直接转换；连不上 ComfyUI 时保留原文，提示里可以再点转换。
        if (channel && isUiFormatText(stored.workflow)) {
            setConverting(true);
            try {
                await applyConverted(JSON.parse(stored.workflow));
            } catch (convertError) {
                setError(convertError instanceof Error ? convertError.message : String(convertError));
            } finally {
                setConverting(false);
            }
        }
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
                            options={(["image", "video", "audio"] as const).map((value) => ({ value, label: t(`config.channelEditor.capabilities.${value}`) }))}
                            onChange={(capability) => setDraft({ ...draft, capability: capability as ModelCapability })}
                        />
                    </label>
                </div>
                <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{t("config.comfyWorkflow.json")}</span>
                        <div className="flex flex-wrap justify-end gap-2">
                            {channel ? (
                                <Button size="small" icon={<FolderOpen className="size-3.5" />} loading={saved?.loading} onClick={() => void loadSaved()}>
                                    {t("config.comfyWorkflow.importSaved")}
                                </Button>
                            ) : null}
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
                            accept=".json,application/json,.png,image/png"
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
                    ) : saved && !saved.loading ? (
                        <div className="mb-2 rounded-lg border border-stone-200 p-2 dark:border-stone-700" data-testid="comfy-saved">
                            <div className="mb-1 flex items-center justify-between text-xs text-stone-500">
                                <span>{t("config.comfyWorkflow.savedTitle")}</span>
                                <Button size="small" type="text" onClick={() => setSaved(null)}>
                                    {t("config.comfyWorkflow.historyClose")}
                                </Button>
                            </div>
                            {saved.error ? <Alert className="mb-1" type="error" showIcon message={<span className="whitespace-pre-line">{saved.error}</span>} /> : null}
                            {saved.items.length ? (
                                <Spin spinning={converting} size="small">
                                    <div className="max-h-56 space-y-1 overflow-y-auto">
                                        {saved.items.map((file) => (
                                            <button key={file} type="button" className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => void pickSaved(file)}>
                                                <span className="min-w-0 truncate">{file.replace(/\.json$/i, "")}</span>
                                            </button>
                                        ))}
                                    </div>
                                </Spin>
                            ) : !saved.error ? (
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.comfyWorkflow.savedEmpty")} />
                            ) : null}
                        </div>
                    ) : history?.loading || saved?.loading ? (
                        <div className="mb-2 flex justify-center py-3">
                            <Spin size="small" />
                        </div>
                    ) : null}
                    {converting ? (
                        <div className="mb-2 flex items-center gap-2 text-xs text-stone-500" data-testid="comfy-converting">
                            <Spin size="small" />
                            {t(convertStage === "nodes" ? "config.comfyWorkflow.convertLoadingNodes" : "config.comfyWorkflow.converting")}
                        </div>
                    ) : null}
                    {isUiFormatText(draft.workflow) ? (
                        <Alert
                            className="mb-2"
                            type="warning"
                            showIcon
                            data-testid="comfy-ui-format"
                            message={t(channel ? "config.comfyWorkflow.uiFormat" : "config.comfyWorkflow.uiFormatNoChannel")}
                            action={
                                channel ? (
                                    <Button size="small" type="primary" icon={<Wand2 className="size-3.5" />} loading={converting} onClick={() => void convertDraft()}>
                                        {t("config.comfyWorkflow.convert")}
                                    </Button>
                                ) : null
                            }
                        />
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
                                                    maxCount={COMFY_MAX_REFS_PER_PARAM}
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
                                                {param === "seed" && !placeholders.has(param) ? (
                                                    <div className="flex flex-wrap items-center gap-2 md:col-start-2">
                                                        <Segmented
                                                            size="small"
                                                            data-testid="comfy-seed-mode"
                                                            value={settings.seedMode || "random"}
                                                            options={[
                                                                { value: "random", label: t("config.comfyWorkflow.seedRandom") },
                                                                { value: "fixed", label: t("config.comfyWorkflow.seedFixed") },
                                                            ]}
                                                            onChange={(mode) => setSettings((current) => ({ ...current, seedMode: mode === "fixed" ? "fixed" : undefined }))}
                                                        />
                                                        <span className="text-xs text-stone-500">{t(settings.seedMode === "fixed" ? "config.comfyWorkflow.seedFixedHint" : "config.comfyWorkflow.seedRandomHint")}</span>
                                                    </div>
                                                ) : null}
                                            </label>
                                        );
                                    })}
                                </div>
                                {tunables.length ? (
                                    <div data-testid="comfy-tunables">
                                        <div className="mb-1 text-xs font-medium">{t("config.comfyWorkflow.tunableTitle")}</div>
                                        <div className="grid gap-1.5 md:grid-cols-2">
                                            {tunables.map((item) => (
                                                <label key={item.ref} className="flex items-center justify-between gap-2 text-xs">
                                                    <span className="min-w-0 truncate" title={inputLabel(item.ref)}>
                                                        {inputLabel(item.ref)}
                                                    </span>
                                                    <InputNumber size="small" className="!w-28 shrink-0" data-testid={`comfy-tune-${item.ref}`} value={item.value as number} step={item.input === "denoise" ? 0.05 : item.input === "cfg" || item.input === "guidance" ? 0.5 : 1} onChange={(next) => setTunable(item.ref, next)} />
                                                </label>
                                            ))}
                                        </div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">{t("config.comfyWorkflow.tunableHint")}</div>
                                    </div>
                                ) : null}
                                {choices.length ? (
                                    <div data-testid="comfy-choices">
                                        <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                                            {t("config.comfyWorkflow.choiceTitle")}
                                            {choiceInfo.loading ? <Spin size="small" /> : null}
                                        </div>
                                        <div className="grid gap-1.5 md:grid-cols-2">
                                            {choices.map((item) => {
                                                const list = comfyInputChoices(choiceInfo.info, item.classType, item.input);
                                                const missing = Boolean(list && !list.includes(String(item.value)));
                                                return (
                                                    <label key={item.ref} className="flex flex-col gap-0.5 text-xs">
                                                        <span className="flex items-center justify-between gap-2">
                                                            <span className="min-w-0 truncate" title={inputLabel(item.ref)}>
                                                                {inputLabel(item.ref)}
                                                            </span>
                                                            <Select
                                                                size="small"
                                                                showSearch
                                                                className="!w-56 shrink-0"
                                                                popupMatchSelectWidth={false}
                                                                data-testid={`comfy-choice-${item.ref}`}
                                                                status={missing ? "error" : undefined}
                                                                value={String(item.value)}
                                                                options={(list || [String(item.value)]).map((option) => ({ value: option, label: option }))}
                                                                onChange={(next: string) => setTunable(item.ref, next)}
                                                            />
                                                        </span>
                                                        {missing ? <span className="text-red-500">{t("config.comfyWorkflow.choiceMissing")}</span> : null}
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500">{choiceInfo.error ? t("config.comfyWorkflow.choiceLoadFailed", { error: choiceInfo.error }) : channel ? t("config.comfyWorkflow.choiceHint") : t("config.comfyWorkflow.convertNeedsChannel")}</div>
                                    </div>
                                ) : null}
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
                {error ? <Alert type="error" showIcon message={<span className="whitespace-pre-line">{error}</span>} /> : null}
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
