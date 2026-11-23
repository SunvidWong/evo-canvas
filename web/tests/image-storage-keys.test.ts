import { expect, test } from "bun:test";

import { collectImageStorageKeys } from "../src/services/image-storage";

test("keeps images referenced only from generation metadata", () => {
    const keys = collectImageStorageKeys({
        nodes: [
            { metadata: { storageKey: "image:result", references: ["image:source", "image:overlay", "https://example.com/a.png"], inpaintMask: "image:mask" } },
            { metadata: { references: "image:not-an-array", prompt: "image:text-is-ignored" } },
        ],
    });
    expect([...keys].sort()).toEqual(["image:mask", "image:not-an-array", "image:overlay", "image:result", "image:source"]);
});
