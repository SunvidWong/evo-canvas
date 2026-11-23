import { App, Button, Drawer, Input, InputNumber, Segmented, Select, Space, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { CheckCircle2, Copy, Download, ListPlus, ListX, MemoryStick, Plug, Plus, Trash2, Workflow, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHANNEL_PRESETS, channelPresetName, findChannelPreset } from "@/lib/channel-presets";
import { ANTHROPIC_MAX_TOKENS } from "@/services/api/anthropic";
import { clearOwnComfyQueue, comfyCopyName, comfyWorkflowFileName, freeComfyMemory } from "@/services/api/comfyui";
import { testChannelConnection, type ChannelTestResult } from "@/services/api/channel-test";
import {
    API_CALL_FORMATS,
    apiFormatName,
    channelNeedsApiKey,
    normalizeMaxTokens,
    defaultBaseUrlForApiFormat,
    guessCapability,
    normalizeChannelModels,
    type ApiCallFormat,
    type ChannelModel,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";
import { ComfyWorkflowEditor, type ComfyWorkflowDraft } from "./comfy-workflow-editor";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

/** 释放显存后等多久再重新测连接、刷新显存数值。 */
const FREE_MEMORY_SETTLE_MS = 2000;

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const [comfyAction, setComfyAction] = useState<"free" | "clear" | null>(null);
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [workflowTarget, setWorkflowTarget] = useState<{ value: ComfyWorkflowDraft | null } | null>(null);
    const apiFormatOptions = API_CALL_FORMATS.map((value) => ({ label: apiFormatName(value), value }));
    const presetOptions = (["official", "compatible", "local"] as const).map((group) => ({
        label: t(`config.channelEditor.presetGroups.${group}`),
        options: CHANNEL_PRESETS.filter((preset) => preset.group === group).map((preset) => ({ label: channelPresetName(preset, i18n.resolvedLanguage), value: preset.id })),
    }));
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
    /** 每次发起测试或配置变化都换一个编号，过期的测试结果不再写回。 */
    const testRun = useRef(0);
    const resetTest = () => {
        testRun.current += 1;
        setTesting(false);
        setTestResult(null);
    };

    useEffect(() => {
        if (open && channel) setDraft(channel);
        resetTest();
    }, [open, channel]);

    // 地址、Key 或协议改了，上次的测试结果（包括还没返回的）就不再适用。
    useEffect(resetTest, [draft?.baseUrl, draft?.apiKey, draft?.apiFormat]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const currentPreset = findChannelPreset(draft.apiFormat, draft.baseUrl);
    /** 渠道名还是默认名或某个预设名时，换预设顺便改名；用户自己起的名字不动。 */
    const isGenericName = (name: string) => {
        const value = name.trim();
        if (!value || value === t("config.channels.newName") || value === t("config.channels.unnamed")) return true;
        if (CHANNEL_PRESETS.some((preset) => preset.name === value || preset.nameEn === value)) return true;
        const numbered = [t("config.channels.indexedName", { index: "__N__" }), t("config.channels.numberedName", { count: "__N__" })];
        return numbered.some((pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("__N__", "\\d+")}$`).test(value));
    };
    const applyPreset = (id: string) => {
        const preset = CHANNEL_PRESETS.find((item) => item.id === id);
        if (!preset) return;
        patch({ apiFormat: preset.apiFormat, baseUrl: preset.baseUrl, ...(isGenericName(draft.name) ? { name: channelPresetName(preset, i18n.resolvedLanguage) } : {}) });
    };
    const isComfy = draft.apiFormat === "comfyui";
    const saveWorkflow = (value: ComfyWorkflowDraft, previousName?: string) => {
        const entry: ChannelModel = { name: value.name, capability: value.capability, workflow: value.workflow };
        if (previousName) setModels(draft.models.map((model) => (model.name === previousName ? { ...model, ...entry } : model)));
        else setModels([...draft.models, entry]);
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const duplicateWorkflow = (model: ChannelModel) => {
        const name = comfyCopyName(model.name, draft.models.map((item) => item.name), t("config.channelEditor.copySuffix"));
        setModels([...draft.models, { ...model, name }]);
    };
    const exportWorkflow = (model: ChannelModel) => {
        if (model.workflow) saveAs(new Blob([model.workflow], { type: "application/json;charset=utf-8" }), comfyWorkflowFileName(model.name));
    };
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const runTest = async () => {
        const run = ++testRun.current;
        setTesting(true);
        setTestResult(null);
        const result = await testChannelConnection(draft);
        if (run !== testRun.current) return;
        setTestResult(result);
        setTesting(false);
    };

    /** 释放显存或清空本站排队任务；做完后如果已经测过连接，重新测一次刷新显存和队列数。 */
    const runComfyAction = async (action: "free" | "clear") => {
        // 地址、Key 改了或换了渠道会让 testRun 变化；这时不再用旧配置重测，免得旧服务器的结果显示在新渠道下。
        const run = testRun.current;
        setComfyAction(action);
        try {
            if (action === "free") {
                await freeComfyMemory(draft);
                message.success(t("config.channelEditor.freeMemoryDone"));
                // ComfyUI 收到 /free 后要等执行线程空下来才卸载模型，马上测显存数值还没变。
                if (testResult?.ok) await new Promise((resolve) => setTimeout(resolve, FREE_MEMORY_SETTLE_MS));
            } else {
                const count = await clearOwnComfyQueue(draft);
                message.success(count ? t("config.channelEditor.clearQueueDone", { count }) : t("config.channelEditor.clearQueueEmpty"));
            }
            if (testResult?.ok && run === testRun.current) void runTest();
        } catch (error) {
            message.error(t("config.channelEditor.comfyActionFailed", { message: error instanceof Error ? error.message : String(error) }));
        } finally {
            setComfyAction(null);
        }
    };

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || t("config.channels.unnamed"), models: normalizeChannelModels(draft.models) });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.preset")}</span>
                    <Select className="w-full" showSearch optionFilterProp="label" value={currentPreset?.id} placeholder={t("config.channelEditor.presetPlaceholder")} options={presetOptions} onChange={applyPreset} />
                    <span className="mt-1 block text-xs text-stone-500">{t("config.channelEditor.presetHint")}</span>
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <div className="-mt-2 text-xs leading-5 text-stone-500 md:col-span-2">{t(`config.channelEditor.protocolHints.${draft.apiFormat}`)}</div>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">{channelNeedsApiKey(draft) ? "API Key" : t("config.channelEditor.apiKeyOptional")}</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder={channelNeedsApiKey(draft) ? "sk-..." : t("config.channelEditor.apiKeyOptionalPlaceholder")} />
                </label>
                {isComfy ? null : (
                    <label className="block md:col-span-2">
                        <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.maxTokens")}</span>
                        <InputNumber
                            className="!w-full"
                            min={1}
                            precision={0}
                            value={draft.maxTokens ?? null}
                            placeholder={draft.apiFormat === "anthropic" ? String(ANTHROPIC_MAX_TOKENS) : t("config.channelEditor.maxTokensPlaceholder")}
                            onChange={(value) => patch({ maxTokens: normalizeMaxTokens(value) })}
                        />
                        <span className="mt-1 block text-xs text-stone-500">{t(draft.apiFormat === "anthropic" ? "config.channelEditor.maxTokensHintAnthropic" : "config.channelEditor.maxTokensHint", { limit: ANTHROPIC_MAX_TOKENS })}</span>
                    </label>
                )}
                <div className="flex flex-wrap items-start gap-3 md:col-span-2">
                    <Button icon={<Plug className="size-4" />} loading={testing} onClick={() => void runTest()}>
                        {t("config.channelEditor.testConnection")}
                    </Button>
                    {isComfy ? (
                        <>
                            <Tooltip title={t("config.channelEditor.freeMemoryHint")}>
                                <Button data-testid="comfy-free-memory" icon={<MemoryStick className="size-4" />} loading={comfyAction === "free"} disabled={comfyAction === "clear"} onClick={() => void runComfyAction("free")}>
                                    {t("config.channelEditor.freeMemory")}
                                </Button>
                            </Tooltip>
                            <Tooltip title={t("config.channelEditor.clearQueueHint")}>
                                <Button data-testid="comfy-clear-queue" icon={<ListX className="size-4" />} loading={comfyAction === "clear"} disabled={comfyAction === "free"} onClick={() => void runComfyAction("clear")}>
                                    {t("config.channelEditor.clearQueue")}
                                </Button>
                            </Tooltip>
                        </>
                    ) : null}
                    {testResult ? (
                        <div role="status" className={`min-w-0 flex-1 text-sm leading-6 ${isComfy ? "basis-full" : ""} ${testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                            <span className="inline-flex items-center gap-1">
                                {testResult.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                                {testResult.ok
                                    ? testResult.modelCount === undefined
                                        ? t("config.channelEditor.testOk", { ms: testResult.elapsedMs })
                                        : t("config.channelEditor.testOkModels", { ms: testResult.elapsedMs, count: testResult.modelCount })
                                    : t("config.channelEditor.testFailed", { message: testResult.message })}
                            </span>
                            {testResult.ok && testResult.comfy && (testResult.comfy.version || testResult.comfy.devices.length) ? (
                                <span className="block text-xs text-stone-500" data-testid="comfy-system">
                                    {[
                                        testResult.comfy.version ? `ComfyUI ${testResult.comfy.version}` : "",
                                        ...testResult.comfy.devices.map((device) => (device.vramTotalGb ? t("config.channelEditor.comfyDevice", { name: device.name, free: device.vramFreeGb ?? "?", total: device.vramTotalGb }) : device.name)),
                                    ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </span>
                            ) : null}
                            {testResult.ok && testResult.comfy?.queue ? (
                                <span className="block text-xs text-stone-500" data-testid="comfy-queue">
                                    {t("config.channelEditor.comfyQueue", testResult.comfy.queue)}
                                </span>
                            ) : null}
                            {!testResult.ok && testResult.network ? <span className="block text-xs text-stone-500">{t(isComfy ? "config.channelEditor.testNetworkHintComfy" : "config.channelEditor.testNetworkHint")}</span> : null}
                        </div>
                    ) : null}
                </div>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t(isComfy ? "config.channelEditor.workflowDescription" : "config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                {isComfy ? (
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setWorkflowTarget({ value: null })}>
                        {t("config.channelEditor.addWorkflow")}
                    </Button>
                ) : (
                    <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                        {t("config.channelEditor.selectModels")}
                    </Button>
                )}
            </div>

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                <Segmented
                                    size="small"
                                    value={model.capability}
                                    options={isComfy ? capabilityOptions.filter((option) => option.value !== "text") : capabilityOptions}
                                    onChange={(value) => setCapability(model.name, value as ModelCapability)}
                                />
                                {isComfy ? (
                                    <Button
                                        size="small"
                                        type={model.workflow ? "primary" : "default"}
                                        ghost={Boolean(model.workflow)}
                                        danger={!model.workflow}
                                        icon={<Workflow className="size-3.5" />}
                                        onClick={() => setWorkflowTarget({ value: { name: model.name, capability: model.capability, workflow: model.workflow || "" } })}
                                    >
                                        {t(model.workflow ? "config.channelEditor.workflowReady" : "config.channelEditor.workflowMissing")}
                                    </Button>
                                ) : null}
                                {isComfy && model.workflow ? (
                                    <>
                                        <Button size="small" type="text" title={t("config.channelEditor.duplicateWorkflow")} aria-label={t("config.channelEditor.duplicateWorkflow")} data-testid="comfy-duplicate" icon={<Copy className="size-3.5" />} onClick={() => duplicateWorkflow(model)} />
                                        <Button size="small" type="text" title={t("config.channelEditor.exportWorkflow")} aria-label={t("config.channelEditor.exportWorkflow")} data-testid="comfy-export" icon={<Download className="size-3.5" />} onClick={() => exportWorkflow(model)} />
                                    </>
                                ) : null}
                                {isComfy ? null : (
                                    <Button size="small" type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                        {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                    </Button>
                                )}
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t(isComfy ? "config.channelEditor.workflowEmpty" : "config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />

            <ComfyWorkflowEditor open={Boolean(workflowTarget)} value={workflowTarget?.value || null} existingNames={draft.models.map((model) => model.name)} channel={draft} onSave={saveWorkflow} onClose={() => setWorkflowTarget(null)} />

            <ModelScriptEditor
                open={Boolean(scriptTarget)}
                capability={scriptTarget?.capability || "text"}
                modelName={scriptTarget?.name || ""}
                value={scriptTarget?.value || ""}
                onSave={(script) => scriptTarget && setScript(scriptTarget.name, script)}
                onClose={() => setScriptTarget(null)}
            />
        </Drawer>
    );
}
