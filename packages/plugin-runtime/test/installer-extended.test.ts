import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginInstaller } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-installer-extended-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPlugin(
  root: string,
  options: { version?: string; entryDirectory?: boolean; extraFiles?: number } = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'com.eagent.installer-extended',
      name: 'Installer extended',
      version: options.version ?? '1.0.0',
      description: 'Installer boundary fixture',
      publisher: 'E Agent',
      entry: 'index.js',
      engines: { eAgent: '>=0.1.0' },
      types: ['tool'],
      permissions: {},
      contributes: {},
    }),
  );
  if (options.entryDirectory === true) {
    await mkdir(join(root, 'index.js'));
  } else {
    await writeFile(
      join(root, 'index.js'),
      `export const version = '${options.version ?? '1.0.0'}';`,
    );
  }
  for (let index = 0; index < (options.extraFiles ?? 0); index += 1) {
    await writeFile(join(root, `extra-${index}.txt`), String(index));
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PluginInstaller boundary validation', () => {
  it('lists only valid visible plugin directories', async () => {
    const root = await temporaryDirectory();
    const pluginsDirectory = join(root, 'plugins');
    await createPlugin(join(pluginsDirectory, 'com.eagent.installer-extended'));
    await mkdir(join(pluginsDirectory, '.staging-hidden'), { recursive: true });
    await mkdir(join(pluginsDirectory, 'broken'), { recursive: true });
    await writeFile(join(pluginsDirectory, 'plain-file'), 'ignored');
    const installer = new PluginInstaller({ pluginsDirectory });

    const plugins = await installer.list();

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(['com.eagent.installer-extended']);
  });

  it('rejects a plugin entry that is not a regular file', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    await createPlugin(source, { entryDirectory: true });
    const installer = new PluginInstaller({ pluginsDirectory: join(root, 'plugins') });

    await expect(installer.inspect(source)).rejects.toMatchObject({
      code: 'INSTALL_INVALID',
    });
  });

  it.each([
    { maximumFiles: 1, maximumBytes: 1_000_000, extraFiles: 1 },
    { maximumFiles: 100, maximumBytes: 10, extraFiles: 0 },
  ])('enforces installation resource limits: %o', async (limits) => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    await createPlugin(source, { extraFiles: limits.extraFiles });
    const installer = new PluginInstaller({
      pluginsDirectory: join(root, 'plugins'),
      maximumFiles: limits.maximumFiles,
      maximumBytes: limits.maximumBytes,
    });

    await expect(installer.install({ type: 'directory', path: source })).rejects.toMatchObject({
      code: 'INSTALL_INVALID',
    });
  });

  it('rejects a source directory that contains the installation destination', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    await createPlugin(source);
    const installer = new PluginInstaller({ pluginsDirectory: join(source, 'plugins') });

    await expect(installer.install({ type: 'directory', path: source })).rejects.toMatchObject({
      code: 'INSTALL_INVALID',
    });
  });

  it('atomically replaces an existing plugin version', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    const pluginsDirectory = join(root, 'plugins');
    await createPlugin(source);
    const installer = new PluginInstaller({ pluginsDirectory });
    const first = await installer.install({ type: 'directory', path: source });

    await rm(source, { recursive: true, force: true });
    await createPlugin(source, { version: '2.0.0' });
    const replacement = await installer.install({ type: 'directory', path: source });

    expect(first.manifest.version).toBe('1.0.0');
    expect(replacement.manifest.version).toBe('2.0.0');
    expect((await installer.list())[0]?.manifest.version).toBe('2.0.0');
  });

  it('coalesces concurrent installs from the same source', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    await createPlugin(source);
    const installer = new PluginInstaller({ pluginsDirectory: join(root, 'plugins') });

    const [first, second] = await Promise.all([
      installer.install({ type: 'directory', path: source }),
      installer.install({ type: 'directory', path: source }),
    ]);

    expect(second).toEqual(first);
    expect(await installer.list()).toHaveLength(1);
  });

  it.each([
    'http://example.com/plugin.git',
    'https://user:password@example.com/plugin.git',
    'not a URL',
  ])('rejects unsafe Git source %s', async (url) => {
    const root = await temporaryDirectory();
    const installer = new PluginInstaller({ pluginsDirectory: join(root, 'plugins') });

    await expect(installer.install({ type: 'git', url })).rejects.toMatchObject({
      code: 'INSTALL_INVALID',
    });
  });

  it('rejects traversal in uninstall identifiers', async () => {
    const root = await temporaryDirectory();
    const installer = new PluginInstaller({ pluginsDirectory: join(root, 'plugins') });

    await expect(installer.uninstall('../escape')).rejects.toMatchObject({
      code: 'INSTALL_INVALID',
    });
  });

  it('ignores dependency, coverage and repository metadata directories', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    await createPlugin(source);
    for (const ignored of ['node_modules', 'coverage', '.git']) {
      await mkdir(join(source, ignored), { recursive: true });
      await writeFile(join(source, ignored, 'large.bin'), Buffer.alloc(1_000));
    }
    const installer = new PluginInstaller({
      pluginsDirectory: join(root, 'plugins'),
      maximumBytes: 900,
    });

    await expect(installer.install({ type: 'directory', path: source })).resolves.toMatchObject({
      manifest: { id: 'com.eagent.installer-extended' },
    });
  });
});
