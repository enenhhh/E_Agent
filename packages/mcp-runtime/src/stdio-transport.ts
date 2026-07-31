import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { win32 } from 'node:path';

import type { StdioMcpTransportConfig } from './config.js';
import { McpRuntimeError, toSafeMcpError } from './errors.js';
import {
  isJsonRpcResponse,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SupportedMcpProtocolVersion,
} from './protocol.js';
import { redactMcpValue } from './redaction.js';
import {
  createTimeoutSignal,
  requestKey,
  type McpRequestOptions,
  type McpRuntimeLogger,
  type McpTransport,
  type McpTransportMessageListener,
} from './transport.js';

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

export interface StdioMcpTransportOptions {
  serverId: string;
  config: StdioMcpTransportConfig;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  logger?: McpRuntimeLogger;
  processEnv?: NodeJS.ProcessEnv;
}

export interface StdioSpawnInvocation {
  executable: string;
  args: string[];
}

export interface StdioSpawnResolutionOptions {
  platform?: NodeJS.Platform;
  processExecPath?: string;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => Promise<boolean>;
}

/** MCP 标准输入输出传输；每行只接受一个 UTF-8 JSON-RPC 消息。 */
export class StdioMcpTransport implements McpTransport {
  public readonly kind = 'stdio' as const;
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<McpTransportMessageListener>();
  private closing = false;

  public constructor(private readonly options: StdioMcpTransportOptions) {}

  public get connected(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.closing;
  }

  public setProtocolVersion(_version: SupportedMcpProtocolVersion): void {
    // stdio 传输不使用协议版本请求头；版本仍由 initialize 协商。
  }

