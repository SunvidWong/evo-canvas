import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Tooltip } from "antd";
import { Eye, FileText, LoaderCircle, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { deleteCodexSkillFile, fetchCodexSkillFile, fetchCodexSkillFiles, uploadCodexSkillFile, type AgentSkillFile, type AgentSkillFileContent } from "@/services/api/canvas-agent";

const FOLDER_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** 在 Skill 编辑弹窗里查看、上传、删除脚本和参考文件；路径校验由本地 Agent 负责，前端只做提示。 */
export function AgentSkillFiles({ endpoint, token, name, theme }: { endpoint: string; token: string; name: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [files, setFiles] = useState<AgentSkillFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [folder, setFolder] = useState("");
    const [preview, setPreview] = useState<AgentSkillFileContent | null>(null);

    const load = async () => {
        setLoading(true);
        try {
            setFiles((await fetchCodexSkillFiles(endpoint, token, name)).data || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.skillManager.files.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { void load(); }, [endpoint, token, name]); // eslint-disable-line react-hooks/exhaustive-deps

    const folderPath = folder.trim().replace(/^\/+|\/+$/g, "");
    const folderValid = !folderPath || FOLDER_PATTERN.test(folderPath);

    const upload = async (list: FileList | null) => {
        if (!list?.length || !folderValid) return;
        setBusy(true);
        try {
            for (const file of Array.from(list)) {
                const content = await fileBase64(file);
                await uploadCodexSkillFile(endpoint, token, name, folderPath ? `${folderPath}/${file.name}` : file.name, content);
            }
            message.success(t("agent.skillManager.files.uploaded", { count: list.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.skillManager.files.uploadFailed"));
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = "";
            await load();
        }
    };

    const remove = (file: AgentSkillFile) => modal.confirm({
        title: t("agent.skillManager.files.deleteTitle", { path: file.path }),
        content: t("agent.skillManager.files.deleteDescription"),
        okButtonProps: { danger: true },
        onOk: async () => {
            try {
                await deleteCodexSkillFile(endpoint, token, name, file.path);
                message.success(t("agent.skillManager.files.deleted", { path: file.path }));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("agent.skillManager.files.deleteFailed"));
            }
            await load();
        },
    });

    const view = async (file: AgentSkillFile) => {
        try {
            const data = (await fetchCodexSkillFile(endpoint, token, name, file.path)).data;
            if (data) setPreview(data);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.skillManager.files.readFailed"));
        }
    };

    return (
        <div className="space-y-3">
            <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.skillManager.files.description")}</div>
            <div className="flex flex-wrap items-center gap-2">
                <Input className="min-w-48 flex-1" value={folder} status={folderValid ? undefined : "error"} placeholder={t("agent.skillManager.files.folderPlaceholder")} aria-label={t("agent.skillManager.files.folder")} onChange={(event) => setFolder(event.target.value)} />
                <Button icon={busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} disabled={busy || !folderValid} onClick={() => inputRef.current?.click()}>{t("agent.skillManager.files.upload")}</Button>
                <input ref={inputRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
            </div>
            {!folderValid ? <div className="text-xs text-red-500">{t("agent.skillManager.files.invalidFolder")}</div> : null}
            <div className="rounded-md border" style={{ borderColor: theme.node.stroke }}>
                {loading ? <div className="flex justify-center py-4"><LoaderCircle className="size-4 animate-spin opacity-60" /></div>
                    : files.length ? files.map((file) => (
                        <div key={file.path} className="flex min-w-0 items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0" style={{ borderColor: theme.node.stroke }}>
                            <FileText className="size-4 shrink-0 opacity-60" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>{file.path}</span>
                            <span className="shrink-0 text-xs" style={{ color: theme.node.muted }}>{formatSize(file.size)}</span>
                            <Tooltip title={t("agent.skillManager.files.view", { path: file.path })}><Button type="text" size="small" icon={<Eye className="size-3.5" />} aria-label={t("agent.skillManager.files.view", { path: file.path })} onClick={() => void view(file)} /></Tooltip>
                            <Tooltip title={t("agent.skillManager.files.deleteTitle", { path: file.path })}><Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={t("agent.skillManager.files.deleteTitle", { path: file.path })} onClick={() => remove(file)} /></Tooltip>
                        </div>
                    ))
                    : <div className="px-3 py-4 text-center text-xs" style={{ color: theme.node.muted }}>{t("agent.skillManager.files.empty")}</div>}
            </div>
            <Modal open={Boolean(preview)} title={preview?.path} footer={null} width={720} onCancel={() => setPreview(null)} destroyOnHidden>
                {preview?.binary ? <div className="py-4 text-sm" style={{ color: theme.node.muted }}>{t("agent.skillManager.files.binary")}</div>
                    : <pre className="thin-scrollbar max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-xs leading-5" style={{ borderColor: theme.node.stroke }}>{preview?.text}</pre>}
            </Modal>
        </div>
    );
}

function fileBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
        reader.onerror = () => reject(reader.error || new Error("read failed"));
        reader.readAsDataURL(file);
    });
}

function formatSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
