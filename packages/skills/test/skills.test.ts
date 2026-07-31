import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue } from '@e-agent/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SkillOrchestrator } from '../src/orchestrator.js';
import { SkillRegistry } from '../src/registry.js';
import { parseWorkflowDefinition } from '../src/schema.js';
import { extractSkillCommands, renderPromptTemplate } from '../src/template.js';
import { WorkflowRegistry } from '../src/workflow-registry.js';

async function createSkill(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'prompt.zh.md'), '审查：{{code}}');
  await writeFile(join(root, 'prompt.en.md'), 'Review: {{code}}');
  const definitionPath = join(root, 'skill.json');
  await writeFile(
    definitionPath,
    JSON.stringify({
      schemaVersion: 1,
      id: 'com.eagent.review',
      command: '@code-review',
      name: { 'zh-CN': '代码审查', 'en-US': 'Code review' },
      version: '1.0.0',
      description: { 'zh-CN': '审查代码', 'en-US': 'Review code' },
      prompts: { 'zh-CN': 'prompt.zh.md', 'en-US': 'prompt.en.md' },
      variables: [
        {
          name: 'code',
          description: '代码',
          required: true,
          maximumLength: 1_000,
        },
      ],
      output: 'markdown',
      timeoutMs: 5_000,
    }),
  );
  return definitionPath;
}

