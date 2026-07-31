import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePluginManifest } from '@e-agent/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityBroker } from '../src/capability-broker.js';
import { PermissionStore } from '../src/permission-store.js';

const temporaryDirectories: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'e-agent-broker-'));
  temporaryDirectories.push(root);
  const pluginRoot = join(root, 'plugin');
  const pluginDataRoot = join(root, 'data');
  await mkdir(pluginRoot);
  await mkdir(pluginDataRoot);
  const manifest = parsePluginManifest({
    schemaVersion: 1,
    id: 'com.eagent.broker',
    name: 'Broker',
    version: '1.0.0',
    description: '测试',
    publisher: 'E Agent',
    entry: 'index.js',
    engines: { eAgent: '>=0.1.0' },
    types: ['tool'],
    permissions: {
      network: { hosts: ['api.example.com'] },
      fileSystem: {
        read: ['${pluginData}/**'],
        write: ['${pluginData}/**'],
      },
    },
    contributes: {},
  });
  const store = new PermissionStore(join(root, 'permissions.json'));
  return { root, pluginRoot, pluginDataRoot, manifest, store };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('CapabilityBroker', () => {
  it('在用户批准前拒绝全部能力', async () => {
    const fixture = await setup();
    const broker = new CapabilityBroker({
      ...fixture,
      permissionStore: fixture.store,
    });
    await expect(
      broker.handle({
        type: 'capability-request',
        capabilityRequestId: '1',
        capability: 'fileSystem.list',
        input: { path: fixture.pluginDataRoot },
      }),
    ).rejects.toThrow(/尚未批准/);
  });

  it('只在已声明目录内写入文件', async () => {
    const fixture = await setup();
    await fixture.store.approve(fixture.manifest);
    const broker = new CapabilityBroker({
      ...fixture,
      permissionStore: fixture.store,
    });
    const path = join(fixture.pluginDataRoot, 'result.txt');
    await broker.handle({
      type: 'capability-request',
      capabilityRequestId: '1',
      capability: 'fileSystem.writeText',
      input: { path, content: 'ok' },
    });
    expect(await readFile(path, 'utf8')).toBe('ok');
    await expect(
      broker.handle({
        type: 'capability-request',
        capabilityRequestId: '2',
        capability: 'fileSystem.writeText',
        input: { path: join(fixture.root, 'escape.txt'), content: 'no' },
      }),
    ).rejects.toThrow(/未获准/);
  });

  it('按主机白名单代理网络请求', async () => {
    const fixture = await setup();
    await fixture.store.approve(fixture.manifest);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const broker = new CapabilityBroker({
      ...fixture,
      permissionStore: fixture.store,
      fetchImplementation,
    });
    const result = await broker.handle({
      type: 'capability-request',
      capabilityRequestId: '1',
      capability: 'network.request',
      input: { url: 'https://api.example.com/v1/models' },
    });
    expect(result).toMatchObject({ status: 200, body: 'ok' });
    await expect(
      broker.handle({
        type: 'capability-request',
        capabilityRequestId: '2',
        capability: 'network.request',
        input: { url: 'https://evil.example/v1' },
      }),
    ).rejects.toThrow(/未获准/);
  });
});
