import type { Actor, CoreServices } from '@e-agent/core';
import type { JsonValue } from '@e-agent/plugin-sdk';
import { SkillOrchestrator, WorkflowRegistry, type WorkflowDefinition } from '@e-agent/skills';

import { DesktopError } from './errors.js';
import type { AppLogger } from './logger.js';
import type { DesktopSkillResolver } from './skill-resolver.js';

const workflowSettingsScope = 'desktop-workflows';

export interface DesktopWorkflowServiceOptions {
  services: CoreServices;
  skills: DesktopSkillResolver;
  logger: AppLogger;
}

/**
 * 在桌面 SQLite 中持久化 Workflow，并复用统一 Skill 注册表执行有向步骤。
 */
export class DesktopWorkflowService {
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: DesktopWorkflowServiceOptions) {}

  public async list(actor: Actor): Promise<readonly WorkflowDefinition[]> {
    this.assertReadable(actor);
    return (await this.loadRegistry(false)).list();
  }

  public save(value: unknown, actor: Actor): Promise<WorkflowDefinition> {
    this.assertAdministrative(actor);
    return this.exclusive(async () => {
      const workflows = await this.loadRegistry(false);
      let saved: WorkflowDefinition;
      try {
        saved = workflows.upsert(value);
      } catch (error) {
        throw workflowError(error);
      }
      this.persist(workflows);
      this.audit(actor.id, 'workflow.save', saved.id, {
        stepCount: saved.steps.length,
      });
      return saved;
    });
  }

  public delete(id: string, actor: Actor): Promise<void> {
    this.assertAdministrative(actor);
    return this.exclusive(async () => {
      const workflows = await this.loadRegistry(false);
      if (!workflows.delete(id)) {
        throw new DesktopError('WORKFLOW_NOT_FOUND', 'Workflow 不存在');
      }
      this.persist(workflows);
      this.audit(actor.id, 'workflow.delete', id);
    });
  }

  public async run(
    id: string,
    variables: Readonly<Record<string, string>>,
    locale: 'en-US' | 'zh-CN',
    actor: Actor,
    shutdownSignal?: AbortSignal,
  ): Promise<{ workflowId: string; outputs: Readonly<Record<string, JsonValue>> }> {
    if (actor.role === 'viewer') {
      throw new DesktopError('FORBIDDEN', '只读成员不能运行 Workflow');
    }
    const stored = await this.loadRegistry(false);
    const workflow = stored.get(id);
    if (workflow === undefined) {
      throw new DesktopError('WORKFLOW_NOT_FOUND', 'Workflow 不存在');
    }
    const enabledSkills = await this.options.skills.createRegistry({ enabledOnly: true });
    const disabledStep = workflow.steps.find(
      (step) => enabledSkills.getById(step.skillId) === undefined,
    );
    if (disabledStep !== undefined) {
      throw new DesktopError(
        'WORKFLOW_SKILL_DISABLED',
        `Workflow 使用了未批准、未启用或无效的 Skill：${disabledStep.skillId}`,
      );
    }
    const orchestrator = new SkillOrchestrator(enabledSkills, {
      execute: async (invocation, skillSignal) => {
        const signal =
          shutdownSignal === undefined
            ? skillSignal
            : AbortSignal.any([skillSignal, shutdownSignal]);
        const completion = await this.options.services.chat.complete(
          {
            messages: [{ role: 'user', content: invocation.prompt }],
            stream: false,
          },
          actor,
          { signal },
        );
        return completion.content;
      },
    });
    const result = await orchestrator.runWorkflow(workflow, variables, locale);
    this.audit(actor.id, 'workflow.run', workflow.id, {
      stepCount: workflow.steps.length,
    });
    return result;
  }

  private async loadRegistry(enabledOnly: boolean): Promise<WorkflowRegistry> {
    const skills = await this.options.skills.createRegistry({ enabledOnly });
    const workflows = new WorkflowRegistry(skills);
    const stored =
      this.options.services.repositories.settings.get<unknown[]>(workflowSettingsScope) ?? [];
    for (const value of stored) {
      try {
        workflows.register(value);
      } catch (error) {
        this.options.logger.warn('已保存 Workflow 加载失败', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    return workflows;
  }

  private persist(workflows: WorkflowRegistry): void {
    this.options.services.repositories.settings.set(workflowSettingsScope, workflows.list());
  }

  private audit(
    actorId: string,
    action: string,
    targetId: string,
    metadata: Readonly<Record<string, JsonValue>> = {},
  ): void {
    this.options.services.repositories.audit.record({
      actorId,
      action,
      targetType: 'workflow',
      targetId,
      metadata,
    });
  }

  private assertReadable(actor: Actor): void {
    if (!['owner', 'admin', 'member', 'viewer'].includes(actor.role)) {
      throw new DesktopError('FORBIDDEN', '无权读取 Workflow');
    }
  }

  private assertAdministrative(actor: Actor): void {
    if (actor.role !== 'owner' && actor.role !== 'admin') {
      throw new DesktopError('FORBIDDEN', '只有 Owner 或 Admin 可以修改 Workflow');
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function workflowError(error: unknown): DesktopError {
  return new DesktopError(
    'WORKFLOW_INVALID',
    error instanceof Error ? error.message : 'Workflow 定义无效',
  );
}
