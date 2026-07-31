import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { JsonValue } from '@e-agent/plugin-sdk';

import type { SkillRegistry } from './registry.js';
import { type RegisteredSkill } from './registry.js';
import {
  extractWorkflowTemplateReferences,
  parseWorkflowDefinition,
  topologicalOrder,
  type WorkflowDefinition,
} from './schema.js';
import { renderPromptTemplate } from './template.js';

export interface SkillInvocation {
  definition: RegisteredSkill['definition'];
  prompt: string;
  variables: Readonly<Record<string, string>>;
  previousOutputs: Readonly<Record<string, JsonValue>>;
}

export interface SkillExecutor {
  execute(invocation: SkillInvocation, signal: AbortSignal): Promise<JsonValue>;
}

export interface WorkflowResult {
  workflowId: string;
  outputs: Readonly<Record<string, JsonValue>>;
}

/**
 * 验证输入、渲染本地 Prompt，并按依赖顺序执行 Skill 工作流。
 */
export class SkillOrchestrator {
  public constructor(
    private readonly registry: SkillRegistry,
    private readonly executor: SkillExecutor,
  ) {}

  /**
   * 运行单个 Skill。
   */
  public async runSkill(
    skillId: string,
    variables: Readonly<Record<string, string>>,
    locale: 'en-US' | 'zh-CN' = 'zh-CN',
    previousOutputs: Readonly<Record<string, JsonValue>> = {},
  ): Promise<JsonValue> {
    const skill = this.registry.getById(skillId);
    if (skill === undefined) {
      throw new Error(`未找到 Skill：${skillId}`);
    }
    validateVariables(skill, variables);
    const normalizedVariables = Object.fromEntries(
      skill.definition.variables.map((definition) => [
        definition.name,
        variables[definition.name] ?? '',
      ]),
    );
    const promptTemplate = await readFile(
      resolve(skill.root, skill.definition.prompts[locale]),
      'utf8',
    );
    const prompt = renderPromptTemplate(promptTemplate, normalizedVariables);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), skill.definition.timeoutMs);
    try {
      return await this.executor.execute(
        {
          definition: skill.definition,
          prompt,
          variables: normalizedVariables,
          previousOutputs,
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 按拓扑顺序运行工作流；步骤输入可引用 {{steps.stepId}} 的 JSON 输出。
   */
  public async runWorkflow(
    definitionValue: unknown,
    sharedVariables: Readonly<Record<string, string>>,
    locale: 'en-US' | 'zh-CN' = 'zh-CN',
  ): Promise<WorkflowResult> {
    const workflow = parseWorkflowDefinition(definitionValue);
    const outputs: Record<string, JsonValue> = {};
    const stepsById = new Map(workflow.steps.map((step) => [step.id, step]));
    for (const stepId of topologicalOrder(workflow)) {
      const step = stepsById.get(stepId);
      if (step === undefined) {
        throw new Error(`工作流步骤不存在：${stepId}`);
      }
      const variables = Object.fromEntries(
        Object.entries(step.input).map(([name, template]) => [
          name,
          interpolateWorkflowValue(template, sharedVariables, outputs),
        ]),
      );
      try {
        outputs[stepId] = await this.runSkill(step.skillId, variables, locale, outputs);
      } catch (error) {
        throw new Error(`Workflow 步骤 ${stepId} 执行失败`, { cause: error });
      }
    }
    return { workflowId: workflow.id, outputs };
  }
}

function validateVariables(
  skill: RegisteredSkill,
  variables: Readonly<Record<string, string>>,
): void {
  const definitions = new Map(
    skill.definition.variables.map((variable) => [variable.name, variable]),
  );
  for (const definition of skill.definition.variables) {
    const value = variables[definition.name];
    if (definition.required && (value === undefined || value.length === 0)) {
      throw new Error(`Skill 缺少变量：${definition.name}`);
    }
    if (value !== undefined && value.length > definition.maximumLength) {
      throw new Error(`Skill 变量过长：${definition.name}`);
    }
  }
  for (const name of Object.keys(variables)) {
    if (!definitions.has(name)) {
      throw new Error(`Skill 包含未知变量：${name}`);
    }
  }
}

function interpolateWorkflowValue(
  template: string,
  sharedVariables: Readonly<Record<string, string>>,
  outputs: Readonly<Record<string, JsonValue>>,
): string {
  extractWorkflowTemplateReferences(template);
  return template.replace(
    /\{\{\s*(?:input\.([a-zA-Z][a-zA-Z0-9_]{0,63})|steps\.([a-z][a-z0-9-]{0,48}))\s*\}\}/gu,
    (_match, inputName: string | undefined, stepId: string | undefined) => {
      if (inputName !== undefined) {
        const value = sharedVariables[inputName];
        if (value === undefined) {
          throw new Error(`工作流缺少输入：${inputName}`);
        }
        return value;
      }
      const output = stepId === undefined ? undefined : outputs[stepId];
      if (output === undefined) {
        throw new Error(`工作流步骤输出不可用：${String(stepId)}`);
      }
      return typeof output === 'string' ? output : JSON.stringify(output);
    },
  );
}

export type { WorkflowDefinition };
