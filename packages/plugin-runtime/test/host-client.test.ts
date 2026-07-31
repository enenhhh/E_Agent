import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { parsePluginManifest, type HostRequest, type JsonValue } from '@e-agent/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock('node:child_process', () => ({ fork: forkMock }));

import { PluginHostClient } from '../src/host-client.js';

class FakeChild extends EventEmitter {
  public connected = true;
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly sent: HostRequest[] = [];
  public killed = false;
  public autoRespond = true;
  public sendFailure: Error | undefined;

  public send(message: HostRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (this.sendFailure !== undefined) {
      const failure = this.sendFailure;
      this.sendFailure = undefined;
      callback?.(failure);
      return false;
    }
    callback?.(null);
    if (
      this.autoRespond &&
      (message.type === 'initialize' || message.type === 'invoke' || message.type === 'deactivate')
    ) {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'response',
          requestId: message.requestId,
          ok: true,
          value: message.type === 'invoke' ? { echoed: message.input } : undefined,
        });
      });
    }
    return true;
  }

  public kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

function manifest() {
  return parsePluginManifest({
    schemaVersion: 1,
    id: 'com.eagent.host-test',
    name: 'Host test',
    version: '1.0.0',
    description: 'Host protocol test',
    publisher: 'E Agent',
    entry: 'index.js',
    engines: { eAgent: '>=0.1.0' },
    types: ['hook', 'provider', 'tool'],
    permissions: {},
    contributes: {
      commands: [{ id: 'com.eagent.host-test.command', title: 'Command' }],
      hooks: ['request:before'],
      providers: [{ id: 'com.eagent.host-test.provider', displayName: 'Provider' }],
    },
  });
}

function createClient(
  child: FakeChild,
  overrides: {
    onCapabilityRequest?: () => Promise<JsonValue | undefined>;
    onLog?: (level: 'debug' | 'error' | 'info' | 'warn', message: string) => void;
    requestTimeoutMs?: number;
  } = {},
): PluginHostClient {
  forkMock.mockReturnValue(child as unknown as ChildProcess);
  return new PluginHostClient({
    hostEntryPath: 'C:/host/main.js',
    pluginEntryPath: 'C:/plugin/index.js',
    pluginRoot: 'C:/plugin',
    dataDirectory: 'C:/data',
    manifest: manifest(),
    requestTimeoutMs: overrides.requestTimeoutMs ?? 100,
    onCapabilityRequest: overrides.onCapabilityRequest ?? (async () => ({ capability: 'handled' })),
    ...(overrides.onLog === undefined ? {} : { onLog: overrides.onLog }),
  });
}

