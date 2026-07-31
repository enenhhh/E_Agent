import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parsePluginManifest } from '@e-agent/plugin-sdk';
import { renderPromptTemplate, SkillRegistry } from '@e-agent/skills';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const definitions = [
  'architect',
  'browser-research',
  'bug-fix',
  'computer-operator',
  'db-helper',
  'deploy',
  'doc-gen',
  'explain',
  'refactor',
  'security-audit',
  'test-gen',
];

describe('built-in skill package', () => {
  it('清单声明十一个唯一命令和十一个 Skill', async () => {
    const manifest = parsePluginManifest(
      JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as unknown,
    );
    expect(manifest.contributes.commands).toHaveLength(11);
    expect(manifest.contributes.skills).toHaveLength(11);
    expect(new Set(manifest.contributes.commands?.map((command) => command.id)).size).toBe(11);
  });

  it.each(definitions)('加载 %s 的双语 Prompt 和严格定义', async (name) => {
    const registry = new SkillRegistry();
    const registered = await registry.load(resolve(root, 'skills', name, 'skill.json'));
    expect(registered.definition.command).toBe(`@${name}`);
    expect(registered.definition.executor?.pluginId).toBe('com.eagent.builtin-skills');
    expect(registered.definition.variables.some((variable) => variable.required)).toBe(true);
    const variables = Object.fromEntries(
      registered.definition.variables.map((variable) => [variable.name, 'fixture']),
    );
    for (const promptPath of Object.values(registered.definition.prompts)) {
      const template = await readFile(resolve(registered.root, promptPath), 'utf8');
      const rendered = renderPromptTemplate(template, variables);
      expect(rendered).not.toContain('{{');
      expect(rendered.length).toBeGreaterThan(300);
    }
  });
});
