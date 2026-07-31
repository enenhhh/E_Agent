import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PluginInstaller } from '../src/installer.js';
import { PluginRuntime } from '../src/runtime.js';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createPlugin(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'com.eagent.fixture',
      name: 'Fixture',
      version: '1.0.0',
      description: '测试插件',
      publisher: 'E Agent',
      entry: 'index.js',
      engines: { eAgent: '>=0.1.0' },
      types: ['tool'],
      permissions: {},
      contributes: {
        skills: [
          {
            id: 'com.eagent.fixture.skill',
            definition: 'skill.json',
          },
        ],
      },
    }),
  );
  await writeFile(join(root, 'index.js'), 'export const ok = true;');
  await writeFile(join(root, 'skill.json'), '{}');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PluginInstaller', () => {
  it('校验并原子安装本地插件', async () => {
    const directory = await createTemporaryDirectory('e-agent-installer-');
    const source = join(directory, 'source');
    const destination = join(directory, 'plugins');
    await createPlugin(source);
    const installer = new PluginInstaller({ pluginsDirectory: destination });
    const installed = await installer.install({ type: 'directory', path: source });
    expect(installed.manifest.id).toBe('com.eagent.fixture');
    expect(installed.integrity).toHaveLength(64);
  });

  it('拒绝包含符号链接的插件', async () => {
    const directory = await createTemporaryDirectory('e-agent-installer-');
    const source = join(directory, 'source');
    await createPlugin(source);
    await symlink(join(source, 'index.js'), join(source, 'link.js'));
    const installer = new PluginInstaller({
      pluginsDirectory: join(directory, 'plugins'),
    });
    await expect(installer.install({ type: 'directory', path: source })).rejects.toThrow(
      /符号链接/,
    );
  });

  it('卸载时移动到可恢复目录', async () => {
    const directory = await createTemporaryDirectory('e-agent-installer-');
    const source = join(directory, 'source');
    const destination = join(directory, 'plugins');
    await createPlugin(source);
    const installer = new PluginInstaller({ pluginsDirectory: destination });
    await installer.install({ type: 'directory', path: source });
    const trashPath = await installer.uninstall('com.eagent.fixture');
    expect(trashPath).toContain('.trash');
  });

  it('独立持久化 Skill 开关且不关闭整个插件', async () => {
    const directory = await createTemporaryDirectory('e-agent-runtime-skill-state-');
    const source = join(directory, 'source');
    const pluginsDirectory = join(directory, 'plugins');
    const dataDirectory = join(directory, 'data');
    await createPlugin(source);
    const options = {
      pluginsDirectory,
      dataDirectory,
      hostEntryPath: join(directory, 'missing-host.js'),
    };
    const runtime = new PluginRuntime(options);
    const installed = await runtime.install({ type: 'directory', path: source });
    expect(installed.manifest.id).toBe('com.eagent.fixture');
    expect(await runtime.getPluginRoot('com.eagent.fixture')).toContain('com.eagent.fixture');
    await runtime.setSkillEnabled('com.eagent.fixture.skill', false);
    expect(runtime.isSkillEnabled('com.eagent.fixture.skill')).toBe(false);
    expect((await runtime.list())[0]?.enabled).toBe(false);

    const restarted = new PluginRuntime(options);
    await restarted.initialize();
    expect(restarted.isSkillEnabled('com.eagent.fixture.skill')).toBe(false);
  });
});
