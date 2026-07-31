import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePluginManifest, type HostEvent } from '@e-agent/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityBroker, PermissionStore } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function setup(options: { notifications?: boolean; provideNotify?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e-agent-broker-extended-'));
  temporaryDirectories.push(root);
  const pluginRoot = join(root, 'plugin');
  const pluginDataRoot = join(root, 'data');
  const workspaceRoot = join(root, 'workspace');
  await Promise.all([
    mkdir(join(pluginRoot, 'nested'), { recursive: true }),
    mkdir(pluginDataRoot, { recursive: true }),
    mkdir(join(workspaceRoot, 'folder'), { recursive: true }),
  ]);
  await writeFile(join(pluginRoot, 'plugin.txt'), 'plugin');
  await writeFile(join(workspaceRoot, 'workspace.txt'), 'workspace');
  await writeFile(join(workspaceRoot, 'folder', 'nested.txt'), 'nested');
  const manifest = parsePluginManifest({
    schemaVersion: 1,
    id: 'com.eagent.extended-broker',
    name: 'Extended broker',
    version: '1.0.0',
    description: 'Extended capability tests',
    publisher: 'E Agent',
    entry: 'index.js',
    engines: { eAgent: '>=0.1.0' },
    types: ['tool'],
    permissions: {
      network: {
        hosts: ['api.example.com', '*.example.org', 'localhost:3000'],
      },
      fileSystem: {
        read: [
          '${pluginData}',
          '${pluginData}/**',
          '${plugin}',
          '${plugin}/nested/**',
          '${workspace}',
          '${workspace}/folder/**',
          '${unknown}/**',
        ],
        write: ['${pluginData}/**'],
      },
      env: ['SAFE_VALUE'],
      notifications: options.notifications ?? true,
    },
    contributes: {},
  });
  const permissionStore = new PermissionStore(join(root, 'permissions.json'));
  await permissionStore.approve(manifest, workspaceRoot);
  const notify = vi.fn(async () => undefined);
  const fetchImplementation = vi.fn<typeof fetch>(async () => new Response('ok'));
  const broker = new CapabilityBroker({
    manifest,
    pluginRoot,
    pluginDataRoot,
    workspaceRoot,
    permissionStore,
    fetchImplementation,
    ...(options.provideNotify === false ? {} : { notify }),
  });
  return {
    root,
    pluginRoot,
    pluginDataRoot,
    workspaceRoot,
    manifest,
    permissionStore,
    notify,
    fetchImplementation,
    broker,
  };
}

function capability(
  name: Extract<HostEvent, { type: 'capability-request' }>['capability'],
  input: unknown,
): Extract<HostEvent, { type: 'capability-request' }> {
  return {
    type: 'capability-request',
    capabilityRequestId: crypto.randomUUID(),
    capability: name,
    input,
  };
}

