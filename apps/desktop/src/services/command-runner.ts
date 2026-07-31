import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

import { redactText } from '@e-agent/security';
import { z } from 'zod';

import { DesktopError } from './errors.js';
import type { WorkspaceService } from './workspace.js';

const relativeDirectorySchema = z
  .string()
  .max(1_024)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value) &&
      !value.replaceAll('\\', '/').split('/').includes('..'),
    'cwd 必须是工作区内的相对路径',
  );

export const workspaceCommandArgumentsSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/u, 'executable 只能是安全命令名，不能包含路径或 shell 语法'),
    args: z
      .array(
        z
          .string()
          .max(4_096)
          .refine(
            (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n'),
            '命令参数不能包含换行或空字符',
          ),
      )
      .max(64)
      .default([]),
    cwd: relativeDirectorySchema.default(''),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(value.executable, 'utf8') +
        value.args.reduce((total, argument) => total + Buffer.byteLength(argument, 'utf8'), 0) <=
      32_768,
    '命令参数总长度超过限制',
  );

export type WorkspaceCommandArguments = z.infer<typeof workspaceCommandArgumentsSchema>;

export interface CommandRunResult {
  status: 'cancelled' | 'completed' | 'failed' | 'timed-out';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

type SpawnProcess = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface WorkspaceCommandRunnerOptions {
  workspace: WorkspaceService;
  spawnProcess?: SpawnProcess;
  terminateTree?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  now?: () => number;
}

const allowedExecutables = new Set([
  'cargo',
  'eslint',
  'git',
  'go',
  'node',
  'npm',
  'pnpm',
  'py',
  'pytest',
  'python',
  'python3',
  'tsc',
  'vitest',
  'yarn',
]);

const sensitiveCommandPattern =
  /(?:\b(?:api[-_]?key|authorization|bearer|cookie|password|passwd|secret|token)\b\s*[:=]?|(?:sk|gsk|xox[baprs])[-_][A-Za-z0-9_-]{8,})/iu;

/**
 * 拒绝 shell、解释器外壳和可能携带凭据的参数。
 */
export function assertSafeCommand(arguments_: WorkspaceCommandArguments): void {
  const executable = arguments_.executable.toLowerCase().replace(/\.(?:cmd|exe)$/u, '');
  if (!allowedExecutables.has(executable)) {
    throw new DesktopError(
      'COMMAND_NOT_ALLOWED',
      `命令 ${arguments_.executable} 不在安全命令白名单中`,
    );
  }
  if (
    [arguments_.executable, ...arguments_.args].some((value) => sensitiveCommandPattern.test(value))
  ) {
    throw new DesktopError(
      'COMMAND_CONTAINS_SECRET',
      '命令参数疑似包含 API Key、Token 或密码，已拒绝执行',
    );
  }
  if (arguments_.args.some(hasEscapingPath)) {
    throw new DesktopError(
      'COMMAND_PATH_OUTSIDE_WORKSPACE',
      '命令参数不能引用绝对路径或通过 .. 逃逸工作区',
    );
  }
  assertSafeArguments(executable, arguments_.args);
}

function assertSafeArguments(executable: string, args: readonly string[]): void {
  if (executable === 'node') {
    const denied = new Set([
      '-e',
      '--eval',
      '-p',
      '--print',
      '-r',
      '--require',
      '--import',
      '--loader',
      '--experimental-loader',
    ]);
    if (
      args.some(
        (argument) =>
          denied.has(argument) ||
          /^-[epr].+/u.test(argument) ||
          ['--eval=', '--require=', '--import=', '--loader=', '--experimental-loader='].some(
            (prefix) => argument.startsWith(prefix),
          ),
      )
    ) {
      throw unsafeArguments('Node 内联代码和预加载模块');
    }
    const firstTarget = args.find((argument) => !argument.startsWith('-'));
    if (firstTarget === '-') throw unsafeArguments('Node 标准输入脚本');
    return;
  }
  if (executable === 'python' || executable === 'python3' || executable === 'py') {
    if (
      args.some((argument) => argument === '-' || argument.startsWith('-c') || argument === '-m')
    ) {
      throw unsafeArguments('Python 内联代码、模块或标准输入脚本');
    }
    return;
  }
  if (executable === 'git') {
    const command = args[0];
    if (command === undefined || !['status', 'diff', 'log', 'show'].includes(command)) {
      throw unsafeArguments('Git 仅允许 status、diff、log 和 show');
    }
    return;
  }
  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn') {
    assertSafePackageManagerArguments(args);
    return;
  }
  if (executable === 'go') {
    if (!['test', 'build'].includes(args[0] ?? '')) {
      throw unsafeArguments('Go 仅允许 test 和 build');
    }
    return;
  }
  if (executable === 'cargo') {
    if (!['test', 'check', 'clippy', 'build'].includes(args[0] ?? '')) {
      throw unsafeArguments('Cargo 仅允许 test、check、clippy 和 build');
    }
  }
}

