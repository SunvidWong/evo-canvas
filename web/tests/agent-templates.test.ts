import { expect, test } from "bun:test";

import { addAgentTemplate, expandAgentTemplate } from "../src/lib/agent/agent-templates";

test("模板占位符替换为选中节点引用", () => {
    expect(expandAgentTemplate("把{{selection}}整理成网格", ["@图片1", "@文本2"], "当前画布")).toBe("把 @图片1 @文本2 整理成网格");
});

test("没有选中节点时占位符使用默认描述", () => {
    expect(expandAgentTemplate("把{{selection}}整理成网格", [], "当前画布")).toBe("把当前画布整理成网格");
});

test("模板没有占位符时把引用放在开头", () => {
    expect(expandAgentTemplate("总结要点", ["@文本1"], "当前画布")).toBe("@文本1 总结要点");
    expect(expandAgentTemplate(" 总结要点 ", [], "当前画布")).toBe("总结要点");
});

test("新增自定义模板需要标题和内容", () => {
    expect(addAgentTemplate([], " ", "内容", "a")).toEqual([]);
    expect(addAgentTemplate([], " 排版 ", " 整理{{selection}} ", "a")).toEqual([{ id: "a", title: "排版", prompt: "整理{{selection}}" }]);
});
