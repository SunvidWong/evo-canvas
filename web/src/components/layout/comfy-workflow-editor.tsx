import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Segmented } from "antd";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { parseComfyWorkflow } from "@/services/api/comfyui";
import type { ModelCapability } from "@/stores/use-config-store";

export type ComfyWorkflowDraft = { name: string; capability: ModelCapability; workflow: string };

/** 编辑 ComfyUI 渠道里的一个工作流：名称、能力（生图/视频）和 API 格式 JSON。 */
export function ComfyWorkflowEditor({
    open,
    value,
    existingNames,
    onSave,
    onClose,
}: {
    open: boolean;
    /** 为空表示新增。 */
    value: ComfyWorkflowDraft | null;
    existingNames: string[];
    onSave: (draft: ComfyWorkflowDraft, previousName?: string) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ComfyWorkflowDraft>({ name: "", capability: "image", workflow: "" });
    const [error, setError] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(value || { name: "", capability: "image", workflow: "" });
        setError("");
    }, [open, value]);

    const save = () => {
        const name = draft.name.trim();
        if (!name) return setError(t("config.comfyWorkflow.nameRequired"));
        if (name !== value?.name && existingNames.includes(name)) return setError(t("config.comfyWorkflow.nameExists"));
        try {
            parseComfyWorkflow(draft.workflow);
        } catch (parseError) {
            return setError(parseError instanceof Error ? parseError.message : String(parseError));
        }
        onSave({ ...draft, name, workflow: draft.workflow.trim() }, value?.name);
        onClose();
    };

    const importFile = async (file: File | undefined) => {
        if (!file) return;
        const text = await file.text();
        setDraft((current) => ({ ...current, workflow: text, name: current.name || file.name.replace(/\.json$/i, "") }));
        setError("");
    };

    return (
        <Modal
            open={open}
            width={760}
            title={value ? t("config.comfyWorkflow.editTitle") : t("config.comfyWorkflow.addTitle")}
            onCancel={onClose}
            onOk={save}
            okText={t("common.save")}
            cancelText={t("common.cancel")}
            destroyOnHidden
        >
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
                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileRef.current?.click()}>
                            {t("config.comfyWorkflow.import")}
                        </Button>
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
