import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue } from '@e-agent/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostState = vi.hoisted(() => ({
  starts: [] as string[],
  stops: [] as string[],
  invocations: [] as Array<{
    pluginId: string;
    target: 'command' | 'hook' | 'provider';
    id: string;
    input: JsonValue;
  }>,
  failStarts: new Set<string>(),
  failStops: new Set<string>(),
}));

vi.mock('../src/host-client.js', () => ({
  PluginHostClient: class {
    private readonly pluginId: string;

    public constructor(options: unknown) {
      this.pluginId = (options as { manifest: { id: string } }).manifest.id;
    }

    public async start(): Promise<void> {
      hostState.starts.push(this.pluginId);
      if (hostState.failStarts.has(this.pluginId)) {
        throw new Error(`failed to start ${this.pluginId}`);
      }
    }

    public async stop(): Promise<void> {
      hostState.stops.push(this.pluginId);
      if (hostState.failStops.has(this.pluginId)) {
        throw new Error(`failed to stop ${this.pluginId}`);
      }
    }

    public async invoke(
      target: 'command' | 'hook' | 'provider',
      id: string,
      input: JsonValue,
    ): Promise<JsonValue> {
      hostState.invocations.push({ pluginId: this.pluginId, target, id, input });
      return { pluginId: this.pluginId, target, id, input };
    }
  },
}));

import { PluginRuntime } from '../src/runtime.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPlugin(
  root: string,
  version = '1.0.0',
  workspacePermission = false,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'com.eagent.runtime-fixture',
      name: 'Runtime fixture',
      version,
      description: 'Runtime lifecycle fixture',
      publisher: 'E Agent',
      entry: 'index.js',
      engines: { eAgent: '>=0.1.0' },
      types: ['hook', 'provider', 'tool'],
      permissions: workspacePermission
        ? {
            fileSystem: {
              read: ['${workspace}/**'],
              write: [],
            },
          }
        : {},
      contributes: {
        commands: [{ id: 'com.eagent.runtime-fixture.command', title: 'Command' }],
        hooks: ['request:before'],
        providers: [
          {
            id: 'com.eagent.runtime-fixture.provider',
            displayName: 'Fixture provider',
          },
        ],
        skills: [
          {
            id: 'com.eagent.runtime-fixture.skill',
            definition: 'skill.json',
          },
        ],
      },
    }),
  );
  await writeFile(join(root, 'index.js'), 'export const activate = () => undefined;');
  await writeFile(join(root, 'skill.json'), '{}');
}

async function setup(developmentMode = false, workspacePermission = false) {
  const root = await temporaryDirectory('e-agent-runtime-');
  const source = join(root, 'source');
  const workspaceRoot = join(root, 'workspace');
  await Promise.all([createPlugin(source, '1.0.0', workspacePermission), mkdir(workspaceRoot)]);
  const options = {
    pluginsDirectory: join(root, 'plugins'),
    dataDirectory: join(root, 'data'),
    hostEntryPath: join(root, 'host.js'),
    developmentMode,
    ...(workspacePermission ? { workspaceRoot } : {}),
  };
  return { root, source, workspaceRoot, options };
}

