import { useEffect, useState } from "react";
import { App, Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { fetchCodexProvider, updateCodexProvider, type CodexProviderSummary } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

/** Codex Agent 的模型接口：留空时用本机 Codex 登录的账号；填了地址和模型就走兼容 OpenAI Responses 接口的第三方服务或本地模型。Key 只保存在本机 Agent 配置里。 */
export function AgentCodexProvider() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const url = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const connected = useAgentStore((state) => state.connected);
    const endpoint = url.trim().replace(/\/$/, "");
    const { message } = App.useApp();
    const [summary, setSummary] = useState<CodexProviderSummary | null>(null);
    const [baseUrl, setBaseUrl] = useState("");
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [saving, setSaving] = useState(false);

    const apply = (data: CodexProviderSummary) => {
        setSummary(data);
        setBaseUrl(data.baseUrl);
        setModel(data.model);
        setApiKey("");
    };

    useEffect(() => {
        if (!connected) return;
        fetchCodexProvider(endpoint, token)
            .then((result) => result.data && apply(result.data))
            .catch(() => setSummary(null));
    }, [connected, endpoint, token]);

    if (!connected || !summary) return null;

    const save = async (patch: { baseUrl?: string; model?: string; apiKey?: string }) => {
        setSaving(true);
        try {
            const result = await updateCodexProvider(endpoint, token, patch);
            if (result.data) apply(result.data);
            message.success(t("agent.codexProvider.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("agent.codexProvider.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const status = summary.active ? t("agent.codexProvider.active", { url: summary.baseUrl, model: summary.model }) : summary.baseUrl || summary.model ? t("agent.codexProvider.incomplete") : t("agent.codexProvider.official");

    return (
        <section className="space-y-3 rounded-lg border p-3" style={{ borderColor: theme.node.stroke }} aria-label={t("agent.codexProvider.title")} data-testid="codex-provider">
            <div>
                <div className="text-sm font-medium leading-5">{t("agent.codexProvider.title")}</div>
                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                    {t("agent.codexProvider.description")}
                </div>
            </div>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.codexProvider.baseUrl")}</span>
                <Input size="small" value={baseUrl} placeholder="http://127.0.0.1:11434/v1" onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.codexProvider.apiKey")}</span>
                <Input.Password size="small" value={apiKey} placeholder={summary.hasKey ? t("agent.codexProvider.keyKept") : t("agent.codexProvider.keyPlaceholder")} onChange={(event) => setApiKey(event.target.value)} />
            </label>
            <label className="block">
                <span className="mb-1 block text-xs font-medium">{t("agent.codexProvider.model")}</span>
                <Input size="small" value={model} placeholder={t("agent.codexProvider.modelPlaceholder")} onChange={(event) => setModel(event.target.value)} />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
                {summary.baseUrl || summary.hasKey || summary.model ? (
                    <Button size="small" disabled={saving} onClick={() => void save({ baseUrl: "", model: "", apiKey: "" })}>
                        {t("agent.codexProvider.reset")}
                    </Button>
                ) : null}
                <Button size="small" type="primary" loading={saving} onClick={() => void save({ baseUrl, model, ...(apiKey ? { apiKey } : {}) })}>
                    {t("agent.codexProvider.save")}
                </Button>
            </div>
            <div className="text-xs leading-5" style={{ color: theme.node.muted }} data-testid="codex-provider-status">
                {status}
            </div>
            {summary.restartPending ? (
                <div className="text-xs leading-5" style={{ color: "#d97706" }}>
                    {t("agent.codexProvider.restartPending")}
                </div>
            ) : null}
        </section>
    );
}