beforeEach(() => {
  forkMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PluginHostClient', () => {
  it('starts once with a minimal environment and stops cleanly', async () => {
    const child = new FakeChild();
    const client = createClient(child);
    process.env['E_AGENT_TEST_SECRET'] = 'must-not-leak';
    try {
      await client.start();
      await client.start();
    } finally {
      delete process.env['E_AGENT_TEST_SECRET'];
    }

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('host'),
      [expect.stringContaining('index.js')],
      expect.objectContaining({
        cwd: expect.stringContaining('plugin'),
        env: expect.not.objectContaining({ E_AGENT_TEST_SECRET: 'must-not-leak' }),
        execArgv: expect.arrayContaining(['--permission']),
      }),
    );
    expect(child.sent[0]).toMatchObject({
      type: 'initialize',
      dataDirectory: 'C:/data',
    });

    await client.stop();
    await client.stop();
    expect(child.killed).toBe(true);
  });

  it.each([
    ['command', 'com.eagent.host-test.command'],
    ['hook', 'request:before'],
    ['provider', 'com.eagent.host-test.provider'],
  ] as const)('registers and invokes a declared %s', async (target, id) => {
    const child = new FakeChild();
    const client = createClient(child);
    await client.start();
    child.emit('message', { type: 'registration', target, id });

    await expect(client.invoke(target, id, { input: true })).resolves.toEqual({
      echoed: { input: true },
    });
    await client.stop();
  });

  it('rejects undeclared invocations and registrations', async () => {
    const child = new FakeChild();
    const client = createClient(child);
    await client.start();

    await expect(client.invoke('command', 'com.eagent.missing', null)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
    });
    child.emit('message', {
      type: 'registration',
      target: 'command',
      id: 'com.eagent.undeclared',
    });
    expect(child.killed).toBe(true);
    await client.stop();
  });

  it('forwards validated logs and ignores responses without a pending request', async () => {
    const child = new FakeChild();
    const onLog = vi.fn();
    const client = createClient(child, { onLog });
    await client.start();

    child.emit('message', {
      type: 'log',
      level: 'warn',
      message: 'safe message',
      fields: { attempt: 1 },
    });
    child.emit('message', {
      type: 'response',
      requestId: 'unknown',
      ok: true,
      value: null,
    });

    expect(onLog).toHaveBeenCalledWith('warn', 'safe message', { attempt: 1 });
    await client.stop();
  });

  it('returns capability success and sanitized capability failure results', async () => {
    const child = new FakeChild();
    const capability = vi
      .fn<() => Promise<JsonValue | undefined>>()
      .mockResolvedValueOnce({ allowed: true })
      .mockRejectedValueOnce('secret non-error value');
    const client = createClient(child, { onCapabilityRequest: capability });
    await client.start();

    child.emit('message', {
      type: 'capability-request',
      capabilityRequestId: 'cap-1',
      capability: 'env.get',
      input: { name: 'SAFE' },
    });
    child.emit('message', {
      type: 'capability-request',
      capabilityRequestId: 'cap-2',
      capability: 'env.get',
      input: { name: 'SAFE' },
    });

    await vi.waitFor(() => {
      expect(child.sent.filter((request) => request.type === 'capability-result')).toHaveLength(2);
    });
    expect(child.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'capability-result',
          capabilityRequestId: 'cap-1',
          ok: true,
          value: { allowed: true },
        }),
        expect.objectContaining({
          type: 'capability-result',
          capabilityRequestId: 'cap-2',
          ok: false,
        }),
      ]),
    );
    await client.stop();
  });

  it('fails pending work when the child crashes', async () => {
    const child = new FakeChild();
    const client = createClient(child);
    await client.start();
    child.emit('message', {
      type: 'registration',
      target: 'command',
      id: 'com.eagent.host-test.command',
    });
    child.autoRespond = false;
    const pending = client.invoke('command', 'com.eagent.host-test.command', null);

    child.emit('exit', 1, null);
    await expect(pending).rejects.toMatchObject({ code: 'HOST_CRASHED' });
    await client.stop();
  });

  it('rejects failed responses and send callback failures', async () => {
    const child = new FakeChild();
    const client = createClient(child);
    await client.start();
    child.emit('message', {
      type: 'registration',
      target: 'command',
      id: 'com.eagent.host-test.command',
    });
    child.autoRespond = false;

    const rejected = client.invoke('command', 'com.eagent.host-test.command', null);
    const invoke = child.sent.at(-1);
    expect(invoke?.type).toBe('invoke');
    if (invoke?.type === 'invoke') {
      child.emit('message', {
        type: 'response',
        requestId: invoke.requestId,
        ok: false,
        error: 'plugin failed',
      });
    }
    await expect(rejected).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });

    child.sendFailure = new Error('IPC closed');
    await expect(client.invoke('command', 'com.eagent.host-test.command', null)).rejects.toThrow(
      'IPC closed',
    );
    await client.stop();
  });

  it('times out unanswered requests without leaving timers behind', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = createClient(child, { requestTimeoutMs: 20 });
    await client.start();
    child.emit('message', {
      type: 'registration',
      target: 'command',
      id: 'com.eagent.host-test.command',
    });
    child.autoRespond = false;
    const pending = client.invoke('command', 'com.eagent.host-test.command', null);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    child.autoRespond = true;
    await client.stop();
  });

  it('kills a host that sends malformed IPC', async () => {
    const child = new FakeChild();
    const client = createClient(child);
    await client.start();

    child.emit('message', { unexpected: true });

    expect(child.killed).toBe(true);
    await client.stop();
  });
});
