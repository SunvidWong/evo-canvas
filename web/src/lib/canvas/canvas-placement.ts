import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

/** 新节点和已有节点之间留的空隙。 */
export const NODE_PLACEMENT_GAP = 48;
/** 最多往下挪的次数，防止节点特别多时循环太久；挪不开就放在最后一次的位置。 */
const MAX_PLACEMENT_STEPS = 200;

type Size = { width: number; height: number };
type Rect = Position & Size;

function overlaps(a: Rect, b: Rect) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 给新节点找一个不和已有节点重叠的位置：x 不变，被挡住就挪到挡住它的节点下方。
 * 组节点是框住别的节点的容器，不算遮挡。
 */
export function placeWithoutOverlap(position: Position, size: Size, nodes: CanvasNodeData[], gap = NODE_PLACEMENT_GAP): Position {
    const obstacles = nodes.filter((node) => node.type !== CanvasNodeType.Group);
    let y = position.y;
    for (let step = 0; step < MAX_PLACEMENT_STEPS; step += 1) {
        const rect = { x: position.x - gap / 2, y: y - gap / 2, width: size.width + gap, height: size.height + gap };
        const blockers = obstacles.filter((node) => overlaps(rect, { ...node.position, width: node.width, height: node.height }));
        if (!blockers.length) return { x: position.x, y };
        y = Math.max(...blockers.map((node) => node.position.y + node.height)) + gap;
    }
    return { x: position.x, y };
}
