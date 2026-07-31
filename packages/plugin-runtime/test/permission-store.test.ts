import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePluginManifest } from '@e-agent/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { PermissionStore, permissionDigest } from '../src/permission-store.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-permissions-'));
  temporaryDirectories.push(directory);
  return directory;
}

function manifest(version = '1.0.0', hosts = ['api.example.com'], id = 'com.eagent.test') {
  return parsePluginManifest({
    schemaVersion: 1,
    id,
    name: 'Test',
    version,
    description: '测试',
    publisher: 'E Agent',
    entry: 'index.js',
    engines: { eAgent: '>=0.1.0' },
    types: ['tool'],
    permissions: { network: { hosts } },
    contributes: {},
  });
}

function workspaceManifest(id = 'com.eagent.workspace-test') {
  return parsePluginManifest({
    schemaVersion: 1,
    id,
    name: 'Workspace test',
    version: '1.0.0',
    description: '工作区授权测试',
    publisher: 'E Agent',
    entry: 'index.js',
    engines: { eAgent: '>=0.1.0' },
    types: ['tool'],
    permissions: {
      fileSystem: {
        read: ['${workspace}/src/**'],
        write: ['${workspace}/generated/**'],
      },
    },
    contributes: {},
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PermissionStore', () => {
  it('默认拒绝，并在明确批准后允许完全相同的权限', async () => {
    const directory = await createTemporaryDirectory();
    const store = new PermissionStore(join(directory, 'permissions.json'));
    expect(await store.isApproved(manifest())).toBe(false);
    await store.approve(manifest());
    expect(await store.isApproved(manifest())).toBe(true);
  });

  it('版本或权限发生变化后使旧批准失效', async () => {
    const directory = await createTemporaryDirectory();
    const store = new PermissionStore(join(directory, 'permissions.json'));
    await store.approve(manifest());
    expect(await store.isApproved(manifest('1.0.1'))).toBe(false);
    expect(await store.isApproved(manifest('1.0.0', ['other.example.com']))).toBe(false);
  });

  it('使用私有权限写入原子 JSON 文件', async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, 'permissions.json');
    const store = new PermissionStore(path);
    await store.approve(manifest());
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it('将 workspace 授权绑定到规范化根目录的摘要且不落盘明文路径', async () => {
    const directory = await createTemporaryDirectory();
    const firstWorkspace = join(directory, 'first-workspace');
    const secondWorkspace = join(directory, 'second-workspace');
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const path = join(directory, 'permissions.json');
    const store = new PermissionStore(path);
    const plugin = workspaceManifest();

    await expect(store.approve(plugin)).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    await store.approve(plugin, join(firstWorkspace, 'nested', '..'));

    expect(await store.isApproved(plugin, firstWorkspace)).toBe(true);
    expect(await store.isApproved(plugin, secondWorkspace)).toBe(false);
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(firstWorkspace);
    expect(persisted).not.toContain(secondWorkspace);
    expect(JSON.parse(persisted)).toMatchObject({
      approvals: [
        {
          workspaceBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
  });

  it('拒绝沿用没有 workspace 绑定的旧版批准记录', async () => {
    const directory = await createTemporaryDirectory();
    const workspaceRoot = join(directory, 'workspace');
    await mkdir(workspaceRoot);
    const plugin = workspaceManifest();
    const path = join(directory, 'permissions.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        approvals: [
          {
            pluginId: plugin.id,
            version: plugin.version,
            permissionDigest: permissionDigest(plugin),
            approvedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const store = new PermissionStore(path);
    expect(await store.isApproved(plugin, workspaceRoot)).toBe(false);
  });

  it('在一次持久化中批量撤销多个插件', async () => {
    const directory = await createTemporaryDirectory();
    const store = new PermissionStore(join(directory, 'permissions.json'));
    const first = manifest('1.0.0', ['first.example.com'], 'com.eagent.first');
    const second = manifest('1.0.0', ['second.example.com'], 'com.eagent.second');
    await Promise.all([store.approve(first), store.approve(second)]);

    await store.revokeMany([first.id, second.id, first.id]);

    expect(await store.isApproved(first)).toBe(false);
    expect(await store.isApproved(second)).toBe(false);
  });
});
