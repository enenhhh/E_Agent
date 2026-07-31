import { z } from 'zod';

const skillIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);

const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith('/') && !value.includes('\\'))
  .refine((value) => !value.split('/').includes('..'));

export const skillDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: skillIdSchema,
    command: z.string().regex(/^@[a-z][a-z0-9-]{1,48}$/),
    name: z
      .object({
        'zh-CN': z.string().min(1).max(80),
        'en-US': z.string().min(1).max(80),
      })
      .strict(),
    version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
    description: z
      .object({
        'zh-CN': z.string().min(1).max(500),
        'en-US': z.string().min(1).max(500),
      })
      .strict(),
    prompts: z
      .object({
        'zh-CN': relativePathSchema,
        'en-US': relativePathSchema,
      })
      .strict(),
    executor: z
      .object({
        pluginId: skillIdSchema,
        commandId: skillIdSchema,
      })
      .strict()
      .optional(),
    variables: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
            description: z.string().min(1).max(200),
            required: z.boolean().default(true),
            maximumLength: z.number().int().min(1).max(2_000_000).default(200_000),
          })
          .strict(),
      )
      .max(32)
      .refine(
        (variables) =>
          new Set(variables.map((variable) => variable.name)).size === variables.length,
        'Skill 变量名不能重复',
      ),
    output: z.enum(['json', 'markdown', 'text']),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: skillIdSchema,
    name: z.string().min(1).max(80),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,48}$/),
            skillId: skillIdSchema,
            dependsOn: z
              .array(z.string().regex(/^[a-z][a-z0-9-]{0,48}$/))
              .max(20)
              .refine((values) => new Set(values).size === values.length, {
                message: '工作流步骤依赖不能重复',
              })
              .default([]),
            input: z
              .record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.string().max(2_000_000))
              .default({}),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/**
 * 严格解析 Skill 定义。
 */
export function parseSkillDefinition(value: unknown): SkillDefinition {
  return skillDefinitionSchema.parse(value);
}

/**
 * 严格解析工作流并检查步骤标识、依赖和循环。
 */
export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(value);
  const ids = new Set(workflow.steps.map((step) => step.id));
  if (ids.size !== workflow.steps.length) {
    throw new Error('工作流步骤标识不能重复');
  }
  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`工作流依赖不存在：${dependency}`);
      }
      if (dependency === step.id) {
        throw new Error(`工作流步骤不能依赖自身：${step.id}`);
      }
    }
    for (const template of Object.values(step.input)) {
      const references = extractWorkflowTemplateReferences(template);
      for (const reference of references.steps) {
        if (!ids.has(reference)) {
          throw new Error(`工作流引用的步骤不存在：${reference}`);
        }
        if (!step.dependsOn.includes(reference)) {
          throw new Error(`工作流步骤 ${step.id} 必须声明对 ${reference} 的依赖`);
        }
      }
    }
  }
  topologicalOrder(workflow);
  return workflow;
}

/**
 * 提取并验证工作流模板引用。只允许 input 和 steps 两种受控引用。
 */
export function extractWorkflowTemplateReferences(template: string): {
  inputs: readonly string[];
  steps: readonly string[];
} {
  const inputs = new Set<string>();
  const steps = new Set<string>();
  const pattern =
    /\{\{\s*(?:input\.([a-zA-Z][a-zA-Z0-9_]{0,63})|steps\.([a-z][a-z0-9-]{0,48}))\s*\}\}/gu;
  const remainder = template.replace(
    pattern,
    (_match, inputName: string | undefined, stepId: string | undefined) => {
      if (inputName !== undefined) inputs.add(inputName);
      if (stepId !== undefined) steps.add(stepId);
      return '';
    },
  );
  if (/\{\{|\}\}/u.test(remainder)) {
    throw new Error('工作流包含不受支持的模板表达式');
  }
  return { inputs: [...inputs], steps: [...steps] };
}

/**
 * 生成稳定的工作流拓扑顺序；发现循环时抛出错误。
 */
export function topologicalOrder(workflow: WorkflowDefinition): readonly string[] {
  const remaining = new Map(workflow.steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const result: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) =>
        [...dependencies].every((dependency) => result.includes(dependency)),
      )
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      throw new Error('工作流包含循环依赖');
    }
    for (const id of ready) {
      result.push(id);
      remaining.delete(id);
    }
  }
  return result;
}
