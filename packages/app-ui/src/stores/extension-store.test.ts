import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EAgentTransport } from '../lib/transport';
import type { Plugin, Skill, WorkflowDefinition, WorkflowResult } from '../types';

import { useExtensionStore } from './extension-store';

const skillA: Skill = {
  id: 'skill-a',
  name: 'Skill A',
  description: 'A',
  version: '1.0.0',
  source: 'builtin',
  enabled: true,
  command: '@a',
  permissions: [],
  variables: [],
};
const skillB: Skill = {
  ...skillA,
  id: 'skill-b',
  name: 'Skill B',
  command: '@b',
  enabled: false,
};
const workflowA: WorkflowDefinition = {
  schemaVersion: 1,
  id: 'workflow-a',
  name: 'Workflow A',
  steps: [],
};
const workflowB: WorkflowDefinition = {
  ...workflowA,
  id: 'workflow-b',
  name: 'Workflow B',
};
const pluginA: Plugin = {
  id: 'plugin-a',
  name: 'Plugin A',
  description: 'A',
  version: '1.0.0',
  enabled: false,
  approved: false,
  source: 'local:a',
  types: ['tool'],
  permissions: [],
};
const pluginB: Plugin = {
  ...pluginA,
  id: 'plugin-b',
  name: 'Plugin B',
  source: 'local:b',
};

function resetStore(): void {
  useExtensionStore.setState({
    skills: [],
    workflows: [],
    plugins: [],
    loading: false,
    error: null,
  });
}

describe('useExtensionStore', () => {
  beforeEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('并行加载 Skill 与 Workflow，并可分别刷新三类扩展', async () => {
    const transport = {
      listSkills: vi.fn(async () => [skillA]),
      listWorkflows: vi.fn(async () => [workflowA]),
      listPlugins: vi.fn(async () => [pluginA]),
    } as unknown as EAgentTransport;

    await useExtensionStore.getState().loadSkillWorkspace(transport);
    expect(useExtensionStore.getState()).toMatchObject({
      skills: [skillA],
      workflows: [workflowA],
      loading: false,
      error: null,
    });

    await useExtensionStore.getState().loadSkills(transport);
    await useExtensionStore.getState().loadWorkflows(transport);
    await useExtensionStore.getState().loadPlugins(transport);
    expect(useExtensionStore.getState().plugins).toEqual([pluginA]);
    expect(transport.listSkills).toHaveBeenCalledTimes(2);
    expect(transport.listWorkflows).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      method: 'loadSkillWorkspace' as const,
      transport: {
        listSkills: vi.fn(async () => {
          throw 'offline';
        }),
        listWorkflows: vi.fn(async () => []),
      },
      expected: 'Skill 与 Workflow 加载失败。',
    },
    {
      method: 'loadSkills' as const,
      transport: {
        listSkills: vi.fn(async () => {
          throw new Error('skill unavailable');
        }),
      },
      expected: 'skill unavailable',
    },
    {
      method: 'loadWorkflows' as const,
      transport: {
        listWorkflows: vi.fn(async () => {
          throw null;
        }),
      },
      expected: 'Workflow 列表加载失败。',
    },
    {
      method: 'loadPlugins' as const,
      transport: {
        listPlugins: vi.fn(async () => {
          throw new Error('plugin unavailable');
        }),
      },
      expected: 'plugin unavailable',
    },
  ])('$method 失败时恢复 loading 并保留友好错误', async ({ method, transport, expected }) => {
    await useExtensionStore.getState()[method](transport as unknown as EAgentTransport);

    expect(useExtensionStore.getState()).toMatchObject({
      loading: false,
      error: expected,
    });
  });

  it('完成 Skill、Workflow 与插件的增改删和运行状态同步', async () => {
    const workflowResult: WorkflowResult = {
      workflowId: workflowA.id,
      outputs: { done: true },
    };
    const transport = {
      setSkillEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
        ...skillA,
        enabled,
      })),
      installSkill: vi.fn(async () => skillB),
      saveWorkflow: vi.fn(async (workflow: WorkflowDefinition) => workflow),
      deleteWorkflow: vi.fn(async () => undefined),
      runWorkflow: vi.fn(async () => workflowResult),
      setPluginApproved: vi.fn(async (_id: string, approved: boolean) => ({
        ...pluginA,
        approved,
      })),
      setPluginEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
        ...pluginA,
        enabled,
      })),
      installPlugin: vi.fn(async () => ({ ...pluginA, name: 'Plugin A updated' })),
      uninstallPlugin: vi.fn(async () => undefined),
    } as unknown as EAgentTransport;
    useExtensionStore.setState({
      skills: [skillA],
      workflows: [workflowB, workflowA],
      plugins: [pluginB, pluginA],
    });

    await useExtensionStore.getState().toggleSkill(transport, skillA.id, false);
    await useExtensionStore.getState().installSkill(transport, 'local:skill-b');
    await useExtensionStore
      .getState()
      .saveWorkflow(transport, { ...workflowA, name: 'Workflow A updated' });
    await useExtensionStore.getState().deleteWorkflow(transport, workflowB.id);
    await expect(
      useExtensionStore.getState().runWorkflow(transport, workflowA.id, { source: 'value' }),
    ).resolves.toEqual(workflowResult);
    await useExtensionStore.getState().approvePlugin(transport, pluginA.id, true);
    await useExtensionStore.getState().togglePlugin(transport, pluginA.id, true);
    await useExtensionStore.getState().installPlugin(transport, 'local:plugin-a');
    await useExtensionStore.getState().uninstallPlugin(transport, pluginB.id);

    expect(useExtensionStore.getState()).toMatchObject({
      skills: [
        expect.objectContaining({ id: skillA.id, enabled: false }),
        expect.objectContaining({ id: skillB.id }),
      ],
      workflows: [expect.objectContaining({ id: workflowA.id, name: 'Workflow A updated' })],
      plugins: [
        expect.objectContaining({
          id: pluginA.id,
          name: 'Plugin A updated',
        }),
      ],
    });
    expect(transport.runWorkflow).toHaveBeenCalledWith(workflowA.id, { source: 'value' });
    expect(transport.uninstallPlugin).toHaveBeenCalledWith(pluginB.id);
  });
});
