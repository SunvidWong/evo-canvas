import { useEffect, useState } from "react";
import { App, Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { fetchClaudeProvider, updateClaudeProvider, type ClaudeProviderSummary } from "@/services/api/canvas-agent";

/** Claude Agent 的模型接口：留空时用本机 Claude 登录的账号；填了就走兼容 Anthropic 接口的第三方服务或本地网关。Token 只保存在本机 Agent 配置里。 */
export function AgentClaudeProvider({ endpoint, token, connected, theme }: { endpoint: string; token: string; connected: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [summary, setSummary] = useState<ClaudeProviderSummary | null>(null);
    const [baseUrl, setBaseUrl] = useState("");
    const [model, setModel] = useState("");
    const [authToken, setAuthToken] = useState("");
    const [saving, setSaving] = useState(false);

    const apply = (data: ClaudeProviderSummary) => {
        setSummary(data);
        setBaseUrl(data.baseUrl);
        setModel(data.model);
        setAuthToken("");
    };

    useEffect(() => {
        if (!connected) return;
        fetchClaudeProvider(endpoint, token)
            .then((result) => result.data && apply(result.data))
            .catch(() => setSummary(null));
    }, [connected, endpoint, token]);

    if (!connected || !summary) return null;

    const save = async (patch: { baseUrl?: string; model?: string; authToken?: string }) => {
        setSaving(true);
        try {
            const result = await updateClaudeProvider(endpoint, token, patch);
            if (result.data) apply(result.data);
            message.success(t("agent.claudeProvider.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.claudeProvider.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="space-y-3 rounded-lg border p-3" style={{ borderColor: theme.node.stroke }} aria-label={t("agent.claudeProvider.title")}>
            <div>
                <div className="text-sm font-medium leading-5">{t("agent.claudeProvider.title")}</div>
                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                    {t("agent.claudeProvider.description")}
                </div>
            </div>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.claudeProvider.baseUrl")}</span>
                <Input size="small" value={baseUrl} placeholder="https://api.example.com/anthropic" onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.claudeProvider.authToken")}</span>
                <Input.Password size="small" value={authToken} placeholder={summary.hasToken ? t("agent.claudeProvider.tokenKept") : t("agent.claudeProvider.tokenPlaceholder")} onChange={(event) => setAuthToken(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.claudeProvider.model")}</span>
                <Input size="small" value={model} placeholder={t("agent.claudeProvider.modelPlaceholder")} onChange={(event) => setModel(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
                {summary.baseUrl || summary.hasToken || summary.model ? (
                    <Button size="small" disabled={saving} onClick={() => void save({ baseUrl: "", model: "", authToken: "" })}>
                        {t("agent.claudeProvider.reset")}
                    </Button>
                ) : null}
                <Button size="small" type="primary" loading={saving} onClick={() => void save({ baseUrl, model, ...(authToken ? { authToken } : {}) })}>
                    {t("agent.claudeProvider.save")}
                </Button>
            </div>
            <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                {summary.baseUrl ? t("agent.claudeProvider.active", { url: summary.baseUrl }) : t("agent.claudeProvider.official")}
            </div>
        </section>
    );
}
