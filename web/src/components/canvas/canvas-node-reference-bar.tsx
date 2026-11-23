import { FileText, Image as ImageIcon, Music2, Plus, Puzzle, Video, X } from "lucide-react";
import { Popover, Tooltip } from "antd";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews } from "@/services/image-storage";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasNodeReferenceBar({ nodeId, nodes, connectedNodes, onDisconnect, onStartSelection }: { nodeId: string; nodes: CanvasNodeData[]; connectedNodes: CanvasNodeData[]; onDisconnect?: (fromNodeId: string, toNodeId: string) => void; onStartSelection?: (nodeId: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const overwrite = useConfigStore((state) => state.config.nodeRegenerateBehavior === "overwrite");
    const references = connectedNodes.flatMap((sourceNode) => (sourceNode.type === CanvasNodeType.Group ? getGroupResourceNodes(sourceNode.id, nodes) : [sourceNode]).map((node) => ({ node, sourceNodeId: sourceNode.id })));
    // 有图的图片节点再生成时，自己的图也会作为参考图（覆盖模式除外），这里显示出来，和实际发出的张数一致。
    const targetNode = nodes.find((node) => node.id === nodeId && node.type === CanvasNodeType.Image);
    // 局部重绘的结果再生成时沿用原图和蒙版，不把自己的图当参考，改为显示沿用的蒙版标注。
    const inpaintOverlay = targetNode?.metadata?.inpaintMask ? targetNode.metadata.references?.[1] : undefined;
    const selfNode = overwrite || inpaintOverlay ? undefined : targetNode?.metadata?.content ? targetNode : undefined;
    return (
        <div className="mb-2">
            <div className="mb-1.5 text-[11px] font-medium" style={{ color: theme.node.muted }}>{t("canvas.references.title")}</div>
            <div className="thin-scrollbar flex min-h-12 gap-2 overflow-x-auto pb-1">
                {references.map(({ node, sourceNodeId }) => <ReferenceItem key={`${sourceNodeId}:${node.id}`} node={node} onRemove={() => onDisconnect?.(sourceNodeId, nodeId)} />)}
                {selfNode ? <SelfReferenceItem node={selfNode} /> : null}
                {inpaintOverlay ? <InpaintMaskItem overlay={inpaintOverlay} /> : null}
                <button type="button" className="grid size-12 shrink-0 place-items-center rounded-xl border bg-transparent transition hover:opacity-70" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }} title={t("canvas.references.select")} onClick={() => onStartSelection?.(nodeId)}>
                    <Plus className="size-4" />
                </button>
            </div>
        </div>
    );
}

function ReferenceItem({ node, onRemove }: { node: CanvasNodeData; onRemove: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    const content = node.metadata?.content || resource?.url;
    const thumbnail = previewUrlFor(node.metadata?.storageKey) || content;
    const Icon = resource?.kind === "image" || node.type === CanvasNodeType.Image ? ImageIcon : resource?.kind === "video" || node.type === CanvasNodeType.Video ? Video : resource?.kind === "audio" || node.type === CanvasNodeType.Audio ? Music2 : resource?.kind === "text" || node.type === CanvasNodeType.Text ? FileText : Puzzle;
    return (
        <Popover placement="topLeft" mouseEnterDelay={0.15} content={<ReferencePreview node={node} content={content} />}>
            <div className="group relative grid size-12 shrink-0 place-items-center rounded-xl border" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }}>
                <span className="grid size-full place-items-center overflow-hidden rounded-[inherit]">
                    {(resource?.kind === "image" || node.type === CanvasNodeType.Image) && thumbnail ? <img src={thumbnail} alt="" className="size-full object-cover" /> : (resource?.kind === "video" || node.type === CanvasNodeType.Video) && content ? <video src={content} className="size-full object-cover" muted /> : <Icon className="size-4 opacity-65" />}
                </span>
                <button type="button" className="absolute right-0 top-0 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }} aria-label={t("canvas.references.disconnect")} title={t("canvas.references.disconnect")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove(); }}><X className="size-3" /></button>
            </div>
        </Popover>
    );
}

function SelfReferenceItem({ node }: { node: CanvasNodeData }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnail = previewUrlFor(node.metadata?.storageKey) || node.metadata?.content;
    return (
        <Tooltip title={t("canvas.references.selfHint")}>
            <div className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }} data-testid="reference-self">
                {thumbnail ? <img src={thumbnail} alt="" className="size-full object-cover" /> : <ImageIcon className="size-4 opacity-65" />}
                <span className="absolute inset-x-0 bottom-0 bg-black/55 text-center text-[9px] leading-4 text-white">{t("canvas.references.self")}</span>
            </div>
        </Tooltip>
    );
}

function InpaintMaskItem({ overlay }: { overlay: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [resolved, setResolved] = useState("");
    useEffect(() => {
        let alive = true;
        if (overlay.startsWith("image:")) void resolveImageUrl(overlay).then((url) => alive && setResolved(url));
        return () => {
            alive = false;
        };
    }, [overlay]);
    const thumbnail = overlay.startsWith("image:") ? previewUrlFor(overlay) || resolved : overlay;
    return (
        <Tooltip title={t("canvas.references.inpaintHint")}>
            <div className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed" style={{ background: theme.toolbar.activeBg, borderColor: theme.toolbar.border }} data-testid="reference-inpaint">
                {thumbnail ? <img src={thumbnail} alt="" className="size-full object-cover" /> : <ImageIcon className="size-4 opacity-65" />}
                <span className="absolute inset-x-0 bottom-0 bg-black/55 text-center text-[9px] leading-4 text-white">{t("canvas.references.inpaint")}</span>
            </div>
        </Tooltip>
    );
}

function ReferencePreview({ node, content }: { node: CanvasNodeData; content?: string }) {
    const { t } = useTranslation();
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    if ((resource?.kind === "image" || node.type === CanvasNodeType.Image) && content) return <img src={content} alt={node.title} className="max-h-52 w-72 rounded-lg object-contain" />;
    if ((resource?.kind === "video" || node.type === CanvasNodeType.Video) && content) return <video src={content} className="max-h-52 w-72 rounded-lg" muted controls />;
    if ((resource?.kind === "audio" || node.type === CanvasNodeType.Audio) && content) return <audio src={content} className="w-72" controls />;
    return <div className="max-h-52 w-72 overflow-auto whitespace-pre-wrap text-sm">{resource?.text || node.metadata?.content || node.metadata?.prompt || node.title || t("canvas.references.empty")}</div>;
}
