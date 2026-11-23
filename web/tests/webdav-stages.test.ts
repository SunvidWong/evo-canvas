import { expect, test } from "bun:test";

import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
const { APP_SYNC_STAGES } = await import("../src/services/app-sync");

test("every WebDAV sync stage has a label in both languages", () => {
    for (const locale of [zhCN, enUS]) {
        const stages = locale.config.webdav.stages as Record<string, string>;
        // failed 显示的是报错原文，不需要文案。
        for (const stage of APP_SYNC_STAGES.filter((item) => item !== "failed")) expect(typeof stages[stage]).toBe("string");
    }
});