function assertSafePackageManagerArguments(args: readonly string[]): void {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (
      argument === '--filter' ||
      argument === '-F' ||
      argument === '--workspace' ||
      argument === '-w'
    ) {
      if (args[index + 1] === undefined || args[index + 1]?.startsWith('-') === true) {
        throw unsafeArguments('包筛选参数缺少安全值');
      }
      index += 2;
      continue;
    }
    if (
      argument?.startsWith('--filter=') === true ||
      argument?.startsWith('--workspace=') === true
    ) {
      index += 1;
      continue;
    }
    break;
  }
  const command = args[index];
  const safeScripts = new Set(['build', 'check', 'lint', 'test', 'typecheck']);
  if (command === 'test' || safeScripts.has(command ?? '')) return;
  if (command === 'run' && safeScripts.has(args[index + 1] ?? '')) return;
  throw unsafeArguments('包管理器仅允许 test，或运行 build、lint、typecheck、check、test 脚本');
}

function hasEscapingPath(argument: string): boolean {
  const normalized = argument.replaceAll('\\', '/');
  return /(?:^|=)(?:[A-Za-z]:\/|\/\/|\/)/u.test(normalized) || normalized.split('/').includes('..');
}

function unsafeArguments(description: string): DesktopError {
  return new DesktopError('COMMAND_ARGUMENTS_NOT_ALLOWED', `${description}不在安全参数策略内`);
}

/**
 * 在已绑定工作区内运行结构化命令。调用者必须先完成用户审批。
 */
export class WorkspaceCommandRunner {
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateTree: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  private readonly now: () => number;

  public constructor(private readonly options: WorkspaceCommandRunnerOptions) {
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(executable, args, spawnOptions) as ChildProcessWithoutNullStreams);
    this.terminateTree = options.terminateTree ?? terminateProcessTree;
    this.now = options.now ?? Date.now;
  }

  public async run(
    input: WorkspaceCommandArguments,
    options: {
      bindingId: string;
      timeoutMs: number;
      outputLimitBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<CommandRunResult> {
    const parsed = workspaceCommandArgumentsSchema.parse(input);
    assertSafeCommand(parsed);
    const binding = this.options.workspace.assertBinding(options.bindingId);
    const cwd = await this.options.workspace.resolveDirectory(parsed.cwd);
    this.options.workspace.assertBinding(options.bindingId);
    const invocation = await resolveSpawnInvocation(
      parsed.executable,
      parsed.args,
      cwd,
      binding.root,
    );
    this.options.workspace.assertBinding(options.bindingId);

    const timeoutMs = Math.max(
      1_000,
      Math.min(parsed.timeoutMs ?? options.timeoutMs, options.timeoutMs, 300_000),
    );
    const outputLimitBytes = Math.max(4_096, Math.min(options.outputLimitBytes, 1_048_576));
    const startedAt = this.now();

    return new Promise<CommandRunResult>((resolvePromise) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(invocation.executable, invocation.args, {
          cwd,
          detached: process.platform !== 'win32',
          env: commandEnvironment(),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolvePromise({
          status: 'failed',
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: null,
          durationMs: Math.max(0, this.now() - startedAt),
          truncated: false,
          error: sanitizeOutput(error instanceof Error ? error.message : '命令启动失败'),
        });
        return;
      }

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let capturedBytes = 0;
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let forceFinishTimer: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;

      const capture = (stream: 'stderr' | 'stdout', chunk: string | Buffer): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        const remaining = Math.max(0, outputLimitBytes - capturedBytes);
        if (remaining === 0) {
          truncated = true;
          return;
        }
        const accepted = buffer.subarray(0, remaining);
        capturedBytes += accepted.byteLength;
        if (accepted.byteLength < buffer.byteLength) {
          truncated = true;
        }
        if (stream === 'stdout') {
          stdout = Buffer.concat([stdout, accepted]);
        } else {
          stderr = Buffer.concat([stderr, accepted]);
        }
      };
      child.stdout.on('data', (chunk: string | Buffer) => capture('stdout', chunk));
      child.stderr.on('data', (chunk: string | Buffer) => capture('stderr', chunk));

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        error?: Error,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceFinishTimer !== undefined) clearTimeout(forceFinishTimer);
        options.signal?.removeEventListener('abort', abort);
        const status: CommandRunResult['status'] = cancelled
          ? 'cancelled'
          : timedOut
            ? 'timed-out'
            : error !== undefined || exitCode !== 0
              ? 'failed'
              : 'completed';
        resolvePromise({
          status,
          stdout: sanitizeOutput(stdout.toString('utf8')),
          stderr: sanitizeOutput(stderr.toString('utf8')),
          exitCode,
          signal,
          durationMs: Math.max(0, this.now() - startedAt),
          truncated,
          ...(error === undefined ? {} : { error: sanitizeOutput(error.message) }),
        });
      };

      const stop = (reason: 'cancelled' | 'timed-out'): void => {
        if (settled) return;
        cancelled = reason === 'cancelled';
        timedOut = reason === 'timed-out';
        void this.terminateTree(child).finally(() => {
          forceFinishTimer = setTimeout(() => finish(null, null), 1_000);
          forceFinishTimer.unref();
        });
      };
      const abort = (): void => stop('cancelled');
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (exitCode, signal) => finish(exitCode, signal));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted === true) abort();

      if (!settled) {
        timeout = setTimeout(() => stop('timed-out'), timeoutMs);
        timeout.unref();
      }
    });
  }
}

