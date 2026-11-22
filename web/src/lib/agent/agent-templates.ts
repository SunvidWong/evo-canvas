/** 模板里代表「当前选中节点」的占位符；发送前替换成节点引用。 */
export const AGENT_TEMPLATE_SELECTION = "{{selection}}";

export type AgentPromptTemplate = { id: string; title: string; prompt: string };

/**
 * 把模板展开成输入框文本：占位符替换成选中节点的 @ 引用；
 * 模板没有占位符但有选中节点时，把引用放在开头；没有选中节点时用 fallback 描述代替。
 */
export function expandAgentTemplate(prompt: string, markers: string[], fallback: string) {
    const selection = markers.join(" ");
    if (prompt.includes(AGENT_TEMPLATE_SELECTION)) return prompt.split(AGENT_TEMPLATE_SELECTION).join(selection ? ` ${selection} ` : fallback).replace(/ {2,}/g, " ").trim();
    return selection ? `${selection} ${prompt}`.trim() : prompt.trim();
}

/** 新增自定义模板；标题或内容为空时返回原列表。 */
export function addAgentTemplate(templates: AgentPromptTemplate[], title: string, prompt: string, id: string) {
    const nextTitle = title.trim();
    const nextPrompt = prompt.trim();
    if (!nextTitle || !nextPrompt) return templates;
    return [...templates, { id, title: nextTitle, prompt: nextPrompt }];
}
