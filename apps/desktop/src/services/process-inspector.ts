import { spawn } from 'node:child_process';
import { cpus, freemem, platform, release, totalmem } from 'node:os';

import { redactText } from '@e-agent/security';
import { z } from 'zod';

import { DesktopError } from './errors.js';

export const processListArgumentsSchema = z
  .object({
    query: z.string().max(128).default(''),
    maxResults: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export type ProcessListArguments = z.infer<typeof processListArgumentsSchema>;

export interface ProcessListResult {
  kind: 'process-list';
  processes: Array<{
    cpuPercent?: number;
    memoryBytes?: number;
    memoryPercent?: number;
    name: string;
    parentPid?: number;
    pid: number;
  }>;
  query: string;
  truncated: boolean;
}

type SnapshotProvider = (options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string>;

export interface SystemProcessInspectorOptions {
  platform?: NodeJS.Platform;
  snapshotProvider?: SnapshotProvider;
}

/**
 * 只读取进程名称、PID、父 PID、CPU 和内存统计，不读取命令行、环境变量或进程所有者。
 */
export class SystemProcessInspector {
  private readonly platform: NodeJS.Platform;
  private readonly snapshotProvider: SnapshotProvider;

  public constructor(options: SystemProcessInspectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.snapshotProvider =
      options.snapshotProvider ?? ((request) => captureProcessSnapshot(this.platform, request));
  }

  public async list(
    input: ProcessListArguments,
    options: { outputLimitBytes: number; signal?: AbortSignal; timeoutMs: number },
  ): Promise<ProcessListResult> {
    const raw = await this.snapshotProvider({
      timeoutMs: Math.max(1_000, Math.min(options.timeoutMs, 30_000)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const parsed =
      this.platform === 'win32' ? parseWindowsTaskList(raw) : parsePortableProcessList(raw);
    const query = input.query.toLocaleLowerCase();
    const matched = parsed.filter(
      (process_) => query === '' || process_.name.toLocaleLowerCase().includes(query),
    );
    const filtered = matched.slice(0, input.maxResults);
    const result: ProcessListResult = {
      kind: 'process-list',
      query: input.query,
      processes: filtered,
      truncated: filtered.length < matched.length,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > options.outputLimitBytes) {
      while (
        result.processes.length > 0 &&
        Buffer.byteLength(JSON.stringify(result), 'utf8') > options.outputLimitBytes
      ) {
        result.processes.pop();
        result.truncated = true;
      }
    }
    return result;
  }
}

export function safeSystemInfo(): {
  kind: 'system-info';
  architecture: string;
  cpu: { logicalCores: number; model: string };
  memory: { freeBytes: number; totalBytes: number };
  operatingSystem: { platform: NodeJS.Platform; release: string };
  runtime: { electron?: string; node: string };
} {
  const processors = cpus();
  return {
    kind: 'system-info',
    operatingSystem: { platform: platform(), release: release().slice(0, 128) },
    architecture: process.arch,
    cpu: {
      logicalCores: processors.length,
      model: redactText(processors[0]?.model ?? 'unknown').slice(0, 256),
    },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron === undefined ? {} : { electron: process.versions.electron }),
    },
  };
}

function parseWindowsTaskList(raw: string): ProcessListResult['processes'] {
  return raw
    .split(/\r?\n/gu)
    .filter(Boolean)
    .flatMap((line) => {
      const columns = parseCsvLine(line);
      const pid = Number(columns[1]);
      if (!Number.isInteger(pid) || pid < 0) return [];
      const memoryDigits = (columns[4] ?? '').replace(/[^\d]/gu, '');
      return [
        {
          pid,
          name: redactText(columns[0] ?? 'unknown').slice(0, 256),
          ...(memoryDigits === '' ? {} : { memoryBytes: Number(memoryDigits) * 1_024 }),
        },
      ];
    });
}

function parsePortableProcessList(raw: string): ProcessListResult['processes'] {
  return raw
    .split(/\r?\n/gu)
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s*$/u.exec(line);
      if (match === null) return [];
      return [
        {
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          name: redactText(match[3] ?? 'unknown').slice(0, 256),
          cpuPercent: Number(match[4]),
          memoryPercent: Number(match[5]),
        },
      ];
    });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      result.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

async function captureProcessSnapshot(
  targetPlatform: NodeJS.Platform,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  const executable = targetPlatform === 'win32' ? 'tasklist.exe' : 'ps';
  const args =
    targetPlatform === 'win32' ? ['/fo', 'csv', '/nh'] : ['-eo', 'pid=,ppid=,comm=,%cpu=,%mem='];
  return captureFixedCommand(executable, args, options);
}

async function captureFixedCommand(
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve(output);
      else reject(error);
    };
    const abort = (): void => {
      child.kill();
      finish(new DesktopError('PROCESS_INSPECTION_CANCELLED', '进程检查已取消。'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new DesktopError('PROCESS_INSPECTION_TIMEOUT', '进程检查已超时。'));
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = 2_000_000 - Buffer.byteLength(output, 'utf8');
      if (remaining <= 0) return;
      output += chunk.subarray(0, remaining).toString('utf8');
    });
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new DesktopError('PROCESS_INSPECTION_FAILED', '无法读取本机进程列表。'));
    });
    if (options.signal?.aborted) abort();
  });
}
