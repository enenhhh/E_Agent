import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSafeCommand,
  workspaceCommandArgumentsSchema,
  WorkspaceCommandRunner,
} from './command-runner.js';
import { WorkspaceService } from './workspace.js';

const directories: string[] = [];

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 12_345;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly kill = vi.fn(() => true);

  public close(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode;
    this.signalCode = signal;
    this.emit('close', exitCode, signal);
  }

  public asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-command-runner-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  await mkdir(join(root, 'src'), { recursive: true });
  const workspace = new WorkspaceService({
    stateFile: join(directory, 'workspace-binding.json'),
  });
  const binding = await workspace.bind(root);
  return { binding, root, workspace };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('workspaceCommandArgumentsSchema', () => {
  it('只接受结构化命令名、参数和工作区相对 cwd', () => {
    expect(
      workspaceCommandArgumentsSchema.parse({
        executable: 'pnpm',
        args: ['test', '--run'],
        cwd: 'packages/core',
      }),
    ).toEqual({
      executable: 'pnpm',
      args: ['test', '--run'],
      cwd: 'packages/core',
    });

    expect(() =>
      workspaceCommandArgumentsSchema.parse({
        executable: 'C:\\Windows\\System32\\cmd.exe',
        args: [],
      }),
    ).toThrow();
    expect(() =>
      workspaceCommandArgumentsSchema.parse({
        executable: 'node',
        args: ['script.js\nwhoami'],
      }),
    ).toThrow();
    expect(() =>
      workspaceCommandArgumentsSchema.parse({
        executable: 'node',
        args: [],
        cwd: '../outside',
      }),
    ).toThrow();
    expect(() =>
      workspaceCommandArgumentsSchema.parse({
        executable: 'node',
        args: [],
        shell: true,
      }),
    ).toThrow();
  });

  it('拒绝白名单外命令和疑似携带凭据的参数', () => {
    expect(() => assertSafeCommand({ executable: 'curl', args: [], cwd: '' })).toThrowError(
      expect.objectContaining({ code: 'COMMAND_NOT_ALLOWED' }),
    );
    expect(() =>
      assertSafeCommand({
        executable: 'node',
        args: ['script.js', '--token=plain-secret-value'],
        cwd: '',
      }),
    ).toThrowError(expect.objectContaining({ code: 'COMMAND_CONTAINS_SECRET' }));
    expect(() =>
      assertSafeCommand({
        executable: 'pnpm.cmd',
        args: ['test'],
        cwd: '',
      }),
    ).not.toThrow();
    for (const command of [
      { executable: 'node', args: ['-e', 'process.exit()'], cwd: '' },
      { executable: 'node', args: ['-eprocess.exit()'], cwd: '' },
      { executable: 'python', args: ['-c', 'print(1)'], cwd: '' },
      { executable: 'python', args: ['-cprint(1)'], cwd: '' },
      { executable: 'npx', args: ['some-package'], cwd: '' },
      { executable: 'npm', args: ['exec', 'some-package'], cwd: '' },
      { executable: 'pnpm', args: ['install'], cwd: '' },
      { executable: 'git', args: ['reset', '--hard'], cwd: '' },
      { executable: 'cargo', args: ['install', 'some-package'], cwd: '' },
      { executable: 'vitest', args: ['--config', '../outside.ts'], cwd: '' },
    ]) {
      expect(() => assertSafeCommand(command)).toThrow();
    }
    expect(() =>
      assertSafeCommand({
        executable: 'pnpm',
        args: ['--filter', '@e-agent/core', 'run', 'typecheck'],
        cwd: '',
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeCommand({
        executable: 'git',
        args: ['diff', '--stat'],
        cwd: '',
      }),
    ).not.toThrow();
  });
});

describe('WorkspaceCommandRunner', () => {
  it('以 shell:false 在解析后的工作区 cwd 中运行并只传递环境白名单', async () => {
    const fixture = await createFixture();
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn((_executable: string, _args: string[], _options: SpawnOptions) =>
      child.asChild(),
    );
    const runner = new WorkspaceCommandRunner({
      workspace: fixture.workspace,
      spawnProcess,
    });

    const resultPromise = runner.run(
      { executable: 'node', args: ['--version'], cwd: 'src' },
      {
        bindingId: fixture.binding.bindingId,
        timeoutMs: 10_000,
        outputLimitBytes: 32_768,
      },
    );
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.stdout.write('v24.0.0\r\n');
    child.close(0);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed',
      stdout: 'v24.0.0\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });
    const [, args, options] = spawnProcess.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toEqual(['--version']);
    expect(options).toMatchObject({
      cwd: join(fixture.root, 'src'),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(options.env).not.toHaveProperty('E_AGENT_API_KEY');
  });

  it('达到超时时间后终止进程树并返回 timed-out', async () => {
    const fixture = await createFixture();
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolvePromise) => {
      markSpawned = resolvePromise;
    });
    const terminateTree = vi.fn(async () => {
      child.close(null, 'SIGTERM');
    });
    const runner = new WorkspaceCommandRunner({
      workspace: fixture.workspace,
      spawnProcess: () => {
        markSpawned?.();
        return child.asChild();
      },
      terminateTree,
    });

    const resultPromise = runner.run(
      { executable: 'node', args: ['long-running.js'], cwd: '' },
      {
        bindingId: fixture.binding.bindingId,
        timeoutMs: 1_000,
        outputLimitBytes: 32_768,
      },
    );
    await spawned;
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'timed-out',
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(terminateTree).toHaveBeenCalledWith(child);
  });

  it('调用前信号已中止时立即终止且不会触发未初始化计时器', async () => {
    const fixture = await createFixture();
    const child = new FakeChildProcess();
    const terminateTree = vi.fn(async () => {
      child.close(null, 'SIGTERM');
    });
    const runner = new WorkspaceCommandRunner({
      workspace: fixture.workspace,
      spawnProcess: () => child.asChild(),
      terminateTree,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run(
        { executable: 'node', args: ['long-running.js'], cwd: '' },
        {
          bindingId: fixture.binding.bindingId,
          timeoutMs: 10_000,
          outputLimitBytes: 32_768,
          signal: controller.signal,
        },
      ),
    ).resolves.toMatchObject({
      status: 'cancelled',
      signal: 'SIGTERM',
    });
    expect(terminateTree).toHaveBeenCalledOnce();
  });

  it('限制 stdout/stderr 总大小并清除 ANSI、控制字符与敏感信息', async () => {
    const fixture = await createFixture();
    const child = new FakeChildProcess();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolvePromise) => {
      markSpawned = resolvePromise;
    });
    const spawnProcess = vi.fn((_executable: string, _args: string[], _options: SpawnOptions) => {
      markSpawned?.();
      return child.asChild();
    });
    const runner = new WorkspaceCommandRunner({
      workspace: fixture.workspace,
      spawnProcess,
    });

    const resultPromise = runner.run(
      { executable: 'pnpm', args: ['test'], cwd: '' },
      {
        bindingId: fixture.binding.bindingId,
        timeoutMs: 10_000,
        outputLimitBytes: 4_096,
      },
    );
    await spawned;
    child.stdout.write(
      `\u001B[31mfailed\u001B[0m\u0000 api_key=plain-secret-value ${'x'.repeat(5_000)}`,
    );
    child.stderr.write('stderr-after-limit');
    child.close(1);

    const result = await resultPromise;
    expect(result.status).toBe('failed');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('failed');
    expect(result.stdout).not.toContain('\u001B');
    expect(result.stdout).not.toContain('\u0000');
    expect(result.stdout).not.toContain('plain-secret-value');
    const [spawnedExecutable, spawnedArguments, spawnedOptions] = spawnProcess.mock.calls[0] as [
      string,
      string[],
      SpawnOptions,
    ];
    expect(spawnedOptions.shell).toBe(false);
    if (process.platform === 'win32') {
      expect(spawnedExecutable.toLowerCase()).toMatch(/node\.exe$/u);
      expect(spawnedArguments[0]?.replaceAll('\\', '/')).toMatch(
        /node_modules\/corepack\/dist\/pnpm\.js$/u,
      );
      expect(spawnedArguments.at(-1)).toBe('test');
    } else {
      expect(spawnedExecutable).toBe('pnpm');
      expect(spawnedArguments).toEqual(['test']);
    }
  });
});
