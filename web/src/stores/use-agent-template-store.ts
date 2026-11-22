import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { addAgentTemplate, type AgentPromptTemplate } from "@/lib/agent/agent-templates";
import { localForageStorage } from "@/lib/localforage-storage";

type AgentTemplateStore = {
    /** 用户自定义的画布动作模板，只保存在当前浏览器（localforage）。 */
    templates: AgentPromptTemplate[];
    addTemplate: (title: string, prompt: string) => void;
    removeTemplate: (id: string) => void;
};

export const useAgentTemplateStore = create<AgentTemplateStore>()(
    persist(
        (set) => ({
            templates: [],
            addTemplate: (title, prompt) => set((state) => ({ templates: addAgentTemplate(state.templates, title, prompt, crypto.randomUUID()) })),
            removeTemplate: (id) => set((state) => ({ templates: state.templates.filter((item) => item.id !== id) })),
        }),
        { name: "infinite-canvas:agent_template_store", storage: createJSONStorage(() => localForageStorage) },
    ),
);
