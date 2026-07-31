import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  processListArgumentsSchema,
  safeSystemInfo,
  SystemProcessInspector,
} from './process-inspector.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function fakeChildProcess(): {
  child: {
    kill: ReturnType<typeof vi.fn>;
    once: EventEmitter['once'];
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  events: EventEmitter;
} {
  const events = new EventEmitter();
  return {
    child: {
      kill: vi.fn(() => true),
      once: events.once.bind(events),
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    },
    events,
  };
}

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe('SystemProcessInspector', () => {
  it('为查询参数补默认值，并拒绝越界值和额外字段', () => {
    expect(processListArgumentsSchema.parse({})).toEqual({ query: '', maxResults: 50 });
    expect(() => processListArgumentsSchema.parse({ maxResults: 0 })).toThrow();
    expect(() => processListArgumentsSchema.parse({ maxResults: 201 })).toThrow();
    expect(() => processListArgumentsSchema.parse({ query: 'x'.repeat(129) })).toThrow();
    expect(() => processListArgumentsSchema.parse({ unexpected: true })).toThrow();
  });

  it('在 Windows 快照中只保留名称、PID 与内存，不暴露命令行或用户', async () => {
    const inspector = new SystemProcessInspector({
      platform: 'win32',
      snapshotProvider: async () =>
        [
          '"node.exe","1200","Console","1","12,345 K"',
          '"Code.exe","2400","Console","1","456,789 K"',
        ].join('\r\n'),
    });

    await expect(
      inspector.list(
        { query: 'node', maxResults: 10 },
        { timeoutMs: 10_000, outputLimitBytes: 32_768 },
      ),
    ).resolves.toEqual({
      kind: 'process-list',
      query: 'node',
      processes: [{ name: 'node.exe', pid: 1_200, memoryBytes: 12_641_280 }],
      truncated: false,
    });
  });

  it('解析 Windows CSV 的转义引号，忽略无效 PID，并允许缺少内存值', async () => {
    const inspector = new SystemProcessInspector({
      platform: 'win32',
      snapshotProvider: async () =>
        [
          '"quoted""name.exe","42","Console","1",""',
          '"invalid.exe","not-a-pid","Console","1","1 K"',
          '"negative.exe","-1","Console","1","1 K"',
          '',
        ].join('\r\n'),
    });

    await expect(
      inspector.list(
        { query: 'QUOTED', maxResults: 10 },
        { timeoutMs: 10_000, outputLimitBytes: 32_768 },
      ),
    ).resolves.toEqual({
      kind: 'process-list',
      query: 'QUOTED',
      processes: [{ name: 'quoted"name.exe', pid: 42 }],
      truncated: false,
    });
  });

  it('解析跨平台 ps 输出、限制条目数和输出体积', async () => {
    const inspector = new SystemProcessInspector({
      platform: 'linux',
      snapshotProvider: async () =>
        ['  10  1 node 1.5 2.0', '  11  1 postgres 0.5 3.0', '  12  10 vite 0.1 0.5'].join('\n'),
    });
    const result = await inspector.list(
      { query: '', maxResults: 2 },
      { timeoutMs: 10_000, outputLimitBytes: 4_096 },
    );

    expect(result.processes).toEqual([
      {
        pid: 10,
        parentPid: 1,
        name: 'node',
        cpuPercent: 1.5,
        memoryPercent: 2,
      },
      {
        pid: 11,
        parentPid: 1,
        name: 'postgres',
        cpuPercent: 0.5,
        memoryPercent: 3,
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  it('忽略格式错误的 POSIX 行，并按 UTF-8 输出上限继续裁减结果', async () => {
    const inspector = new SystemProcessInspector({
      platform: 'darwin',
      snapshotProvider: async () =>
        [
          'this is not ps output',
          '  10  1 node 1.5 2.0 trailing',
          '  11  1 very-long-process-name-一二三四五六七八九十 0.5 3.0',
          '  12  1 another-long-process-name-一二三四五六七八九十 0.1 1.0',
        ].join('\n'),
    });

    const result = await inspector.list(
      { query: '', maxResults: 10 },
      { timeoutMs: 10_000, outputLimitBytes: 180 },
    );

    expect(result.processes.length).toBeLessThan(2);
    expect(result.truncated).toBe(true);
  });

  it('将快照超时限制在 1 到 30 秒，并原样传递取消信号', async () => {
    const snapshotProvider = vi.fn(async () => '');
    const inspector = new SystemProcessInspector({ platform: 'linux', snapshotProvider });
    const controller = new AbortController();

    await inspector.list({ query: '', maxResults: 1 }, { timeoutMs: 1, outputLimitBytes: 4_096 });
    await inspector.list(
      { query: '', maxResults: 1 },
      { timeoutMs: 90_000, outputLimitBytes: 4_096, signal: controller.signal },
    );

    expect(snapshotProvider).toHaveBeenNthCalledWith(1, { timeoutMs: 1_000 });
    expect(snapshotProvider).toHaveBeenNthCalledWith(2, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
  });

  it('保留快照提供器的失败和取消错误', async () => {
    const failure = new Error('snapshot failed');
    const failedInspector = new SystemProcessInspector({
      platform: 'linux',
      snapshotProvider: async () => {
        throw failure;
      },
    });
    const cancelledInspector = new SystemProcessInspector({
      platform: 'linux',
      snapshotProvider: async ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const controller = new AbortController();
    const cancelled = cancelledInspector.list(
      { query: '', maxResults: 1 },
      { timeoutMs: 10_000, outputLimitBytes: 4_096, signal: controller.signal },
    );
    controller.abort(new Error('cancelled'));

    await expect(
      failedInspector.list(
        { query: '', maxResults: 1 },
        { timeoutMs: 10_000, outputLimitBytes: 4_096 },
      ),
    ).rejects.toBe(failure);
    await expect(cancelled).rejects.toMatchObject({ message: 'cancelled' });
  });

  it('使用固定 POSIX 命令捕获快照并忽略 stderr', async () => {
    const { child, events } = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('  21  2 node 4.5 1.2\n'));
        child.stderr.emit('data', Buffer.from('ignored warning'));
        events.emit('close', 0);
      });
      return child;
    });
    const inspector = new SystemProcessInspector({ platform: 'linux' });

    await expect(
      inspector.list({ query: '', maxResults: 10 }, { timeoutMs: 10_000, outputLimitBytes: 4_096 }),
    ).resolves.toMatchObject({
      processes: [{ pid: 21, parentPid: 2, name: 'node', cpuPercent: 4.5, memoryPercent: 1.2 }],
    });
    expect(spawnMock).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid=,comm=,%cpu=,%mem='], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('使用固定 Windows tasklist 参数捕获快照', async () => {
    const { child, events } = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('"node.exe","22","Console","1","2 K"\r\n'));
        events.emit('close', 0);
      });
      return child;
    });

    await expect(
      new SystemProcessInspector({ platform: 'win32' }).list(
        { query: '', maxResults: 10 },
        { timeoutMs: 10_000, outputLimitBytes: 4_096 },
      ),
    ).resolves.toMatchObject({
      processes: [{ pid: 22, name: 'node.exe', memoryBytes: 2_048 }],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'tasklist.exe',
      ['/fo', 'csv', '/nh'],
      expect.any(Object),
    );
  });

  it('将命令启动错误和非零退出码作为失败返回，且只结算一次', async () => {
    const launchFailure = new Error('spawn failed');
    const first = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        first.events.emit('error', launchFailure);
        first.events.emit('close', 1);
      });
      return first.child;
    });
    const second = fakeChildProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => second.events.emit('close', 7));
      return second.child;
    });

    await expect(
      new SystemProcessInspector({ platform: 'linux' }).list(
        { query: '', maxResults: 1 },
        { timeoutMs: 10_000, outputLimitBytes: 4_096 },
      ),
    ).rejects.toBe(launchFailure);
    await expect(
      new SystemProcessInspector({ platform: 'linux' }).list(
        { query: '', maxResults: 1 },
        { timeoutMs: 10_000, outputLimitBytes: 4_096 },
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_INSPECTION_FAILED' });
  });

  it('在信号已取消或执行中取消时终止子进程', async () => {
    const beforeStart = fakeChildProcess();
    spawnMock.mockReturnValueOnce(beforeStart.child);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      new SystemProcessInspector({ platform: 'linux' }).list(
        { query: '', maxResults: 1 },
        {
          timeoutMs: 10_000,
          outputLimitBytes: 4_096,
          signal: alreadyAborted.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'PROCESS_INSPECTION_CANCELLED' });
    expect(beforeStart.child.kill).toHaveBeenCalledOnce();

    const whileRunning = fakeChildProcess();
    spawnMock.mockReturnValueOnce(whileRunning.child);
    const controller = new AbortController();
    const pending = new SystemProcessInspector({ platform: 'linux' }).list(
      { query: '', maxResults: 1 },
      { timeoutMs: 10_000, outputLimitBytes: 4_096, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROCESS_INSPECTION_CANCELLED' });
    expect(whileRunning.child.kill).toHaveBeenCalledOnce();
  });

  it('超时后终止未完成的子进程', async () => {
    vi.useFakeTimers();
    const { child } = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const pending = new SystemProcessInspector({ platform: 'linux' }).list(
      { query: '', maxResults: 1 },
      { timeoutMs: 1, outputLimitBytes: 4_096 },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PROCESS_INSPECTION_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe('safeSystemInfo', () => {
  it('仅返回非识别性系统、CPU、内存和运行时字段', () => {
    const result = safeSystemInfo();
    expect(result).toEqual({
      kind: 'system-info',
      operatingSystem: {
        platform: expect.any(String),
        release: expect.any(String),
      },
      architecture: expect.any(String),
      cpu: {
        logicalCores: expect.any(Number),
        model: expect.any(String),
      },
      memory: {
        totalBytes: expect.any(Number),
        freeBytes: expect.any(Number),
      },
      runtime: expect.objectContaining({ node: expect.any(String) }),
    });
    expect(result).not.toHaveProperty('hostname');
    expect(result).not.toHaveProperty('username');
    expect(result).not.toHaveProperty('environment');
  });
});
