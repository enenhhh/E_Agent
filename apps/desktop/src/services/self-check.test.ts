import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseMajorVersion, runSelfCheck } from './self-check.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('parseMajorVersion', () => {
  it('解析普通和 v 前缀版本', () => {
    expect(parseMajorVersion('22.5.1')).toBe(22);
    expect(parseMajorVersion('v24.0.0')).toBe(24);
  });

  it('对无效版本返回零', () => {
    expect(parseMajorVersion('unknown')).toBe(0);
    expect(parseMajorVersion('1.5.0')).toBe(1);
  });

  it('报告可写数据目录、插件宿主和运行时状态', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-self-check-'));
    directories.push(directory);
    const pluginHostPath = join(directory, 'plugin-host.js');
    await writeFile(pluginHostPath, 'export {};');

    const report = await runSelfCheck({
      userDataDirectory: join(directory, 'data'),
      pluginHostPath,
      minimumNodeMajor: 1,
    });

    expect(report.healthy).toBe(true);
    expect(report.checkedAt).toEqual(expect.any(String));
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node', status: 'ok' }),
        expect.objectContaining({ id: 'user-data', status: 'ok' }),
        expect.objectContaining({ id: 'plugin-host', status: 'ok' }),
        expect.objectContaining({ id: 'python', status: expect.stringMatching(/^(ok|warning)$/u) }),
      ]),
    );
  });

  it('把过旧运行时、不可写目录和缺失宿主标记为错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-self-check-errors-'));
    directories.push(directory);
    const blockingFile = join(directory, 'not-a-directory');
    await writeFile(blockingFile, 'blocked');

    const report = await runSelfCheck({
      userDataDirectory: blockingFile,
      pluginHostPath: join(directory, 'missing-plugin-host.js'),
      minimumNodeMajor: 999,
    });

    expect(report.healthy).toBe(false);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node', status: 'error' }),
        expect.objectContaining({ id: 'user-data', status: 'error' }),
        expect.objectContaining({ id: 'plugin-host', status: 'error' }),
      ]),
    );
  });
});
