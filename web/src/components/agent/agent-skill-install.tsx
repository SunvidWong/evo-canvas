import { useState } from "react";
import { App, Button, Input, Modal } from "antd";
import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { installCodexSkill, previewCodexSkillInstall, type AgentSkillInstallPreview } from "@/services/api/canvas-agent";

/** 从 GitHub 链接预览并安装 Skill；先预览文件和说明，用户确认后才写入本地。 */
export function AgentSkillInstallModal({ open, endpoint, token, theme, onClose, onInstalled }: {
    open: boolean;
    endpoint: string;
    token: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onClose: () => void;
    onInstalled: () => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState<"" | "preview" | "install">("");
    const [preview, setPreview] = useState<AgentSkillInstallPreview | null>(null);
    const [error, setError] = useState("");

    const close = () => {
        if (loading) return;
        setPreview(null);
        setError("");
        onClose();
    };

    const runPreview = async () => {
        setLoading("preview");
        setError("");
        setPreview(null);
        try {
            setPreview((await previewCodexSkillInstall(endpoint, token, url.trim())).data || null);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : t("agent.skillManager.install.previewFailed"));
        } finally {
            setLoading("");
        }
    };

    const install = async () => {
        if (!preview) return;
        setLoading("install");
        try {
            await installCodexSkill(endpoint, token, preview.id);
            message.success(t("agent.skillManager.install.installed", { name: preview.name }));
            setLoading("");
            setUrl("");
            close();
            await onInstalled();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : t("agent.skillManager.install.installFailed"));
            setLoading("");
        }
    };

    return (
        <Modal
            open={open}
            title={t("agent.skillManager.install.title")}
            width={640}
            centered
            destroyOnHidden
            okText={t("agent.skillManager.install.confirm")}
            cancelText={t("common.cancel")}
            okButtonProps={{ disabled: !preview, loading: loading === "install" }}
            onOk={() => void install()}
            onCancel={close}
        >
            <div className="space-y-3">
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.skillManager.install.description")}</div>
                <div className="flex gap-2">
                    <Input value={url} placeholder="https://github.com/owner/repo/tree/main/skills/my-skill" aria-label={t("agent.skillManager.install.url")} onChange={(event) => { setUrl(event.target.value); setPreview(null); }} onPressEnter={() => { if (url.trim()) void runPreview(); }} />
                    <Button loading={loading === "preview"} disabled={!url.trim() || Boolean(loading)} onClick={() => void runPreview()}>{t("agent.skillManager.install.preview")}</Button>
                </div>
                {error ? <div className="rounded-md border border-red-500/30 px-3 py-2 text-xs leading-5 text-red-500">{error}</div> : null}
                {preview ? (
                    <div className="space-y-3 rounded-md border p-3" style={{ borderColor: theme.node.stroke }}>
                        <div>
                            <div className="font-mono text-sm font-medium">{preview.name}</div>
                            <div className="mt-1 text-sm leading-5">{preview.description}</div>
                            <div className="mt-1 break-all text-xs" style={{ color: theme.node.muted }}>{t("agent.skillManager.install.source", { source: preview.source, count: preview.files.length, size: formatSize(preview.totalSize) })}</div>
                        </div>
                        <div className="thin-scrollbar max-h-32 overflow-y-auto rounded border" style={{ borderColor: theme.node.stroke }}>
                            {preview.files.map((file) => (
                                <div key={file.path} className="flex items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0" style={{ borderColor: theme.node.stroke }}>
                                    <FileText className="size-3.5 shrink-0 opacity-60" />
                                    <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                                    <span style={{ color: theme.node.muted }}>{formatSize(file.size)}</span>
                                </div>
                            ))}
                        </div>
                        <details>
                            <summary className="cursor-pointer text-xs" style={{ color: theme.node.muted }}>{t("agent.skillManager.install.instructions")}</summary>
                            <pre className="thin-scrollbar mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs leading-5" style={{ borderColor: theme.node.stroke }}>{preview.instructions}</pre>
                        </details>
                        <div className="text-xs leading-5 text-amber-600">{t("agent.skillManager.install.trustHint")}</div>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

function formatSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
