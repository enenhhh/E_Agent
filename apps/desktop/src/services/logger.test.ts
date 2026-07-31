import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AppLogger } from './logger.js';

const directories: string[] = [];
const shortOpenAiFixture = ['sk', '1234567890'].join('-');
const desktopProviderFixture = ['sk', 'provider-desktop-secret'].join('-');
const nestedDesktopProviderFixture = ['sk', 'nested-desktop-secret'].join('-');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('AppLogger', () => {
  it('分级写入 JSONL，并递归隐藏敏感字段和值', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-logger-'));
    directories.push(directory);
    const logger = new AppLogger(directory);
    await logger.initialize();

    const deeplyNested = { value: 'visible' } as Record<string, unknown>;
    let current = deeplyNested;
    for (let index = 0; index < 8; index += 1) {
      const next = { value: `level-${index}` };
      current['next'] = next;
      current = next;
    }
    const longArray = Array.from({ length: 105 }, (_, index) => `item-${index}`);
    logger.debug(`debug ${shortOpenAiFixture} gsk_abcdefghijklmnopqrstuvwxyz`, {
      apiKey: 'never-log',
      deeplyNested,
      provider: {
        credential: 'AIza0123456789abcdefghijklmn',
        nested: { refreshToken: 'refresh-token-must-not-leak' },
      },
    });
    logger.info('info Bearer abcdefghijklmnop', { ordinary: 'ok', longArray });
    logger.warn('warn', { password: 'hidden' });
    logger.error('error', { nested: { authorization: 'hidden', safe: 'shown' } });
    await logger.flush();

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const lines = (await readFile(join(directory, files[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line['level'])).toEqual(['debug', 'info', 'warn', 'error']);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(shortOpenAiFixture);
    expect(serialized).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('AIza0123456789abcdefghijklmn');
    expect(serialized).not.toContain('refresh-token-must-not-leak');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(serialized).not.toContain('never-log');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[截断]');
    expect(serialized).not.toContain('item-104');
  });

  it('整体屏蔽 ProviderError 与原始响应体内容并保留诊断元数据', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-provider-logger-'));
    directories.push(directory);
    const logger = new AppLogger(directory);
    await logger.initialize();

    logger.error('上游调用失败', {
      error: {
        name: 'ProviderError',
        code: 'PROVIDER_BAD_RESPONSE',
        status: 400,
        retryable: false,
        providerBody: {
          error: {
            message: 'D:\\private-project\\agent.ts 包含 tool-generated-secret',
          },
          apiKey: desktopProviderFixture,
        },
      },
      rawResponseBody: 'raw tool output: tool-generated-secret',
      response: {
        status: 502,
        body: {
          apiKey: nestedDesktopProviderFixture,
          content: 'private tool content',
        },
      },
    });
    await logger.flush();

    const [file] = await readdir(directory);
    const event = JSON.parse(await readFile(join(directory, file!), 'utf8')) as {
      fields: {
        error: Record<string, unknown>;
        rawResponseBody: unknown;
        response: Record<string, unknown>;
      };
    };
    expect(event.fields.error).toEqual({
      name: 'ProviderError',
      code: 'PROVIDER_BAD_RESPONSE',
      status: 400,
      retryable: false,
      providerBody: '[REDACTED]',
    });
    expect(event.fields.rawResponseBody).toBe('[REDACTED]');
    expect(event.fields.response).toEqual({ status: 502, body: '[REDACTED]' });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('private-project');
    expect(serialized).not.toContain('tool-generated-secret');
    expect(serialized).not.toContain(desktopProviderFixture);
    expect(serialized).not.toContain(nestedDesktopProviderFixture);
    expect(serialized).not.toContain('private tool content');
  });

  it('初始化时只清理超过保留期的规范日志文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-logger-prune-'));
    directories.push(directory);
    const stale = join(directory, 'e-agent-2000-01-01.jsonl');
    const unrelated = join(directory, 'notes.txt');
    const nested = join(directory, 'e-agent-2000-01-02.jsonl');
    await writeFile(stale, '{}\n');
    await writeFile(unrelated, 'keep');
    await mkdir(nested);
    const old = new Date('2000-01-01T00:00:00.000Z');
    await utimes(stale, old, old);

    await new AppLogger(directory, 1).initialize();

    await expect(readFile(stale, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep');
    expect((await readdir(directory)).includes('e-agent-2000-01-02.jsonl')).toBe(true);
  });

  it('日志写入失败不会破坏后续 flush', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-logger-failure-'));
    directories.push(directory);
    const logger = new AppLogger(directory);
    await logger.initialize();
    await rm(directory, { recursive: true, force: true });

    logger.info('directory removed');
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});
