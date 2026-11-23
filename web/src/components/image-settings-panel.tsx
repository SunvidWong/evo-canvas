import { type ReactNode, useState } from "react";
import { ConfigProvider, Switch, Tooltip } from "antd";
import { Dices } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, readMediaDimensions } from "@/lib/media-size";
import { COMFY_MAX_CFG, COMFY_MAX_SEED, COMFY_MAX_STEPS, parseComfyOverrides } from "@/services/api/comfyui";
import { isComfyModel, type AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", labelKey: "auto" },
    { value: "low", labelKey: "low" },
    { value: "medium", labelKey: "medium" },
    { value: "high", labelKey: "high" },
    { value: "xhigh", labelKey: "xhigh" },
    { value: "max", labelKey: "max" },
];
const DIMENSION_STEP = 16;

export const imageQualityOptions = qualityOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.labelKey}`); } }));
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value }));

export type ImageSettingKey = "quality" | "size" | "count" | "background" | "comfySteps" | "comfyCfg" | "comfySeed";

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: ImageSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10 }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => applySize(scale, selectedRatio === "auto" ? "1:1" : selectedRatio);
    const selectRatio = (ratio: string) => applySize(selectedScale, ratio);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep)}x${alignDimension(height, snapDimensionToStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.image.title")}</div> : null}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.quality")}</SettingTitle>
                    <div className="grid grid-cols-3 gap-2.5">
                        {qualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {t(`settingsPanels.common.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                {t("settingsPanels.image.align16")}
                            </span>
                            <span title={t("settingsPanels.image.align16Hint")} onMouseDown={(event) => event.stopPropagation()}>
                                <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                            </span>
                        </div>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} onChange={(value) => updateDimension("height", value)} />
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaScaleOptions.map((value) => (
                            <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                {value === "auto" ? t("settingsPanels.common.auto") : value}
                            </OptionPill>
                        ))}
                    </div>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {mediaRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectRatio(item.value)}
                            >
                                <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                        <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                            {t("settingsPanels.image.transparentHint")}
                        </div>
                    </div>
                    <span onMouseDown={(event) => event.stopPropagation()}>
                        <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                    </span>
                </div>
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {t("settingsPanels.image.images", { count: value })}
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
                {isComfyModel(config, config.model) ? <ComfyOverrides config={config} theme={theme} onConfigChange={onConfigChange} /> : null}
            </div>
        </ImageSettingsTheme>
    );
}

/** ComfyUI 渠道的模型才显示：单次覆盖步数、CFG、种子，留空用工作流里的值。 */
function ComfyOverrides({ config, theme, onConfigChange }: { config: AiConfig; theme: CanvasTheme; onConfigChange: ImageSettingsPanelProps["onConfigChange"] }) {
    const { t } = useTranslation();
    const fields = [
        { key: "comfySteps" as const, label: t("settingsPanels.image.comfySteps"), placeholder: t("settingsPanels.image.comfyDefault"), max: COMFY_MAX_STEPS, min: 1, step: 1 },
        { key: "comfyCfg" as const, label: t("settingsPanels.image.comfyCfg"), placeholder: t("settingsPanels.image.comfyDefault"), max: COMFY_MAX_CFG, min: 0, step: 0.1 },
        { key: "comfySeed" as const, label: t("settingsPanels.image.comfySeed"), placeholder: t("settingsPanels.image.comfyRandom"), max: COMFY_MAX_SEED, min: 0, step: 1 },
    ];
    const hasValue = fields.some((field) => config[field.key]);
    return (
        <div className="space-y-2.5" data-testid="comfy-overrides">
            <div className="flex items-center justify-between gap-3">
                <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.comfyTitle")}</SettingTitle>
                {hasValue ? (
                    <button type="button" className="cursor-pointer border-0 bg-transparent p-0 underline-offset-2 hover:underline" style={{ color: theme.node.muted, fontSize: 12 }} onMouseDown={(event) => event.stopPropagation()} onClick={() => fields.forEach((field) => onConfigChange(field.key, ""))}>
                        {t("settingsPanels.image.comfyClear")}
                    </button>
                ) : null}
            </div>
            <div className="grid grid-cols-[1fr_1fr_1.6fr] gap-2.5">
                {fields.map((field) => (
                    <label key={field.key} className="flex h-9 min-w-0 items-center overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
                        <span className="shrink-0 px-2 text-xs" style={{ color: theme.node.muted }}>
                            {field.label}
                        </span>
                        <input
                            type="number"
                            data-testid={`comfy-override-${field.key}`}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            placeholder={field.placeholder}
                            className="min-w-0 flex-1 bg-transparent pr-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            defaultValue={config[field.key] || ""}
                            key={`${field.key}-${config[field.key] || ""}`}
                            onBlur={(event) => {
                                // 不合法（超范围、种子或步数带小数）就清空，回到工作流里的值。
                                const raw = event.currentTarget.value.trim();
                                const valid = raw && Object.values(parseComfyOverrides({ [field.key]: raw })).length ? raw : "";
                                event.currentTarget.value = valid;
                                if (valid !== (config[field.key] || "")) onConfigChange(field.key, valid);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                        {field.key === "comfySeed" ? (
                            <Tooltip title={t("settingsPanels.image.comfyRandomSeed")}>
                                <button type="button" data-testid="comfy-random-seed" className="grid h-full w-8 shrink-0 cursor-pointer place-items-center bg-transparent" style={{ color: theme.node.muted }} onMouseDown={(event) => event.stopPropagation()} onClick={() => onConfigChange("comfySeed", String(Math.floor(Math.random() * COMFY_MAX_SEED)))}>
                                    <Dices className="size-3.5" />
                                </button>
                            </Tooltip>
                        ) : null}
                    </label>
                ))}
            </div>
            <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                {t("settingsPanels.image.comfyHint")}
            </div>
        </div>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: {
                    Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text },
                    Slider: { railBg: theme.node.stroke, railHoverBg: theme.node.stroke, trackBg: theme.node.activeStroke, handleColor: theme.node.text, handleActiveColor: theme.node.text },
                },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return qualityOptions.some((item) => item.value === value) ? i18n.t(`settingsPanels.common.${value}`) : value;
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean) {
    return enabled ? Math.ceil(value / DIMENSION_STEP) * DIMENSION_STEP : value;
}