  public async connect(requestOptions: McpRequestOptions = {}): Promise<void> {
    if (this.connected) return;
    this.closing = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    const timeout = createTimeoutSignal(
      requestOptions.timeoutMs ?? this.options.connectTimeoutMs ?? 10_000,
      requestOptions.signal,
    );
    try {
      if (timeout.signal.aborted) {
        throw cancellationError(this.options.serverId, timeout.timedOut());
      }
      const environment = buildStdioEnvironment(
        this.options.config,
        this.options.processEnv ?? process.env,
      );
      const invocation = await resolveStdioSpawnInvocation(this.options.config, {
        environment,
      });
      if (timeout.signal.aborted) {
        throw cancellationError(this.options.serverId, timeout.timedOut());
      }
      const child = spawn(invocation.executable, invocation.args, {
        cwd: this.options.config.cwd,
        env: environment,
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.attachChild(child);
      await waitForSpawn(child, timeout.signal);
      this.log('info', 'MCP stdio 服务已启动', { serverId: this.options.serverId });
    } catch (error) {
      const child = this.child;
      this.child = undefined;
      if (child !== undefined) {
        await terminateProcessTree(child, true);
        await waitForExit(child, 1_000);
      }
      if (timeout.signal.aborted) {
        throw cancellationError(this.options.serverId, timeout.timedOut());
      }
      if (timeout.timedOut()) {
        throw new McpRuntimeError('REQUEST_TIMEOUT', 'MCP stdio 服务启动超时。', {
          serverId: this.options.serverId,
          retryable: true,
        });
      }
      throw toSafeMcpError(error, 'CONNECT_FAILED', this.options.serverId);
    } finally {
      timeout.dispose();
    }
  }

  public async request(
    request: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    this.assertConnected();
    const key = requestKey(request.id);
    if (this.pending.has(key)) {
      throw new McpRuntimeError('PROTOCOL_INVALID', 'JSON-RPC 请求 ID 重复。', {
        serverId: this.options.serverId,
      });
    }
    const timeout = createTimeoutSignal(
      options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
      options.signal,
    );
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      let writeStarted = false;
      const abort = (): void => {
        const pending = this.pending.get(key);
        if (pending === undefined) return;
        this.pending.delete(key);
        pending.dispose();
        if (writeStarted) {
          void this.writeMessage({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: request.id, reason: timeout.timedOut() ? 'timeout' : 'cancelled' },
          }).catch(() => undefined);
        }
        reject(
          new McpRuntimeError(
            timeout.timedOut() ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED',
            timeout.timedOut() ? 'MCP 请求超时。' : 'MCP 请求已取消。',
            { serverId: this.options.serverId, retryable: timeout.timedOut() },
          ),
        );
      };
      timeout.signal.addEventListener('abort', abort, { once: true });
      this.pending.set(key, {
        resolve,
        reject,
        dispose: () => {
          timeout.signal.removeEventListener('abort', abort);
          timeout.dispose();
        },
      });
      if (timeout.signal.aborted) {
        abort();
        return;
      }
      writeStarted = true;
      void this.writeMessage(request).catch((error: unknown) => {
        const pending = this.pending.get(key);
        if (pending === undefined) return;
        this.pending.delete(key);
        pending.dispose();
        reject(toSafeMcpError(error, 'TRANSPORT_ERROR', this.options.serverId));
      });
    });
  }

  public async notify(
    notification: JsonRpcNotification,
    options: McpRequestOptions = {},
  ): Promise<void> {
    this.assertConnected();
    const timeout = createTimeoutSignal(
      options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
      options.signal,
    );
    try {
      if (timeout.signal.aborted) {
        throw cancellationError(this.options.serverId, timeout.timedOut());
      }
      await settleWithSignal(this.writeMessage(notification), timeout.signal);
    } catch (error) {
      if (timeout.signal.aborted) {
        throw cancellationError(this.options.serverId, timeout.timedOut());
      }
      throw toSafeMcpError(error, 'TRANSPORT_ERROR', this.options.serverId);
    } finally {
      timeout.dispose();
    }
  }

  public async respond(
    id: JsonRpcId,
    result: unknown,
    error?: { code: number; message: string },
  ): Promise<void> {
    await this.writeMessage(
      error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error },
    );
  }

  public subscribe(listener: McpTransportMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.closing = true;
    this.child = undefined;
    this.rejectPending(
      new McpRuntimeError('CONNECTION_CLOSED', 'MCP stdio 连接已关闭。', {
        serverId: this.options.serverId,
      }),
    );
    if (!child.stdin.destroyed) child.stdin.end();
    const exitedGracefully = await waitForExit(child, this.options.config.shutdownGraceMs);
    if (!exitedGracefully) {
      await terminateProcessTree(child, false);
      await waitForExit(child, 250);
      await terminateProcessTree(child, true);
      await waitForExit(child, 1_000);
    }
    this.closing = false;
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));
    child.once('error', (error) => {
      if (this.child === child) this.fail(error);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.closing) {
        void terminateProcessTree(child, true);
        this.fail(
          new McpRuntimeError(
            'CONNECTION_CLOSED',
            `MCP stdio 服务意外退出（code=${String(code)}, signal=${String(signal)}）。`,
            { serverId: this.options.serverId, retryable: true },
          ),
        );
      }
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (
      Buffer.byteLength(this.stdoutBuffer, 'utf8') >
      (this.options.maxMessageBytes ?? 4 * 1_024 * 1_024)
    ) {
      this.fail(
        new McpRuntimeError('LIMIT_EXCEEDED', 'MCP stdio 消息超过大小限制。', {
          serverId: this.options.serverId,
        }),
      );
      this.child?.kill();
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.consumeLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(line) as unknown);
    } catch {
      this.fail(
        new McpRuntimeError('PROTOCOL_INVALID', 'MCP stdio 服务输出了无效 JSON-RPC。', {
          serverId: this.options.serverId,
        }),
      );
      this.child?.kill();
      return;
    }
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(requestKey(message.id ?? 'null'));
      if (pending === undefined) return;
      this.pending.delete(requestKey(message.id ?? 'null'));
      pending.dispose();
      pending.resolve(message);
      return;
    }
    for (const listener of this.listeners) {
      void Promise.resolve(listener(message)).catch(() => undefined);
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-8_192);
    let newline = this.stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line.length > 0) {
        this.log('debug', 'MCP stdio 日志', {
          serverId: this.options.serverId,
          bytes: Buffer.byteLength(line, 'utf8'),
          message: '[third-party stderr suppressed]',
        });
      }
      newline = this.stderrBuffer.indexOf('\n');
    }
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    this.assertConnected();
    const serialized = `${JSON.stringify(message)}\n`;
    if (
      Buffer.byteLength(serialized, 'utf8') > (this.options.maxMessageBytes ?? 4 * 1_024 * 1_024)
    ) {
      throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP 请求超过大小限制。', {
        serverId: this.options.serverId,
      });
    }
    const input = this.child?.stdin;
    if (input === undefined || input.destroyed) {
      throw new McpRuntimeError('CONNECTION_CLOSED', 'MCP stdio 输入流已关闭。', {
        serverId: this.options.serverId,
      });
    }
    await new Promise<void>((resolve, reject) => {
      input.write(serialized, 'utf8', (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new McpRuntimeError('CONNECTION_CLOSED', 'MCP stdio 服务未连接。', {
        serverId: this.options.serverId,
      });
    }
  }

  private fail(error: unknown): void {
    const safe = toSafeMcpError(error, 'TRANSPORT_ERROR', this.options.serverId);
    this.rejectPending(safe);
    this.log('error', 'MCP stdio 连接失败', {
      serverId: this.options.serverId,
      code: safe.code,
      message: safe.message,
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private log(
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.options.logger?.(level, message, redactMcpValue(fields ?? {}));
  }
}

const windowsNodeCliEntries: Readonly<
  Record<'npm' | 'npx' | 'pnpm' | 'yarn', readonly (readonly string[])[]>
> = {
  npm: [['node_modules', 'npm', 'bin', 'npm-cli.js']],
  npx: [['node_modules', 'npm', 'bin', 'npx-cli.js']],
  pnpm: [
    ['node_modules', 'corepack', 'dist', 'pnpm.js'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
    ['node_modules', 'pnpm', 'bin', 'pnpm.js'],
    ['pnpm.cjs'],
    ['pnpm.js'],
  ],
  yarn: [
    ['node_modules', 'corepack', 'dist', 'yarn.js'],
    ['node_modules', 'yarn', 'bin', 'yarn.js'],
    ['yarn.js'],
  ],
};

/**
 * Windows 的 npm 系命令通常是 `.cmd`/PowerShell shim，Node 在 `shell:false`
 * 下不能直接启动。这里只解析已知 shim 到 node.exe 与真实 CLI，不调用 shell。
 */
export async function resolveStdioSpawnInvocation(
  config: StdioMcpTransportConfig,
  options: StdioSpawnResolutionOptions = {},
): Promise<StdioSpawnInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { executable: config.command, args: [...config.args] };
  }

  const pathApi = win32;
  const commandBase = pathApi.basename(config.command).toLowerCase();
  if (commandBase.endsWith('.exe')) {
    return { executable: config.command, args: [...config.args] };
  }
  const commandName = commandBase.replace(/\.(?:cmd|ps1)$/u, '');
  const normalizedName = commandName === 'yarnpkg' ? 'yarn' : commandName;
  if (!Object.hasOwn(windowsNodeCliEntries, normalizedName)) {
    return { executable: config.command, args: [...config.args] };
  }

  const environment = options.environment ?? process.env;
  const exists = options.fileExists ?? fileExists;
  const pathDirectories = splitWindowsPath(environment);
  const commandDirectory =
    win32.isAbsolute(config.command) || /[\\/]/u.test(config.command)
      ? pathApi.dirname(config.command)
      : undefined;
  const processExecutable = options.processExecPath ?? process.execPath;
  const nodeCandidates = uniquePaths([
    ...(pathApi.basename(processExecutable).toLowerCase() === 'node.exe'
      ? [processExecutable]
      : []),
    ...(commandDirectory === undefined ? [] : [pathApi.join(commandDirectory, 'node.exe')]),
    ...pathDirectories.map((directory) => pathApi.join(directory, 'node.exe')),
  ]);
  const nodeExecutable = await firstExistingPath(nodeCandidates, exists);
  if (nodeExecutable === undefined) {
    throw new Error('未找到可在无 shell 模式下启动 MCP Server 的 node.exe。');
  }

  const searchRoots = uniquePaths([
    ...(commandDirectory === undefined ? [] : [commandDirectory]),
    pathApi.dirname(nodeExecutable),
    ...pathDirectories,
  ]);
  const relativeEntries =
    windowsNodeCliEntries[normalizedName as keyof typeof windowsNodeCliEntries];
  const cliCandidates = searchRoots.flatMap((root) =>
    relativeEntries.map((segments) => pathApi.join(root, ...segments)),
  );
  const cliEntry = await firstExistingPath(cliCandidates, exists);
  if (cliEntry === undefined) {
    throw new Error(`未找到可在无 shell 模式下启动 MCP Server 的 ${normalizedName} CLI。`);
  }

  return {
    executable: nodeExecutable,
    args: [cliEntry, ...config.args],
  };
}

function splitWindowsPath(environment: NodeJS.ProcessEnv): string[] {
  const pathValue =
    Object.entries(environment).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  return pathValue
    .split(';')
    .map((entry) => entry.replace(/^"|"$/gu, '').trim())
    .filter(Boolean);
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

async function firstExistingPath(
  paths: readonly string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const path of paths) {
    if (await exists(path)) return path;
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

function buildStdioEnvironment(
  config: StdioMcpTransportConfig,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const baseline =
    process.platform === 'win32'
      ? ['COMSPEC', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE']
      : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR'];
  const result: NodeJS.ProcessEnv = {};
  for (const name of new Set([...baseline, ...config.inheritEnv])) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...config.env };
}

function cancellationError(serverId: string, timedOut: boolean): McpRuntimeError {
  return new McpRuntimeError(
    timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED',
    timedOut ? 'MCP 请求超时。' : 'MCP 请求已取消。',
    { serverId, retryable: timedOut },
  );
}

function settleWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    const timer = setTimeout(
      () => {
        child.removeListener('exit', onExit);
        resolve(false);
      },
      Math.max(0, timeoutMs),
    );
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    }
    return;
  }
  if (!force) return;
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.removeListener('error', finish);
      killer.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish();
    }, 2_000);
    killer.once('error', finish);
    killer.once('close', finish);
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (child.pid !== undefined) return;
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
