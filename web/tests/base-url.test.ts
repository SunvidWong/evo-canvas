import { describe, expect, test } from "bun:test";

import { publicUrl, routerPath } from "@/lib/base-url";

describe("子路径部署地址", () => {
    test("根路径部署时保持原样", () => {
        expect(publicUrl("/icons/claude.svg", "/")).toBe("/icons/claude.svg");
        expect(routerPath("/canvas/1", "/")).toBe("/canvas/1");
    });

    test("子路径部署时补上部署路径", () => {
        expect(publicUrl("/icons/claude.svg", "/infinite-canvas/")).toBe("/infinite-canvas/icons/claude.svg");
        expect(publicUrl("/plugins/index.json", "/infinite-canvas")).toBe("/infinite-canvas/plugins/index.json");
    });

    test("部署路径和 public 目录同名时仍然补前缀", () => {
        expect(publicUrl("/plugins/index.json", "/plugins/")).toBe("/plugins/plugins/index.json");
        expect(publicUrl("/icons/claude.svg", "/icons/")).toBe("/icons/icons/claude.svg");
    });

    test("完整地址和相对地址不改动", () => {
        for (const value of ["https://example.com/a.js", "//cdn.example.com/a.js", "data:image/png;base64,AA", "blob:abc", "plugins/a.js"]) {
            expect(publicUrl(value, "/sub/")).toBe(value);
        }
    });

    test("把地址栏路径换成路由内路径", () => {
        expect(routerPath("/infinite-canvas/canvas/1", "/infinite-canvas")).toBe("/canvas/1");
        expect(routerPath("/infinite-canvas", "/infinite-canvas")).toBe("/");
        expect(routerPath("/other/path", "/infinite-canvas")).toBe("/other/path");
    });
});
