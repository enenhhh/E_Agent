import type { AppLogger } from '@e-agent/observability';
import { PluginRuntimeError, type PluginStatus } from '@e-agent/plugin-runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  PluginHookRunner,
  type ServerHookName,
  type ServerHookPayloadMap,
} from '../src/plugin-hooks.js';

function status(input: {
  id: string;
  hooks?: ServerHookName[];
  enabled?: boolean;
  approved?: boolean;
  type?: 'hook' | 'tool';
}): PluginStatus {
  return {
    manifest: {
      schemaVersion: 1,
      id: input.id,
      name: input.id,
      version: '1.0.0',
      description: 'Hook test fixture',
      publisher: 'E Agent',
      entry: 'index.js',
      engines: { eAgent: '>=0.1.0' },
      types: [input.type ?? 'hook'],
      permissions: {},
      contributes: { hooks: input.hooks ?? [] },
    },
    integrity: `sha256:${input.id}`,
    enabled: input.enabled ?? true,
    approved: input.approved ?? true,
  };
}

function beforePayload(): ServerHookPayloadMap['request:before'] {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    requestId: 'request-1',
    actor: { id: crypto.randomUUID(), role: 'member' },
    operation: 'chat.completion',
    request: {
      stream: false,
      messageCount: 1,
      textCharacterCount: 12,
      imageCount: 0,
      toolCount: 0,
      contextMentionCount: 0,
      hasConversation: false,
      hasProject: false,
      hasExplicitModel: false,
      hasProvider: false,
      hasSkill: false,
    },
  };
}

function logger(): AppLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger;
}

describe('PluginHookRunner', () => {
  it('只运行启用、获批且显式声明 Hook 的插件，并隔离单插件失败', async () => {
    const statuses = [
      status({ id: 'com.eagent.success', hooks: ['request:before'] }),
      status({ id: 'com.eagent.failure', hooks: ['request:before'] }),
      status({ id: 'com.eagent.disabled', hooks: ['request:before'], enabled: false }),
      status({ id: 'com.eagent.unapproved', hooks: ['request:before'], approved: false }),
      status({ id: 'com.eagent.undeclared', hooks: ['request:after'] }),
      status({ id: 'com.eagent.wrongtype', hooks: ['request:before'], type: 'tool' }),
    ];
    const invoke = vi.fn(async (pluginId: string) => {
      if (pluginId === 'com.eagent.failure') {
        throw new PluginRuntimeError('REQUEST_TIMEOUT', 'do-not-log-this-secret');
      }
      return undefined;
    });
    const audit = { record: vi.fn() };
    const testLogger = logger();
    const runner = new PluginHookRunner(
      { list: vi.fn(async () => statuses), invoke } as never,
      audit,
      testLogger,
    );

    const results = await runner.run('request:before', beforePayload(), {
      actorId: crypto.randomUUID(),
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map((call) => call[0]).sort()).toEqual([
      'com.eagent.failure',
      'com.eagent.success',
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: 'com.eagent.success', success: true }),
        expect.objectContaining({
          pluginId: 'com.eagent.failure',
          success: false,
          errorCode: 'REQUEST_TIMEOUT',
        }),
      ]),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.hook.failed',
        targetId: 'com.eagent.failure',
        metadata: {
          hookName: 'request:before',
          errorCode: 'REQUEST_TIMEOUT',
        },
      }),
    );
    expect(
      JSON.stringify([
        audit.record.mock.calls,
        (testLogger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ]),
    ).not.toContain('do-not-log-this-secret');
  });

  it('拒绝包含未声明敏感字段的 Hook 输入', async () => {
    const invoke = vi.fn();
    const runner = new PluginHookRunner(
      { list: vi.fn(async () => []), invoke } as never,
      { record: vi.fn() },
      logger(),
    );
    const unsafe = {
      ...beforePayload(),
      authorization: 'Bearer should-never-reach-a-plugin',
    } as unknown as ServerHookPayloadMap['request:before'];

    await expect(runner.run('request:before', unsafe)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('插件清单发现失败不会中断业务，并写入脱敏审计', async () => {
    const audit = { record: vi.fn() };
    const runner = new PluginHookRunner(
      {
        list: vi.fn(async () => {
          throw new Error('authorization=top-secret');
        }),
        invoke: vi.fn(),
      } as never,
      audit,
      logger(),
    );

    await expect(runner.run('request:before', beforePayload())).resolves.toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'plugin.hook.discovery-failed',
        targetId: null,
        metadata: {
          hookName: 'request:before',
          errorCode: 'PLUGIN_DISCOVERY_FAILED',
        },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('top-secret');
  });
});
