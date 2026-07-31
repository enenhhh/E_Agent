import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DesktopFileChangeCoordinator } from './file-change-coordinator.js';
import type { DesktopFileHookName, DesktopFileHookPayloadMap } from './plugin-hook-runner.js';
import { DesktopSecretStore } from './secret-store.js';
import { WorkspaceService } from './workspace.js';

const directories: string[] = [];
const conversationId = '00000000-0000-4000-8000-000000000010';

async function fixture(fileHookRunner?: {
  run<Name extends DesktopFileHookName>(
    name: Name,
    payload: DesktopFileHookPayloadMap[Name],
  ): Promise<void>;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-file-change-'));
  directories.push(directory);
  const root = join(directory, 'workspace');
  await mkdir(root);
  const stateFile = join(directory, 'workspace-binding.json');
  const workspace = new WorkspaceService({ stateFile });
  await workspace.bind(root);
  const secrets = new DesktopSecretStore({
    directory: join(directory, 'secrets'),
    developmentMode: false,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`safe:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').slice(5),
    },
  });
  const coordinator = new DesktopFileChangeCoordinator({
    workspace,
    secrets,
    ...(fileHookRunner === undefined ? {} : { fileHookRunner }),
  });
  await coordinator.initialize();
  return { directory, root, stateFile, workspace, secrets, coordinator };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DesktopFileChangeCoordinator', () => {
  it('完整审批后安全创建新文件', async () => {
    const current = await fixture();
    const proposal = await current.workspace.proposeWrite(
      'src/new.ts',
      'export const ok = true;\n',
    );
    const changeId = '00000000-0000-4000-8000-000000000001';
    await current.coordinator.register({
      changeId,
      conversationId,
      proposal,
      requestedContent: 'export const ok = true;\n',
    });
    await current.coordinator.prepareAccept(changeId, conversationId);
    await current.coordinator.complete(changeId, conversationId);
    expect(await readFile(join(current.root, 'src/new.ts'), 'utf8')).toBe(
      'export const ok = true;\n',
    );
  });

  it('应用重启后从加密映射恢复提案并写入', async () => {
    const current = await fixture();
    await writeFile(join(current.root, 'file.ts'), 'before\n');
    const proposal = await current.workspace.proposeWrite('file.ts', 'after\n');
    const changeId = '00000000-0000-4000-8000-000000000002';
    await current.coordinator.register({
      changeId,
      conversationId,
      proposal,
      requestedContent: 'after\n',
    });

    const restartedWorkspace = new WorkspaceService({ stateFile: current.stateFile });
    await restartedWorkspace.initialize();
    const restarted = new DesktopFileChangeCoordinator({
      workspace: restartedWorkspace,
      secrets: current.secrets,
    });
    await restarted.initialize();
    await restarted.prepareAccept(changeId, conversationId);
    await restarted.complete(changeId, conversationId);
    expect(await readFile(join(current.root, 'file.ts'), 'utf8')).toBe('after\n');
  });

  it('并发审批期间检测外部哈希冲突且绝不覆盖', async () => {
    const current = await fixture();
    const path = join(current.root, 'conflict.ts');
    await writeFile(path, 'before\n');
    const proposal = await current.workspace.proposeWrite('conflict.ts', 'after\n');
    const changeId = '00000000-0000-4000-8000-000000000003';
    await current.coordinator.register({
      changeId,
      conversationId,
      proposal,
      requestedContent: 'after\n',
    });
    await writeFile(path, 'external\n');
    const results = await Promise.allSettled([
      current.coordinator.prepareAccept(changeId, conversationId),
      current.coordinator.prepareAccept(changeId, conversationId),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('external\n');
  });

  it('映射缺失时 fail closed', async () => {
    const current = await fixture();
    await expect(
      current.coordinator.prepareAccept('00000000-0000-4000-8000-000000000004', conversationId),
    ).rejects.toMatchObject({ code: 'FILE_CHANGE_MAPPING_MISSING' });
  });

  it('实际写盘前后触发脱敏的插件生命周期元数据', async () => {
    const events: Array<{
      name: DesktopFileHookName;
      payload: DesktopFileHookPayloadMap[DesktopFileHookName];
    }> = [];
    const current = await fixture({
      async run<Name extends DesktopFileHookName>(
        name: Name,
        payload: DesktopFileHookPayloadMap[Name],
      ) {
        events.push({ name, payload });
      },
    });
    const proposal = await current.workspace.proposeWrite(
      'src/hooked.ts',
      'export const hooked = true;\n',
    );
    const changeId = '00000000-0000-4000-8000-000000000005';
    await current.coordinator.register({
      changeId,
      conversationId,
      proposal,
      requestedContent: 'export const hooked = true;\n',
    });

    await current.coordinator.prepareAccept(changeId, conversationId, {
      id: '00000000-0000-4000-8000-000000000006',
      role: 'owner',
    });

    expect(events.map((event) => event.name)).toEqual(['file:before-save', 'file:after-save']);
    expect(events[0]?.payload).toMatchObject({
      requestId: changeId,
      actor: { role: 'owner' },
      file: {
        relativePath: 'src/hooked.ts',
        byteLength: Buffer.byteLength('export const hooked = true;\n'),
        changeId,
      },
    });
    expect(events[1]?.payload).toMatchObject({
      outcome: { success: true, errorCode: null },
    });
    expect(JSON.stringify(events)).not.toContain('export const hooked');
  });

  it('旧版 v1 映射缺少工作区身份时 fail closed 并迁移为空的 v2 状态', async () => {
    const current = await fixture();
    const legacyChangeId = '00000000-0000-4000-8000-000000000007';
    await current.secrets.writeJson('file-change-proposals', {
      version: 1,
      entries: [
        {
          changeId: legacyChangeId,
          conversationId,
          proposalId: '00000000-0000-4000-8000-000000000008',
          path: 'legacy.ts',
          requestedContent: 'must not be written\n',
          beforeHash: '0'.repeat(64),
          afterHash: '1'.repeat(64),
        },
      ],
    });

    const restarted = new DesktopFileChangeCoordinator({
      workspace: current.workspace,
      secrets: current.secrets,
    });
    await restarted.initialize();

    await expect(restarted.prepareAccept(legacyChangeId, conversationId)).rejects.toMatchObject({
      code: 'FILE_CHANGE_MAPPING_MISSING',
    });
    await expect(readFile(join(current.root, 'legacy.ts'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(current.secrets.readJson('file-change-proposals')).resolves.toEqual({
      version: 2,
      entries: [],
    });
  });
});
