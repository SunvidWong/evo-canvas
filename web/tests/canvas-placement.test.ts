import { expect, test } from "bun:test";

import { placeWithoutOverlap } from "../src/lib/canvas/canvas-placement";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string, x: number, y: number, width = 300, height = 300, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x, y }, width, height, metadata: {} }) as CanvasNodeData;

test("keeps the position when nothing is in the way", () => {
    expect(placeWithoutOverlap({ x: 400, y: 0 }, { width: 300, height: 300 }, [node("source", 0, 0)])).toEqual({ x: 400, y: 0 });
});

test("moves below every result already sitting there", () => {
    const nodes = [node("source", 0, 0), node("first", 400, 0), node("second", 400, 348)];
    expect(placeWithoutOverlap({ x: 400, y: 0 }, { width: 300, height: 300 }, nodes)).toEqual({ x: 400, y: 696 });
});

test("ignores group frames", () => {
    expect(placeWithoutOverlap({ x: 400, y: 0 }, { width: 300, height: 300 }, [node("group", -100, -100, 2000, 2000, CanvasNodeType.Group)])).toEqual({ x: 400, y: 0 });
});