beforeEach(() => {
  hostState.starts.length = 0;
  hostState.stops.length = 0;
  hostState.invocations.length = 0;
  hostState.failStarts.clear();
  hostState.failStops.clear();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PluginRuntime', () => {
  it('coordinates install, approval, enable, invocation and uninstall', async () => {
    const fixture = await setup();
    const runtime = new PluginRuntime(fixture.options);
    const installed = await runtime.install({ type: 'directory', path: fixture.source });
    expect(installed).toMatchObject({
      enabled: false,
      approved: false,
      manifest: { id: 'com.eagent.runtime-fixture' },
    });
    expect(await runtime.getPluginRoot('com.eagent.runtime-fixture')).toContain(
      'com.eagent.runtime-fixture',
    );

    await runtime.approve('com.eagent.runtime-fixture');
    expect(await runtime.list()).toEqual([
      expect.objectContaining({ enabled: false, approved: true }),
    ]);
    await runtime.enable('com.eagent.runtime-fixture');
    await runtime.enable('com.eagent.runtime-fixture');
    expect(hostState.starts).toEqual(['com.eagent.runtime-fixture']);

    await expect(
      runtime.invoke(
        'com.eagent.runtime-fixture',
        'command',
        'com.eagent.runtime-fixture.command',
        { value: 1 },
      ),
    ).resolves.toMatchObject({
      pluginId: 'com.eagent.runtime-fixture',
      target: 'command',
    });

    await runtime.setWorkspaceRoot(join(fixture.root, 'workspace'));
    await runtime.setWorkspaceRoot(undefined);
    expect(hostState.starts).toHaveLength(1);
    expect(hostState.stops).toHaveLength(0);

    await runtime.setSkillEnabled('com.eagent.runtime-fixture.skill', false);
    expect(runtime.isSkillEnabled('com.eagent.runtime-fixture.skill')).toBe(false);
    await runtime.setSkillEnabled('com.eagent.runtime-fixture.skill', true);
    expect(runtime.isSkillEnabled('com.eagent.runtime-fixture.skill')).toBe(true);

    await runtime.revoke('com.eagent.runtime-fixture');
    expect((await runtime.list())[0]?.approved).toBe(false);
    const trashPath = await runtime.uninstall('com.eagent.runtime-fixture');
    expect(trashPath).toContain('.trash');
    expect(await runtime.list()).toEqual([]);
    await runtime.shutdown();
  });

  it('atomically revokes and disables workspace-scoped plugins when the root changes', async () => {
    const fixture = await setup(false, true);
    const runtime = new PluginRuntime(fixture.options);
    await runtime.install({ type: 'directory', path: fixture.source });
    await runtime.approve('com.eagent.runtime-fixture');
    await runtime.enable('com.eagent.runtime-fixture');
    expect((await runtime.list())[0]).toMatchObject({
      approved: true,
      enabled: true,
    });

    const nextWorkspace = join(fixture.root, 'next-workspace');
    await mkdir(nextWorkspace);
    await runtime.setWorkspaceRoot(nextWorkspace);

    expect((await runtime.list())[0]).toMatchObject({
      approved: false,
      enabled: false,
    });
    expect(hostState.starts).toEqual(['com.eagent.runtime-fixture']);
    expect(hostState.stops).toEqual(['com.eagent.runtime-fixture']);
    expect(
      JSON.parse(await readFile(join(fixture.options.dataDirectory, 'plugin-state.json'), 'utf8')),
    ).toMatchObject({ enabled: [] });

    await runtime.approve('com.eagent.runtime-fixture');
    await runtime.enable('com.eagent.runtime-fixture');
    expect((await runtime.list())[0]).toMatchObject({
      approved: true,
      enabled: true,
    });
    await runtime.shutdown();
  }, 15_000);

  it('keeps stale workspace-scoped plugins disabled after a root change between launches', async () => {
    const fixture = await setup(false, true);
    const first = new PluginRuntime(fixture.options);
    await first.install({ type: 'directory', path: fixture.source });
    await first.approve('com.eagent.runtime-fixture');
    await first.enable('com.eagent.runtime-fixture');
    await first.shutdown();

    const nextWorkspace = join(fixture.root, 'restored-workspace');
    await mkdir(nextWorkspace);
    hostState.starts.length = 0;
    const log = vi.fn();
    const restored = new PluginRuntime({
      ...fixture.options,
      workspaceRoot: nextWorkspace,
      log,
    });
    await restored.initialize();

    expect(hostState.starts).toEqual([]);
    expect((await restored.list())[0]).toMatchObject({
      approved: false,
      enabled: false,
    });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({ pluginId: 'com.eagent.runtime-fixture' }),
    );
    await restored.shutdown();
  });

  it('remains revoked and disabled when a workspace-scoped host fails to stop', async () => {
    const fixture = await setup(false, true);
    const runtime = new PluginRuntime(fixture.options);
    await runtime.install({ type: 'directory', path: fixture.source });
    await runtime.approve('com.eagent.runtime-fixture');
    await runtime.enable('com.eagent.runtime-fixture');
    hostState.failStops.add('com.eagent.runtime-fixture');
    const nextWorkspace = join(fixture.root, 'failed-stop-workspace');
    await mkdir(nextWorkspace);

    await expect(runtime.setWorkspaceRoot(nextWorkspace)).rejects.toMatchObject({
      code: 'HOST_CRASHED',
    });
    expect((await runtime.list())[0]).toMatchObject({
      approved: false,
      enabled: false,
    });
    expect(
      JSON.parse(await readFile(join(fixture.options.dataDirectory, 'plugin-state.json'), 'utf8')),
    ).toMatchObject({ enabled: [] });
    await runtime.shutdown();
  });

  it('persists enabled plugins and disabled skills across initialization', async () => {
    const fixture = await setup();
    const first = new PluginRuntime(fixture.options);
    await first.install({ type: 'directory', path: fixture.source });
    await first.enable('com.eagent.runtime-fixture');
    await first.setSkillEnabled('com.eagent.runtime-fixture.skill', false);
    await first.shutdown();

    hostState.starts.length = 0;
    const restored = new PluginRuntime(fixture.options);
    await restored.initialize();
    await restored.initialize();

    expect(hostState.starts).toEqual(['com.eagent.runtime-fixture']);
    expect(restored.isSkillEnabled('com.eagent.runtime-fixture.skill')).toBe(false);
    expect((await restored.list())[0]?.enabled).toBe(true);
    await restored.disable('com.eagent.runtime-fixture');
    await restored.shutdown();
  });

  it('logs invalid state and safely falls back to disabled defaults', async () => {
    const fixture = await setup();
    await mkdir(fixture.options.dataDirectory, { recursive: true });
    await writeFile(join(fixture.options.dataDirectory, 'plugin-state.json'), '{invalid');
    const log = vi.fn();
    const runtime = new PluginRuntime({ ...fixture.options, log });

    await runtime.initialize();

    expect(log).toHaveBeenCalledWith('warn', expect.any(String));
    expect(await runtime.list()).toEqual([]);
    await runtime.shutdown();
  });

  it('isolates a persisted plugin startup failure and continues initialization', async () => {
    const fixture = await setup();
    await mkdir(fixture.options.dataDirectory, { recursive: true });
    await writeFile(
      join(fixture.options.dataDirectory, 'plugin-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: ['com.eagent.missing'],
        disabledSkills: [],
      }),
    );
    const log = vi.fn();
    const runtime = new PluginRuntime({ ...fixture.options, log });

    await runtime.initialize();

    expect(log).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.objectContaining({ pluginId: 'com.eagent.missing' }),
    );
    await runtime.shutdown();
  });

  it('rejects missing plugins, skills and disabled invocations', async () => {
    const fixture = await setup();
    const runtime = new PluginRuntime(fixture.options);

    await expect(runtime.getPluginRoot('com.eagent.missing')).rejects.toMatchObject({
      code: 'PLUGIN_NOT_FOUND',
    });
    await expect(runtime.setSkillEnabled('com.eagent.missing.skill', false)).rejects.toMatchObject({
      code: 'PLUGIN_NOT_FOUND',
    });
    await expect(
      runtime.invoke('com.eagent.missing', 'hook', 'request:before', null),
    ).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    await runtime.disable('com.eagent.missing');
    await runtime.shutdown();
  });

  it('closes development watchers and isolates host stop failures during shutdown', async () => {
    const fixture = await setup(true);
    const runtime = new PluginRuntime(fixture.options);
    await runtime.install({ type: 'directory', path: fixture.source });
    await runtime.enable('com.eagent.runtime-fixture');
    hostState.failStops.add('com.eagent.runtime-fixture');

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(hostState.stops).toEqual(['com.eagent.runtime-fixture']);
  });
});