describe('skills', () => {
  it('渲染 Prompt 并提取去重后的命令', () => {
    expect(renderPromptTemplate('Hi {{name}}', { name: 'E Agent' })).toBe('Hi E Agent');
    expect(extractSkillCommands('@code-review x @code-review')).toEqual(['@code-review']);
  });

  it('拒绝循环工作流', () => {
    expect(() =>
      parseWorkflowDefinition({
        schemaVersion: 1,
        id: 'com.eagent.workflow',
        name: '循环',
        steps: [
          { id: 'a', skillId: 'com.eagent.review', dependsOn: ['b'] },
          { id: 'b', skillId: 'com.eagent.review', dependsOn: ['a'] },
        ],
      }),
    ).toThrow(/循环/);
  });

  it('加载并执行单个 Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e-agent-skill-'));
    const registry = new SkillRegistry();
    await registry.load(await createSkill(root));
    const execute = vi
      .fn<(invocation: { prompt: string }) => Promise<JsonValue>>()
      .mockResolvedValue('完成');
    const orchestrator = new SkillOrchestrator(registry, {
      execute: (invocation) => execute(invocation),
    });
    await expect(
      orchestrator.runSkill('com.eagent.review', { code: 'const a = 1;' }),
    ).resolves.toBe('完成');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ prompt: '审查：const a = 1;' }));
  });

  it('注册、替换、排序和删除有效 Workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e-agent-workflow-registry-'));
    const skills = new SkillRegistry();
    await skills.load(await createSkill(root));
    const workflows = new WorkflowRegistry(skills);
    const definition = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.review',
      name: 'Review',
      steps: [
        {
          id: 'review',
          skillId: 'com.eagent.review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
      ],
    } as const;
    expect(workflows.register(definition)).toMatchObject({ id: definition.id });
    expect(() => workflows.register(definition)).toThrow(/已存在/);
    expect(workflows.upsert({ ...definition, name: 'Updated' }).name).toBe('Updated');
    expect(workflows.list()).toHaveLength(1);
    expect(workflows.delete(definition.id)).toBe(true);
    expect(workflows.delete(definition.id)).toBe(false);
  });

  it('在保存阶段拒绝未知 Skill、未知变量和缺失必填变量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e-agent-workflow-invalid-'));
    const skills = new SkillRegistry();
    await skills.load(await createSkill(root));
    const workflows = new WorkflowRegistry(skills);
    const base = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.invalid',
      name: 'Invalid',
      steps: [
        {
          id: 'review',
          skillId: 'com.eagent.review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
      ],
    };
    expect(() =>
      workflows.register({
        ...base,
        steps: [{ ...base.steps[0], skillId: 'com.eagent.missing' }],
      }),
    ).toThrow(/不存在的 Skill/);
    expect(() =>
      workflows.register({
        ...base,
        steps: [{ ...base.steps[0], input: { code: 'ok', extra: 'no' } }],
      }),
    ).toThrow(/未知 Skill 变量/);
    expect(() =>
      workflows.register({
        ...base,
        steps: [{ ...base.steps[0], input: {} }],
      }),
    ).toThrow(/缺少必填/);
  });

  it('拒绝未声明依赖和不受支持的 Workflow 模板表达式', () => {
    const base = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.references',
      name: 'References',
      steps: [
        {
          id: 'first',
          skillId: 'com.eagent.review',
          dependsOn: [],
          input: { code: '{{input.source}}' },
        },
        {
          id: 'second',
          skillId: 'com.eagent.review',
          dependsOn: [],
          input: { code: '{{steps.first}}' },
        },
      ],
    };
    expect(() => parseWorkflowDefinition(base)).toThrow(/必须声明/);
    expect(() =>
      parseWorkflowDefinition({
        ...base,
        steps: [{ ...base.steps[0], input: { code: '{{process.env.SECRET}}' } }],
      }),
    ).toThrow(/不受支持/);
  });

  it('拒绝重复步骤、不存在依赖和自依赖', () => {
    const step = {
      id: 'review',
      skillId: 'com.eagent.review',
      dependsOn: [],
      input: { code: '{{input.source}}' },
    };
    const base = {
      schemaVersion: 1,
      id: 'com.eagent.workflow.structure',
      name: 'Structure',
    };
    expect(() => parseWorkflowDefinition({ ...base, steps: [step, step] })).toThrow(
      /步骤标识不能重复/,
    );
    expect(() =>
      parseWorkflowDefinition({
        ...base,
        steps: [{ ...step, dependsOn: ['missing'] }],
      }),
    ).toThrow(/依赖不存在/);
    expect(() =>
      parseWorkflowDefinition({
        ...base,
        steps: [{ ...step, dependsOn: ['review'] }],
      }),
    ).toThrow(/依赖自身/);
  });

  it('在运行前拒绝未知 Skill、缺失/过长/未知变量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'e-agent-skill-validation-'));
    const registry = new SkillRegistry();
    await registry.load(await createSkill(root));
    const orchestrator = new SkillOrchestrator(registry, {
      execute: () => Promise.resolve('not reached'),
    });
    await expect(orchestrator.runSkill('com.eagent.missing', {})).rejects.toThrow(/未找到/);
    await expect(orchestrator.runSkill('com.eagent.review', {})).rejects.toThrow(/缺少变量/);
    await expect(
      orchestrator.runSkill('com.eagent.review', { code: 'x'.repeat(1_001) }),
    ).rejects.toThrow(/变量过长/);
    await expect(
      orchestrator.runSkill('com.eagent.review', { code: 'ok', extra: 'unknown' }),
    ).rejects.toThrow(/未知变量/);
    expect(registry.getByCommand('@code-review')?.definition.id).toBe('com.eagent.review');
    expect(registry.list()).toHaveLength(1);
  });

  it('把前序 JSON 输出安全序列化后传给后续步骤', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'e-agent-workflow-first-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'e-agent-workflow-second-'));
    const skills = new SkillRegistry();
    await skills.load(await createSkill(firstRoot));
    const secondPath = await createSkill(secondRoot);
    const secondDefinition = JSON.parse(await readFile(secondPath, 'utf8')) as Record<
      string,
      unknown
    >;
    secondDefinition['id'] = 'com.eagent.review-second';
    secondDefinition['command'] = '@review-second';
    await writeFile(join(secondRoot, 'skill.json'), JSON.stringify(secondDefinition));
    await skills.load(join(secondRoot, 'skill.json'));
    const prompts: string[] = [];
    const orchestrator = new SkillOrchestrator(skills, {
      execute(invocation) {
        prompts.push(invocation.prompt);
        return Promise.resolve(
          invocation.definition.id === 'com.eagent.review' ? { verdict: 'ok' } : 'finished',
        );
      },
    });
    await expect(
      orchestrator.runWorkflow(
        {
          schemaVersion: 1,
          id: 'com.eagent.workflow.chain',
          name: 'Chain',
          steps: [
            {
              id: 'first',
              skillId: 'com.eagent.review',
              dependsOn: [],
              input: { code: '{{input.source}}' },
            },
            {
              id: 'second',
              skillId: 'com.eagent.review-second',
              dependsOn: ['first'],
              input: { code: '{{steps.first}}' },
            },
          ],
        },
        { source: 'const value = 1;' },
      ),
    ).resolves.toMatchObject({ outputs: { first: { verdict: 'ok' }, second: 'finished' } });
    expect(prompts[1]).toContain('{"verdict":"ok"}');
  });
});