afterEach(async () => {
  delete process.env['SAFE_VALUE'];
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('CapabilityBroker security boundaries', () => {
  it('sanitizes headers and forwards explicitly allowed network request fields', async () => {
    const fixture = await setup();
    fixture.fetchImplementation.mockResolvedValueOnce(
      new Response('created', {
        status: 201,
        headers: { 'x-result': 'yes' },
      }),
    );

    await expect(
      fixture.broker.handle(
        capability('network.request', {
          url: 'https://api.example.com/items',
          method: 'POST',
          headers: {
            authorization: 'Bearer allowed-by-manifest',
            cookie: 'must-be-removed',
            host: 'must-be-removed',
            'content-length': '999',
            'x-plugin': 'safe',
          },
          body: '{}',
          timeoutMs: 100,
        }),
      ),
    ).resolves.toMatchObject({
      status: 201,
      headers: { 'x-result': 'yes' },
      body: 'created',
    });
    expect(fixture.fetchImplementation).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer allowed-by-manifest',
          'x-plugin': 'safe',
        },
        body: '{}',
      }),
    );
  });

  it.each(['https://child.example.org/resource', 'http://localhost:3000/health'])(
    'allows declared wildcard or localhost URL %s',
    async (url) => {
      const fixture = await setup();
      await expect(
        fixture.broker.handle(capability('network.request', { url })),
      ).resolves.toMatchObject({ status: 200, body: 'ok' });
    },
  );

  it.each([
    'http://api.example.com/insecure',
    'https://user:password@api.example.com/private',
    'https://example.org/wildcard-does-not-match-root',
    'http://localhost:3001/wrong-port',
  ])('denies unsafe or undeclared URL %s', async (url) => {
    const fixture = await setup();
    await expect(
      fixture.broker.handle(capability('network.request', { url })),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('enforces both declared and actual network response size limits', async () => {
    const fixture = await setup();
    const declaredCancel = vi.fn();
    const actualCancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000_000));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel: actualCancel,
    });
    fixture.fetchImplementation
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel: declaredCancel,
          }),
          {
            headers: { 'content-length': String(2_000_001) },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(oversizedBody));

    await expect(
      fixture.broker.handle(
        capability('network.request', { url: 'https://api.example.com/declared-large' }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(declaredCancel).toHaveBeenCalledOnce();
    await expect(
      fixture.broker.handle(
        capability('network.request', { url: 'https://api.example.com/actual-large' }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(actualCancel).toHaveBeenCalledOnce();
  });

  it('decodes split UTF-8 chunks and handles responses without a body', async () => {
    const fixture = await setup();
    const encoded = new TextEncoder().encode('分块🙂响应');
    fixture.fetchImplementation
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoded.slice(0, 2));
              controller.enqueue(encoded.slice(2, 7));
              controller.enqueue(encoded.slice(7));
              controller.close();
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      fixture.broker.handle(
        capability('network.request', { url: 'https://api.example.com/chunked' }),
      ),
    ).resolves.toMatchObject({ body: '分块🙂响应' });
    await expect(
      fixture.broker.handle(
        capability('network.request', { url: 'https://api.example.com/empty' }),
      ),
    ).resolves.toMatchObject({ status: 204, body: '' });
  });

  it('propagates response stream errors without replacing the root cause', async () => {
    const fixture = await setup();
    const failure = new Error('upstream stream failed');
    fixture.fetchImplementation.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(failure);
          },
        }),
      ),
    );

    await expect(
      fixture.broker.handle(
        capability('network.request', { url: 'https://api.example.com/broken-stream' }),
      ),
    ).rejects.toBe(failure);
  });

  it('reads, writes and lists only declared filesystem scopes', async () => {
    const fixture = await setup();

    await expect(
      fixture.broker.handle(
        capability('fileSystem.writeText', {
          path: 'new/deep/result.txt',
          content: 'result',
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fixture.broker.handle(
        capability('fileSystem.readText', {
          path: join(fixture.pluginDataRoot, 'new', 'deep', 'result.txt'),
        }),
      ),
    ).resolves.toBe('result');
    await expect(
      fixture.broker.handle(
        capability('fileSystem.readText', {
          path: join(fixture.pluginRoot, 'plugin.txt'),
        }),
      ),
    ).resolves.toBe('plugin');
    await expect(
      fixture.broker.handle(
        capability('fileSystem.readText', {
          path: join(fixture.workspaceRoot, 'folder', 'nested.txt'),
        }),
      ),
    ).resolves.toBe('nested');
    await expect(
      fixture.broker.handle(
        capability('fileSystem.list', { path: join(fixture.pluginDataRoot, 'new') }),
      ),
    ).resolves.toEqual(['directory:deep']);
  });

  it('rejects illegal paths, directories and oversized files', async () => {
    const fixture = await setup();
    const largePath = join(fixture.pluginDataRoot, 'large.txt');
    await writeFile(largePath, Buffer.alloc(10_000_001));

    await expect(
      fixture.broker.handle(
        capability('fileSystem.readText', { path: `${fixture.pluginDataRoot}\0escape` }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      fixture.broker.handle(capability('fileSystem.readText', { path: fixture.pluginDataRoot })),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      fixture.broker.handle(capability('fileSystem.readText', { path: largePath })),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('restricts environment access to declared names', async () => {
    const fixture = await setup();
    process.env['SAFE_VALUE'] = 'visible';

    await expect(
      fixture.broker.handle(capability('env.get', { name: 'SAFE_VALUE' })),
    ).resolves.toBe('visible');
    await expect(
      fixture.broker.handle(capability('env.get', { name: 'SECRET_VALUE' })),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('requires both manifest permission and a host notification adapter', async () => {
    const allowed = await setup();
    await expect(
      allowed.broker.handle(
        capability('notifications.show', { title: 'Finished', body: 'Task completed' }),
      ),
    ).resolves.toBeUndefined();
    expect(allowed.notify).toHaveBeenCalledWith('Finished', 'Task completed');

    const noAdapter = await setup({ provideNotify: false });
    await expect(
      noAdapter.broker.handle(
        capability('notifications.show', { title: 'Finished', body: 'Task completed' }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    const noPermission = await setup({ notifications: false });
    await expect(
      noPermission.broker.handle(
        capability('notifications.show', { title: 'Finished', body: 'Task completed' }),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('returns undefined for a future unknown capability without granting access', async () => {
    const fixture = await setup();
    const unknown = {
      type: 'capability-request',
      capabilityRequestId: 'future',
      capability: 'future.capability',
      input: null,
    } as unknown as Extract<HostEvent, { type: 'capability-request' }>;

    await expect(fixture.broker.handle(unknown)).resolves.toBeUndefined();
  });
});
