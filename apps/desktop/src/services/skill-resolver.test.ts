import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopSkillResolver } from './skill-resolver.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DesktopSkillResolver', () => {
  it('渲染已启用插件 Skill 并注入确定性前置结果', async () => {
    const pluginsDirectory = await mkdtemp(join(tmpdir(), 'e-agent-skills-'));
    directories.push(pluginsDirectory);
    const root = join(pluginsDirectory, 'com.example.review');
    await mkdir(join(root, 'prompts'), { recursive: true });
    await writeFile(
      join(root, 'skill.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'com.example.review',
        command: '@review',
        name: { 'zh-CN': '审查', 'en-US': 'Review' },
        version: '1.0.0',
        description: { 'zh-CN': '审查代码', 'en-US': 'Review code' },
        prompts: {
          'zh-CN': 'prompts/zh.md',
          'en-US': 'prompts/en.md',
        },
        executor: {
          pluginId: 'com.example.review',
          commandId: 'com.example.review.run',
        },
        variables: [
          {
            name: 'filePath',
            description: '文件路径',
            required: false,
            maximumLength: 1_024,
          },
          {
            name: 'code',
            description: '代码',
            required: true,
            maximumLength: 1_000_000,
          },
        ],
        output: 'json',
        timeoutMs: 60_000,
      }),
      'utf8',
    );
    await writeFile(join(root, 'prompts', 'zh.md'), '文件={{filePath}}\n代码={{code}}', 'utf8');
    await writeFile(join(root, 'prompts', 'en.md'), 'File={{filePath}}\nCode={{code}}', 'utf8');
    const invoke = vi.fn(async () => ({
      staticAnalysis: { riskScore: 10 },
      recommendedVerdict: 'comment',
    }));
    const plugins = {
      list: vi.fn(async () => [
        {
          root,
          enabled: true,
          approved: true,
          integrity: 'hash',
          manifest: {
            id: 'com.example.review',
            name: 'Review',
            version: '1.0.0',
            description: 'Review',
            publisher: 'Example',
            entry: 'index.js',
            engines: { eAgent: '>=0.1.0' },
            types: ['tool'],
            permissions: {},
            contributes: {
              skills: [
                {
                  id: 'com.example.review',
                  definition: 'skill.json',
                },
              ],
            },
            schemaVersion: 1,
          },
        },
      ]),
      getPluginRoot: vi.fn(async () => root),
      isSkillEnabled: vi.fn(() => true),
      invoke,
    };
    const resolver = new DesktopSkillResolver({
      pluginsDirectory,
      plugins: plugins as never,
      locale: 'zh-CN',
    });
    const prompt = await resolver.resolve({
      command: '@review',
      userContent: '请检查',
      contextMessages: ['const value = 1;'],
      contextMentions: ['@file:src/main.ts'],
    });

    expect(prompt).toContain('文件=src/main.ts');
    expect(prompt).toContain('const value = 1');
    expect(prompt).toContain('"riskScore":10');
    expect(invoke).toHaveBeenCalledWith(
      'com.example.review',
      'command',
      'com.example.review.run',
      expect.objectContaining({ filePath: 'src/main.ts' }),
    );
  });

  it.each([
    ['@doc-gen', 'docStyle', 'auto'],
    ['@test-gen', 'testFramework', 'auto'],
    ['@db-helper', 'request', '请处理这个输入'],
    ['@deploy', 'target', 'all'],
    ['@explain', 'detailLevel', 'standard'],
  ])('为内置 Skill %s 构造完整模板变量', async (command, field, expected) => {
    const root = fileURLToPath(new URL('../../../../plugins/builtin-skills/', import.meta.url));
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown;
    const invoke = vi.fn(async () => ({
      staticAnalysis: { kind: command.slice(1) },
      markdown: 'static result',
    }));
    const plugins = {
      list: vi.fn(async () => [
        {
          root,
          enabled: true,
          approved: true,
          integrity: 'builtin-integrity',
          manifest,
        },
      ]),
      getPluginRoot: vi.fn(async () => root),
      isSkillEnabled: vi.fn(() => true),
      invoke,
    };
    const resolver = new DesktopSkillResolver({
      pluginsDirectory: root,
      plugins: plugins as never,
      locale: 'zh-CN',
    });
    const prompt = await resolver.resolve({
      command,
      userContent: '请处理这个输入',
      contextMessages: ['const selected = true;'],
      contextMentions: ['@file:src/input.ts'],
    });

    expect(prompt.length).toBeGreaterThan(20);
    expect(invoke).toHaveBeenCalledWith(
      'com.eagent.builtin-skills',
      'command',
      `eagent.${command.slice(1)}`,
      expect.objectContaining({ [field]: expected }),
    );
  });
});
