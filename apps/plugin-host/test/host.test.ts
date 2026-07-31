import {
  parsePluginManifest,
  type HostEvent,
  type JsonValue,
  type PluginContext,
} from '@e-agent/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { isContributionDeclared, PluginHost } from '../src/host.js';

const manifest = parsePluginManifest({
  schemaVersion: 1,
  id: 'com.eagent.host-test',
  name: 'Host Test',
  version: '1.0.0',
  description: '测试',
  publisher: 'E Agent',
  entry: 'index.js',
  engines: { eAgent: '>=0.1.0' },
  types: ['tool'],
  permissions: {},
  contributes: {
    commands: [{ id: 'host-test.run', title: '运行' }],
  },
});

const richManifest = parsePluginManifest({
  ...manifest,
  types: ['tool', 'hook', 'provider'],
  contributes: {
    commands: [{ id: 'host-test.run', title: '运行' }],
    hooks: ['file:before-save'],
    providers: [{ id: 'host-test.provider', displayName: 'Test Provider' }],
  },
});

function lastCapability(events: readonly HostEvent[]) {
  const event = [...events].reverse().find((candidate) => candidate.type === 'capability-request');
  if (event?.type !== 'capability-request') {
    throw new Error('未收到能力请求');
  }
  return event;
}

describe('PluginHost', () => {
  it('只允许注册清单中声明的贡献', () => {
    expect(isContributionDeclared(manifest, 'command', 'host-test.run')).toBe(true);
    expect(isContributionDeclared(manifest, 'command', 'host-test.hidden')).toBe(false);
    expect(isContributionDeclared(richManifest, 'hook', 'file:before-save')).toBe(true);
    expect(isContributionDeclared(richManifest, 'hook', 'file:after-save')).toBe(false);
    expect(isContributionDeclared(richManifest, 'provider', 'host-test.provider')).toBe(true);
    expect(isContributionDeclared(richManifest, 'provider', 'host-test.hidden')).toBe(false);
  });

  it('激活插件并调用已注册命令', async () => {
    const events: HostEvent[] = [];
    const host = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({
        default: {
          activate: (context: {
            registerCommand: (id: string, handler: (input: unknown) => unknown) => unknown;
          }) => {
            context.registerCommand('host-test.run', () => ({ ok: true }));
          },
        },
      }),
    });
    await host.handle({
      type: 'initialize',
      requestId: 'init',
      manifest,
      dataDirectory: '/fixture/data',
    });
    await host.handle({
      type: 'invoke',
      requestId: 'invoke',
      target: 'command',
      id: 'host-test.run',
      input: null,
    });
    expect(events).toContainEqual({
      type: 'response',
      requestId: 'invoke',
      ok: true,
      value: { ok: true },
    });
  });

  it('拒绝无效 IPC 消息', async () => {
    const events: HostEvent[] = [];
    const host = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
    });
    await host.handle({ type: 'unknown', requestId: 'bad' });
    expect(events.at(-1)).toMatchObject({
      type: 'response',
      requestId: 'bad',
      ok: false,
    });
    await host.handle(null);
    expect(events.at(-1)).toMatchObject({ requestId: 'invalid', ok: false });
  });

  it('注册三类贡献、隔离调用错误并完整停用', async () => {
    const events: HostEvent[] = [];
    const deactivate = vi.fn();
    const dispose = vi.fn();
    const host = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({
        plugin: {
          activate: (context: PluginContext) => {
            context.registerCommand('host-test.run', (input) => input);
            context.registerHook('file:before-save', () => {
              throw new Error('hook failed safely');
            });
            context.registerProvider('host-test.provider', () => undefined);
            context.log('info', 'x'.repeat(6_000), { ready: true });
            context.registerCommand('host-test.run', () => null);
          },
          deactivate,
        },
      }),
    });

    await host.handle({
      type: 'initialize',
      requestId: 'init-duplicate',
      manifest: richManifest,
      dataDirectory: '/fixture/data',
    });
    expect(events.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('重复注册') });

    const working = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({
        default: {
          activate: (context: PluginContext) => {
            const registered = context.registerCommand('host-test.run', (input) => input);
            context.registerHook('file:before-save', () => {
              throw new Error('hook failed safely');
            });
            context.registerProvider('host-test.provider', () => undefined);
            context.log('info', 'ready', { ready: true });
            return registered;
          },
          deactivate: async () => {
            deactivate();
            await dispose();
          },
        },
      }),
    });
    await working.handle({
      type: 'initialize',
      requestId: 'init-rich',
      manifest: richManifest,
      dataDirectory: '/fixture/data',
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'registration', target: 'command' }),
        expect.objectContaining({ type: 'registration', target: 'hook' }),
        expect.objectContaining({ type: 'registration', target: 'provider' }),
        expect.objectContaining({ type: 'log', fields: { ready: true } }),
      ]),
    );

    await working.handle({
      type: 'invoke',
      requestId: 'provider',
      target: 'provider',
      id: 'host-test.provider',
      input: null,
    });
    expect(events.at(-1)).toEqual({ type: 'response', requestId: 'provider', ok: true });
    await working.handle({
      type: 'invoke',
      requestId: 'hook',
      target: 'hook',
      id: 'file:before-save',
      input: null,
    });
    expect(events.at(-1)).toMatchObject({ ok: false, error: 'hook failed safely' });
    await working.handle({
      type: 'invoke',
      requestId: 'missing',
      target: 'command',
      id: 'host-test.missing',
      input: null,
    });
    expect(events.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('未注册') });

    await working.handle({ type: 'deactivate', requestId: 'deactivate' });
    expect(events.at(-1)).toMatchObject({ ok: true, requestId: 'deactivate' });
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('通过父进程代理所有受限能力并处理拒绝与无效响应', async () => {
    const events: HostEvent[] = [];
    let context: PluginContext | undefined;
    const host = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({
        default: {
          activate: (value: PluginContext) => {
            context = value;
          },
        },
      }),
    });
    await host.handle({
      type: 'initialize',
      requestId: 'init-capabilities',
      manifest,
      dataDirectory: '/fixture/data',
    });
    if (context === undefined) throw new Error('插件上下文未初始化');

    const resolve = async <T>(promise: Promise<T>, value?: JsonValue): Promise<T> => {
      const request = lastCapability(events);
      await host.handle({
        type: 'capability-result',
        requestId: `result-${request.capabilityRequestId}`,
        capabilityRequestId: request.capabilityRequestId,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
      return promise;
    };

    await expect(
      resolve(context.capabilities.network.request({ url: 'https://example.test' }), {
        status: 200,
        headers: {},
        body: 'ok',
      }),
    ).resolves.toEqual({ status: 200, headers: {}, body: 'ok' });
    await expect(
      resolve(context.capabilities.fileSystem.readText('README.md'), 'content'),
    ).resolves.toBe('content');
    await expect(
      resolve(context.capabilities.fileSystem.writeText('output.txt', 'content')),
    ).resolves.toBeUndefined();
    await expect(resolve(context.capabilities.fileSystem.list('.'), ['a.ts', 42])).resolves.toEqual(
      ['a.ts', '42'],
    );
    await expect(resolve(context.capabilities.env.get('SAFE_NAME'), 'value')).resolves.toBe(
      'value',
    );
    await expect(
      resolve(context.capabilities.notifications.show('Done', 'Finished')),
    ).resolves.toBeUndefined();

    const invalidList = context.capabilities.fileSystem.list('.');
    await resolve(Promise.resolve(undefined), 'not-an-array');
    await expect(invalidList).rejects.toThrow(/文件列表响应无效/);

    const rejected = context.capabilities.env.get('BLOCKED_NAME');
    const pending = lastCapability(events);
    await host.handle({
      type: 'capability-result',
      requestId: 'rejected',
      capabilityRequestId: pending.capabilityRequestId,
      ok: false,
      error: 'denied',
    });
    await expect(rejected).rejects.toThrow('denied');
    await expect(
      host.handle({
        type: 'capability-result',
        requestId: 'unknown',
        capabilityRequestId: crypto.randomUUID(),
        ok: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('拒绝无效插件入口、重复初始化和未声明注册项', async () => {
    const invalidExports = [null, {}, { default: {} }];
    for (const imported of invalidExports) {
      const events: HostEvent[] = [];
      const host = new PluginHost({
        pluginEntryPath: '/fixture/index.js',
        send: (event) => events.push(event),
        hardenGlobals: false,
        importPlugin: async () => imported,
      });
      await host.handle({
        type: 'initialize',
        requestId: 'invalid-plugin',
        manifest,
        dataDirectory: '/fixture/data',
      });
      expect(events.at(-1)).toMatchObject({ ok: false });
    }

    const events: HostEvent[] = [];
    const host = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({
        default: {
          activate: (context: PluginContext) =>
            context.registerCommand('host-test.hidden', () => null),
        },
      }),
    });
    await host.handle({
      type: 'initialize',
      requestId: 'undeclared',
      manifest,
      dataDirectory: '/fixture/data',
    });
    expect(events.at(-1)).toMatchObject({
      ok: false,
      error: expect.stringContaining('清单未声明'),
    });

    const initialized = new PluginHost({
      pluginEntryPath: '/fixture/index.js',
      send: (event) => events.push(event),
      hardenGlobals: false,
      importPlugin: async () => ({ default: { activate: () => undefined } }),
    });
    const initialize = {
      type: 'initialize' as const,
      manifest,
      dataDirectory: '/fixture/data',
    };
    await initialized.handle({ ...initialize, requestId: 'first' });
    await initialized.handle({ ...initialize, requestId: 'second' });
    expect(events.at(-1)).toMatchObject({
      requestId: 'second',
      ok: false,
      error: '插件已经初始化',
    });
  });
});
