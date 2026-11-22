import { Button, Drawer, Input, InputNumber, Segmented, Select, Space } from "antd";
import { ListPlus, Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHANNEL_PRESETS, channelPresetName, findChannelPreset } from "@/lib/channel-presets";
import { ANTHROPIC_MAX_TOKENS } from "@/services/api/anthropic";
import { API_CALL_FORMATS, apiFormatName, channelNeedsApiKey, normalizeMaxTokens, defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ComfyWorkflowEditor, type ComfyWorkflowDraft } from "./comfy-workflow-editor";
import { ModelScriptEditor } from "./model-script-editor";
import { ModelSelectModal } from "./model-select-modal";

type ScriptTarget = { name: string; capability: ModelCapability; value: string };

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t, i18n } = useTranslation();
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

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

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
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

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
                    <Select
                        className="w-full"
                        showSearch
                        optionFilterProp="label"
                        value={currentPreset?.id}
                        placeholder={t("config.channelEditor.presetPlaceholder")}
                        options={presetOptions}
                        onChange={applyPreset}
                    />
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
                                <Segmented size="small" value={model.capability} options={isComfy ? capabilityOptions.filter((option) => option.value === "image" || option.value === "video") : capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                {isComfy ? (
                                    <Button size="small" type={model.workflow ? "primary" : "default"} ghost={Boolean(model.workflow)} danger={!model.workflow} icon={<Workflow className="size-3.5" />} onClick={() => setWorkflowTarget({ value: { name: model.name, capability: model.capability, workflow: model.workflow || "" } })}>
                                        {t(model.workflow ? "config.channelEditor.workflowReady" : "config.channelEditor.workflowMissing")}
                                    </Button>
                                ) : (
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

            <ComfyWorkflowEditor
                open={Boolean(workflowTarget)}
                value={workflowTarget?.value || null}
                existingNames={draft.models.map((model) => model.name)}
                onSave={saveWorkflow}
                onClose={() => setWorkflowTarget(null)}
            />

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
