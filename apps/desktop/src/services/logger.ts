import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { redactSensitive, redactText } from '@e-agent/security';

type LogLevel = 'debug' | 'error' | 'info' | 'warn';
type LogFields = Readonly<Record<string, unknown>>;

/**
 * 写入按日轮转的 JSONL 日志，并自动删除七天前的文件。
 */
export class AppLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly directory: string,
    private readonly retentionDays = 7,
  ) {}

  /**
   * 初始化日志目录并清理过期文件。
   */
  public async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.prune();
  }

  /**
   * 记录 debug 日志。
   */
  public debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  /**
   * 记录 info 日志。
   */
  public info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  /**
   * 记录 warn 日志。
   */
  public warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  /**
   * 记录 error 日志。
   */
  public error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  /**
   * 等待当前日志队列写完，用于应用退出。
   */
  public async flush(): Promise<void> {
    await this.writeQueue;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      message: redactText(message).slice(0, 5_000),
      ...(fields === undefined ? {} : { fields: sanitize(redactSensitive(fields)) }),
    };
    const filePath = join(this.directory, `e-agent-${event.timestamp.slice(0, 10)}.jsonl`);
    this.writeQueue = this.writeQueue
      .then(() =>
        writeFile(filePath, `${JSON.stringify(event)}\n`, {
          encoding: 'utf8',
          flag: 'a',
          mode: 0o600,
        }),
      )
      .catch(() => {
        // 日志写入失败不能触发递归日志或终止应用。
      });
  }

  private async prune(): Promise<void> {
    const threshold = Date.now() - this.retentionDays * 24 * 60 * 60 * 1_000;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^e-agent-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
        continue;
      }
      const path = join(this.directory, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs < threshold) {
        await rm(path, { force: true });
      }
    }
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[截断]';
  }
  if (typeof value === 'string') {
    return value.slice(0, 5_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitize(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entryValue]) => [key, sanitize(entryValue, depth + 1)]),
    );
  }
  return value;
}
