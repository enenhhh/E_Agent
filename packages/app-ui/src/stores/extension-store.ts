import { create } from 'zustand';

import type { EAgentTransport } from '../lib/transport';
import type { Plugin, Skill, WorkflowDefinition, WorkflowResult } from '../types';

interface ExtensionState {
  skills: Skill[];
  workflows: WorkflowDefinition[];
  plugins: Plugin[];
  loading: boolean;
  error: string | null;
  loadSkillWorkspace: (transport: EAgentTransport) => Promise<void>;
  loadSkills: (transport: EAgentTransport) => Promise<void>;
  loadWorkflows: (transport: EAgentTransport) => Promise<void>;
  loadPlugins: (transport: EAgentTransport) => Promise<void>;
  toggleSkill: (transport: EAgentTransport, id: string, enabled: boolean) => Promise<void>;
  approvePlugin: (transport: EAgentTransport, id: string, approved: boolean) => Promise<void>;
  togglePlugin: (transport: EAgentTransport, id: string, enabled: boolean) => Promise<void>;
  installSkill: (transport: EAgentTransport, source: string) => Promise<void>;
  saveWorkflow: (
    transport: EAgentTransport,
    workflow: WorkflowDefinition,
  ) => Promise<WorkflowDefinition>;
  deleteWorkflow: (transport: EAgentTransport, id: string) => Promise<void>;
  runWorkflow: (
    transport: EAgentTransport,
    id: string,
    variables: Record<string, string>,
  ) => Promise<WorkflowResult>;
  installPlugin: (transport: EAgentTransport, source: string) => Promise<void>;
  uninstallPlugin: (transport: EAgentTransport, id: string) => Promise<void>;
}

export const useExtensionStore = create<ExtensionState>((set) => ({
  skills: [],
  workflows: [],
  plugins: [],
  loading: false,
  error: null,

  loadSkillWorkspace: async (transport) => {
    set({ loading: true, error: null });
    try {
      const [skills, workflows] = await Promise.all([
        transport.listSkills(),
        transport.listWorkflows(),
      ]);
      set({ skills, workflows, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Skill 与 Workflow 加载失败。',
      });
    }
  },

  loadSkills: async (transport) => {
    set({ loading: true, error: null });
    try {
      const skills = await transport.listSkills();
      set({ skills, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Skill 列表加载失败。',
      });
    }
  },

  loadWorkflows: async (transport) => {
    set({ loading: true, error: null });
    try {
      const workflows = await transport.listWorkflows();
      set({ workflows, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Workflow 列表加载失败。',
      });
    }
  },

  loadPlugins: async (transport) => {
    set({ loading: true, error: null });
    try {
      const plugins = await transport.listPlugins();
      set({ plugins, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '插件列表加载失败。',
      });
    }
  },

  toggleSkill: async (transport, id, enabled) => {
    const skill = await transport.setSkillEnabled(id, enabled);
    set((state) => ({
      skills: state.skills.map((item) => (item.id === id ? skill : item)),
    }));
  },

  approvePlugin: async (transport, id, approved) => {
    const plugin = await transport.setPluginApproved(id, approved);
    set((state) => ({
      plugins: state.plugins.map((item) => (item.id === id ? plugin : item)),
    }));
  },

  togglePlugin: async (transport, id, enabled) => {
    const plugin = await transport.setPluginEnabled(id, enabled);
    set((state) => ({
      plugins: state.plugins.map((item) => (item.id === id ? plugin : item)),
    }));
  },

  installSkill: async (transport, source) => {
    const skill = await transport.installSkill(source);
    set((state) => ({ skills: [...state.skills, skill] }));
  },

  saveWorkflow: async (transport, workflow) => {
    const saved = await transport.saveWorkflow(workflow);
    set((state) => ({
      workflows: [...state.workflows.filter((candidate) => candidate.id !== saved.id), saved].sort(
        (left, right) => left.name.localeCompare(right.name),
      ),
    }));
    return saved;
  },

  deleteWorkflow: async (transport, id) => {
    await transport.deleteWorkflow(id);
    set((state) => ({
      workflows: state.workflows.filter((workflow) => workflow.id !== id),
    }));
  },

  runWorkflow: (transport, id, variables) => transport.runWorkflow(id, variables),

  installPlugin: async (transport, source) => {
    const plugin = await transport.installPlugin(source);
    set((state) => ({
      plugins: [...state.plugins.filter((candidate) => candidate.id !== plugin.id), plugin].sort(
        (left, right) => left.name.localeCompare(right.name),
      ),
    }));
  },

  uninstallPlugin: async (transport, id) => {
    await transport.uninstallPlugin(id);
    set((state) => ({ plugins: state.plugins.filter((plugin) => plugin.id !== id) }));
  },
}));