async function resolveSpawnInvocation(
  executable: string,
  args: readonly string[],
  cwd: string,
  workspaceRoot: string,
): Promise<{ executable: string; args: string[] }> {
  if (process.platform !== 'win32') {
    return { executable, args: [...args] };
  }
  const name = executable.toLowerCase().replace(/\.(?:cmd|exe)$/u, '');
  const cliRelativePaths: Partial<Record<string, readonly string[]>> = {
    eslint: ['node_modules', 'eslint', 'bin', 'eslint.js'],
    tsc: ['node_modules', 'typescript', 'bin', 'tsc'],
    vitest: ['node_modules', 'vitest', 'vitest.mjs'],
  };
  const localCliPath = cliRelativePaths[name];
  if (localCliPath !== undefined) {
    const cli = await findWorkspaceCli(cwd, workspaceRoot, localCliPath);
    const node = await findPathExecutable('node.exe');
    if (cli === undefined || node === undefined) {
      throw new DesktopError(
        'COMMAND_RUNTIME_NOT_FOUND',
        `${executable} 的本地 CLI 或 node.exe 不可用，请先安装项目依赖`,
      );
    }
    return { executable: node, args: [cli, ...args] };
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    const node = await findPathExecutable('node.exe');
    if (node === undefined) {
      throw new DesktopError('COMMAND_RUNTIME_NOT_FOUND', '未在 PATH 中找到 node.exe');
    }
    const nodeDirectory = dirname(node);
    const candidates =
      name === 'npm'
        ? [join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
        : [
            join(nodeDirectory, 'node_modules', 'corepack', 'dist', `${name}.js`),
            join(nodeDirectory, 'node_modules', name, 'bin', `${name}.cjs`),
            join(nodeDirectory, 'node_modules', name, 'bin', `${name}.js`),
          ];
    const cli = await firstExistingFile(candidates);
    if (cli === undefined) {
      throw new DesktopError(
        'COMMAND_RUNTIME_NOT_FOUND',
        `未找到可在无 shell 模式下运行的 ${name} CLI`,
      );
    }
    return { executable: node, args: [cli, ...args] };
  }
  return { executable, args: [...args] };
}

async function findWorkspaceCli(
  cwd: string,
  workspaceRoot: string,
  relativeSegments: readonly string[],
): Promise<string | undefined> {
  let current = cwd;
  for (;;) {
    const candidate = join(current, ...relativeSegments);
    if (await fileExists(candidate)) return candidate;
    if (current === workspaceRoot) return undefined;
    const parent = dirname(current);
    if (
      parent === current ||
      relative(workspaceRoot, parent).startsWith('..') ||
      isAbsolute(relative(workspaceRoot, parent))
    ) {
      return undefined;
    }
    current = parent;
  }
}

async function findPathExecutable(fileName: string): Promise<string | undefined> {
  const directories = (process.env['PATH'] ?? '')
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/gu, '').trim())
    .filter(Boolean);
  return firstExistingFile(directories.map((directory) => join(directory, fileName)));
}

async function firstExistingFile(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await fileExists(path)) return path;
  }
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'APPDATA',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'NO_COLOR',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function sanitizeOutput(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  const ansiPattern = new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, 'gu');
  const withoutAnsi = value.replace(ansiPattern, '');
  let safe = '';
  for (const character of withoutAnsi) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isBidiControl =
      (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (isBidiControl || codePoint === 0x7f) continue;
    if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
      continue;
    }
    safe += character;
  }
  return redactText(safe.replace(/\r\n?/gu, '\n'));
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        child.kill('SIGKILL');
        resolvePromise();
      });
      killer.once('close', () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-(child.pid ?? 0), 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 250);
  force.unref();
}
