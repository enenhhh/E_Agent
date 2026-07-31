import type { SkillRegistry } from './registry.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from './schema.js';

/**
 * 管理经过严格校验的 Workflow 定义，并在保存阶段验证 Skill 输入契约。
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  public constructor(private readonly skills: SkillRegistry) {}

  /**
   * 注册新 Workflow；标识已存在时拒绝覆盖。
   */
  public register(value: unknown): WorkflowDefinition {
    const workflow = this.validate(value);
    if (this.workflows.has(workflow.id)) {
      throw new Error(`Workflow 已存在：${workflow.id}`);
    }
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  /**
   * 新建或替换 Workflow，并返回规范化后的定义。
   */
  public upsert(value: unknown): WorkflowDefinition {
    const workflow = this.validate(value);
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  /**
   * 按标识获取 Workflow。
   */
  public get(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id);
  }

  /**
   * 返回按名称和标识稳定排序的 Workflow。
   */
  public list(): readonly WorkflowDefinition[] {
    return [...this.workflows.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  }

  /**
   * 删除 Workflow；不存在时返回 false。
   */
  public delete(id: string): boolean {
    return this.workflows.delete(id);
  }

  private validate(value: unknown): WorkflowDefinition {
    const workflow = parseWorkflowDefinition(value);
    for (const step of workflow.steps) {
      const skill = this.skills.getById(step.skillId);
      if (skill === undefined) {
        throw new Error(`Workflow 引用了不存在的 Skill：${step.skillId}`);
      }
      const variables = new Map(
        skill.definition.variables.map((variable) => [variable.name, variable]),
      );
      for (const name of Object.keys(step.input)) {
        if (!variables.has(name)) {
          throw new Error(`Workflow 步骤 ${step.id} 包含未知 Skill 变量：${name}`);
        }
      }
      for (const variable of skill.definition.variables) {
        if (variable.required && step.input[variable.name] === undefined) {
          throw new Error(`Workflow 步骤 ${step.id} 缺少必填 Skill 变量：${variable.name}`);
        }
      }
    }
    return workflow;
  }
}
