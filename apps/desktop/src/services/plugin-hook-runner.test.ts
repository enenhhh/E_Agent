import type { PluginStatus } from '@e-agent/plugin-runtime';
import { PluginRuntimeError } from '@e-agent/plugin-runtime';
import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from './logger.js';
import { DesktopPluginHookRunner } from './plugin-hook-runner.js';

const changeId = '00000000-0000-4000-8000-000000000031';

function status(
  id: string,
  input: {
    enabled?: boolean;
    approved?: boolean;
    hooks?: Array<'file:before-save' | 'file:after-save'>;
  } = {},
): PluginStatus {
  return {
    integrity: 'sha256:test',
    enabled: input.enabled ?? true,
    approved: input.approved ?? true,
    manifest: {
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      description: 'test hook',
      publisher: 'E Agent',
      entry: 'index.js',
      engines: { eAgent: '>=0.1.0' },
      types: ['hook'],
      permissions: {},
      contributes: { hooks: input.hooks ?? ['file:before-save'] },
    },
  };
}

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as AppLogger;
}

function beforePayload() {
  return {
    schemaVersion: 1 as const,
    eventId: '00000000-0000-4000-8000-000000000032',
    occurredAt: '2026-07-28T12:00:00.000Z',
    requestId: changeId,
    actor: {
      id: '00000000-0000-4000-8000-000000000033',
      role: 'owner' as const,
    },
    operation: 'workspace.file-save' as const,
    file: {
      relativePath: 'src/example.ts',
      byteLength: 18,
      sha256: 'a'.repeat(64),
      changeId,
    },
  };
}

describe('DesktopPluginHookRunner', () => {
  it('只调用已启用、已授权且声明对应生命周期的插件', async () => {
    const invoke = vi.fn(async () => undefined);
    const runtime = {
      list: vi.fn(async () => [
        status('com.example.eligible'),
        status('com.example.disabled', { enabled: false }),
        status('com.example.unapproved', { approved: false }),
        status('com.example.other-hook', { hooks: ['file:after-save'] }),
      ]),
      invoke,
    };
    const currentLogger = logger();

    await new DesktopPluginHookRunner(runtime, currentLogger).run(
      'file:before-save',
      beforePayload(),
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'com.example.eligible',
      'hook',
      'file:before-save',
      expect.objectContaining({
        file: expect.objectContaining({ relativePath: 'src/example.ts' }),
      }),
    );
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('content');
  });

  it('隔离插件错误且日志只记录错误码', async () => {
    const currentLogger = logger();
    const runtime = {
      list: vi.fn(async () => [status('com.example.failure')]),
      invoke: vi.fn(async () => {
        throw new PluginRuntimeError('REQUEST_TIMEOUT', '不应进入日志的秘密');
      }),
    };

    await expect(
      new DesktopPluginHookRunner(runtime, currentLogger).run('file:before-save', beforePayload()),
    ).resolves.toBeUndefined();

    expect(currentLogger.warn).toHaveBeenCalledWith(
      '桌面文件 Hook 执行失败，已隔离',
      expect.objectContaining({ errorCode: 'REQUEST_TIMEOUT' }),
    );
    expect(JSON.stringify(vi.mocked(currentLogger.warn).mock.calls)).not.toContain(
      '不应进入日志的秘密',
    );
  });

  it('插件清单读取失败时不阻断保存流程', async () => {
    const currentLogger = logger();
    const runtime = {
      list: vi.fn(async () => {
        throw new Error('discovery failure');
      }),
      invoke: vi.fn(async () => undefined),
    };

    await expect(
      new DesktopPluginHookRunner(runtime, currentLogger).run('file:before-save', beforePayload()),
    ).resolves.toBeUndefined();
    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(currentLogger.error).toHaveBeenCalled();
  });
});
