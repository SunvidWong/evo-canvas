import i18n from "@/i18n";
import { channelNeedsApiKey, type ModelChannel } from "@/stores/use-config-store";
import { checkComfyConnection } from "./comfyui";
import { fetchChannelModels } from "./image";

export type ChannelTestResult = { ok: true; elapsedMs: number; modelCount?: number } | { ok: false; elapsedMs: number; message: string; network: boolean };

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const NETWORK_ERROR = /failed to fetch|network ?error|load failed|err_network|err_connection/i;

/** 浏览器把跨域拦截、地址不通都报成同一种网络错误，这类错误需要额外提示 CORS 或代理。 */
export function isNetworkErrorMessage(message: string) {
    return NETWORK_ERROR.test(message) || message === apiText("requestFailed") || message === apiText("comfyUnreachable");
}

/** 按协议请求一个只读接口，确认地址和 Key 可用：模型列表，或 ComfyUI 的 /system_stats。 */
export async function testChannelConnection(channel: ModelChannel, now: () => number = () => performance.now()): Promise<ChannelTestResult> {
    const started = now();
    const elapsed = () => Math.round(now() - started);
    if (!channel.baseUrl.trim()) return { ok: false, elapsedMs: 0, message: apiText("baseUrlRequired"), network: false };
    if (channelNeedsApiKey(channel) && !channel.apiKey.trim()) return { ok: false, elapsedMs: 0, message: apiText("apiKeyRequired"), network: false };
    try {
        if (channel.apiFormat === "comfyui") {
            await checkComfyConnection(channel);
            return { ok: true, elapsedMs: elapsed() };
        }
        const models = await fetchChannelModels(channel);
        return { ok: true, elapsedMs: elapsed(), modelCount: models.length };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, elapsedMs: elapsed(), message, network: isNetworkErrorMessage(message) };
    }
}
