import type { ComfyWorkflow } from "./comfyui";

/** ComfyUI 普通保存格式（界面格式）里的节点和连线。 */
type UiInput = { name: string; type?: string; link?: number | null; widget?: { name: string } };
type UiNode = { id: number | string; type: string; mode?: number; title?: string; inputs?: UiInput[]; widgets_values?: unknown[] | Record<string, unknown> };
type UiLink = [number, number | string, number, number | string, number, string?];
export type ComfyUiWorkflow = { nodes: UiNode[]; links: UiLink[]; definitions?: { subgraphs?: unknown[] } };
/** /object_info 里单个节点的定义。 */
type InputSpec = [unknown, Record<string, unknown>?] | [unknown];
export type ComfyNodeDefinition = { input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> }; input_order?: { required?: string[]; optional?: string[] }; display_name?: string };
export type ComfyObjectInfo = Record<string, ComfyNodeDefinition>;

export type ComfyConvertResult = { workflow: ComfyWorkflow; missing: string[] };

/** 只在界面里起作用、不会提交给 ComfyUI 的节点。 */
const UI_ONLY_NODES = new Set(["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]);
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SEED_CONTROLS = new Set(["fixed", "increment", "decrement", "randomize"]);
/** 节点模式：2 = 静音（不执行），4 = 绕过（输入直通到下游）。 */
const MODE_MUTED = 2;
const MODE_BYPASS = 4;

export class ComfySubgraphError extends Error {}

/** 判断是不是 ComfyUI 普通保存格式（带 nodes 和 links）。 */
export function isComfyUiWorkflow(value: unknown): value is ComfyUiWorkflow {
    return Boolean(value) && typeof value === "object" && Array.isArray((value as ComfyUiWorkflow).nodes) && Array.isArray((value as ComfyUiWorkflow).links);
}

function isWidgetInput(spec: InputSpec | undefined) {
    const type = spec?.[0];
    return Array.isArray(type) || (typeof type === "string" && WIDGET_TYPES.has(type));
}

function inputNames(definition: ComfyNodeDefinition) {
    const required = definition.input_order?.required || Object.keys(definition.input?.required || {});
    const optional = definition.input_order?.optional || Object.keys(definition.input?.optional || {});
    return [...required, ...optional].map((name) => ({ name, spec: definition.input?.required?.[name] || definition.input?.optional?.[name] }));
}

/** 按节点定义把 widgets_values 对应到参数名；seed 后面的「生成后控制」值要跳过。 */
function widgetValues(node: UiNode, definition: ComfyNodeDefinition) {
    const result: Record<string, unknown> = {};
    const values = node.widgets_values;
    if (!values) return result;
    const widgets = inputNames(definition).filter((item) => isWidgetInput(item.spec));
    if (!Array.isArray(values)) {
        for (const { name } of widgets) if (name in values) result[name] = values[name];
        return result;
    }
    let index = 0;
    for (const { name, spec } of widgets) {
        if (index >= values.length) break;
        result[name] = values[index++];
        const hasControl = spec?.[1]?.control_after_generate || ((name === "seed" || name === "noise_seed") && spec?.[0] === "INT");
        if (hasControl && typeof values[index] === "string" && SEED_CONTROLS.has(values[index] as string)) index += 1;
    }
    return result;
}

/**
 * 把 ComfyUI 普通保存格式转成 API 格式，规则和 ComfyUI「导出（API）」一致：
 * 去掉 Note、Reroute（连线穿透）、PrimitiveNode（值写到连接的输入上）；静音节点删掉，绕过节点把同类型输入直通到下游。
 * 返回转换结果和 /object_info 里找不到的节点类型（通常是没安装的自定义节点）。
 */
export function convertComfyUiWorkflow(ui: ComfyUiWorkflow, objectInfo: ComfyObjectInfo): ComfyConvertResult {
    if (ui.definitions?.subgraphs?.length) throw new ComfySubgraphError("subgraph");
    const nodes = new Map(ui.nodes.map((node) => [String(node.id), node]));
    const links = new Map(ui.links.filter((link) => Array.isArray(link)).map((link) => [link[0], link]));
    const missing = new Set<string>();

    /** 顺着连线找到真正的来源：穿过 Reroute 和绕过节点；PrimitiveNode 直接给出它的值。 */
    const resolve = (linkId: number | null | undefined, seen = new Set<number>()): { ref: [string, number] } | { value: unknown } | undefined => {
        if (linkId === null || linkId === undefined || seen.has(linkId)) return undefined;
        seen.add(linkId);
        const link = links.get(linkId);
        const origin = link ? nodes.get(String(link[1])) : undefined;
        if (!link || !origin) return undefined;
        if (origin.type === "Reroute") return resolve(origin.inputs?.[0]?.link, seen);
        if (origin.type === "PrimitiveNode") return { value: Array.isArray(origin.widgets_values) ? origin.widgets_values[0] : undefined };
        if (origin.mode === MODE_MUTED) return undefined;
        if (origin.mode === MODE_BYPASS) {
            const type = link[5] || origin.inputs?.find((input) => input.link !== null && input.link !== undefined)?.type;
            const through = origin.inputs?.find((input) => input.type === type && input.link !== null && input.link !== undefined);
            return through ? resolve(through.link, seen) : undefined;
        }
        return { ref: [String(origin.id), link[2]] };
    };

    const workflow: ComfyWorkflow = {};
    for (const node of ui.nodes) {
        if (UI_ONLY_NODES.has(node.type) || node.mode === MODE_MUTED || node.mode === MODE_BYPASS) continue;
        const definition = objectInfo[node.type];
        if (!definition) {
            missing.add(node.type);
            continue;
        }
        const inputs = widgetValues(node, definition);
        for (const input of node.inputs || []) {
            if (input.link === null || input.link === undefined) continue;
            const source = resolve(input.link);
            const name = input.widget?.name || input.name;
            if (!source) {
                delete inputs[name];
                continue;
            }
            inputs[name] = "ref" in source ? source.ref : source.value;
        }
        workflow[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title || definition.display_name || node.type } };
    }
    return { workflow, missing: Array.from(missing) };
}
