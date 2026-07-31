import { DomainError } from '@e-agent/core';
import {
  SkillOrchestrator,
  type SkillInvocation,
  type WorkflowDefinition,
  WorkflowRegistry,
} from '@e-agent/skills';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireActor, requireRole } from '../auth.js';

const skillRunSchema = z
  .object({
    variables: z.record(z.string()).default({}),
    locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  })
  .strict();

const skillUpdateSchema = z.object({ enabled: z.boolean() }).strict();
const skillInstallSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), path: z.string().min(1) }),
  z.object({ type: z.literal('git'), url: z.string().url(), ref: z.string().optional() }),
]);

const workflowRunSchema = z
  .object({
    workflow: z.unknown(),
    variables: z.record(z.string()).default({}),
    locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  })
  .strict();

const savedWorkflowRunSchema = z
  .object({
    variables: z.record(z.string()).default({}),
    locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  })
  .strict();

const workflowSaveSchema = z.object({ workflow: z.unknown() }).strict();

const pluginInstallSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory'), path: z.string().min(1) }),
  z.object({
    type: z.literal('git'),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), '仅允许 HTTPS'),
    ref: z.string().min(1).optional(),
  }),
]);

const pluginActionSchema = z.object({
  action: z.enum(['approve', 'revoke', 'enable', 'disable']),
});

function extensions(app: FastifyInstance) {
  const value = app.eAgent.extensions;
  if (value === null) {
    throw new DomainError('INTERNAL_ERROR', '扩展运行时尚未就绪', {
      statusCode: 503,
      retryable: true,
    });
  }
  return value;
}

function createOrchestrator(
  app: FastifyInstance,
  actor: ReturnType<typeof requireActor>,
): SkillOrchestrator {
  return new SkillOrchestrator(extensions(app).skills, {
    execute: async (invocation: SkillInvocation, signal) => {
      const completion = await app.eAgent.services.chat.complete(
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
}

function assertWorkflowSkillsEnabled(app: FastifyInstance, workflow: WorkflowDefinition): void {
  const disabled = workflow.steps.find((step) => !extensions(app).isSkillEnabled(step.skillId));
  if (disabled !== undefined) {
    throw new DomainError('FORBIDDEN', `Workflow 使用了已停用的 Skill：${disabled.skillId}`);
  }
}

function workflowBadRequest(error: unknown): DomainError {
  return new DomainError(
    'BAD_REQUEST',
    error instanceof Error ? error.message : 'Workflow 定义无效',
    { cause: error },
  );
}

function auditWorkflow(
  app: FastifyInstance,
  actorId: string,
  action: string,
  workflowId: string,
  metadata: Record<string, unknown> = {},
): void {
  app.eAgent.services.repositories.audit.record({
    actorId,
    action,
    targetType: 'workflow',
    targetId: workflowId,
    metadata,
  });
}

export function registerExtensionRoutes(app: FastifyInstance): void {
  app.get('/api/v1/skills', async (request) => {
    requireActor(request);
    return {
      skills: extensions(app)
        .skills.list()
        .map((skill) => ({
          ...skill.definition,
          enabled: extensions(app).isSkillEnabled(skill.definition.id),
          source: extensions(app).isBuiltInSkill(skill.definition.id) ? 'builtin' : 'local',
        })),
    };
  });

  app.patch('/api/v1/skills/:id', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const { enabled } = skillUpdateSchema.parse(request.body);
    extensions(app).setSkillEnabled(id, enabled);
    return { id, enabled };
  });

  app.post('/api/v1/skills/install', async (request, reply) => {
    requireRole(request, ['owner']);
    const source = skillInstallSchema.parse(request.body);
    if (source.type === 'git') {
      throw new DomainError('BAD_REQUEST', 'Skill Git 安装请使用插件市场接口', {
        statusCode: 501,
        details: { supportedEndpoint: '/api/v1/plugins/install' },
      });
    }
    const installed = await extensions(app).installSkill(source.path);
    reply.code(201);
    return { skill: installed?.definition, enabled: true };
  });

  app.post('/api/v1/skills/:id/run', async (request) => {
    const actor = requireRole(request, ['owner', 'admin', 'member']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const input = skillRunSchema.parse(request.body ?? {});
    if (extensions(app).skills.getById(id) === undefined) {
      throw new DomainError('NOT_FOUND', 'Skill 不存在');
    }
    if (!extensions(app).isSkillEnabled(id)) {
      throw new DomainError('FORBIDDEN', 'Skill 已停用');
    }
    const orchestrator = createOrchestrator(app, actor);
    return {
      skillId: id,
      output: await orchestrator.runSkill(id, input.variables, input.locale),
    };
  });

  app.get('/api/v1/workflows', async (request) => {
    requireActor(request);
    return { workflows: extensions(app).workflows.list() };
  });

  app.post('/api/v1/workflows', async (request, reply) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const input = workflowSaveSchema.parse(request.body);
    try {
      const workflow = extensions(app).saveWorkflow(input.workflow);
      auditWorkflow(app, actor.id, 'workflow.save', workflow.id, {
        stepCount: workflow.steps.length,
      });
      reply.code(201);
      return { workflow };
    } catch (error) {
      throw workflowBadRequest(error);
    }
  });

  app.put('/api/v1/workflows/:id', async (request) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const input = workflowSaveSchema.parse(request.body);
    try {
      const definition = input.workflow as { id?: unknown };
      if (definition === null || typeof definition !== 'object' || definition.id !== id) {
        throw new Error('Workflow 路径标识与定义标识不一致');
      }
      const workflow = extensions(app).saveWorkflow(input.workflow);
      auditWorkflow(app, actor.id, 'workflow.save', workflow.id, {
        stepCount: workflow.steps.length,
      });
      return { workflow };
    } catch (error) {
      throw workflowBadRequest(error);
    }
  });

  app.delete('/api/v1/workflows/:id', async (request, reply) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    if (!extensions(app).deleteWorkflow(id)) {
      throw new DomainError('NOT_FOUND', 'Workflow 不存在', { statusCode: 404 });
    }
    auditWorkflow(app, actor.id, 'workflow.delete', id);
    reply.code(204);
    return undefined;
  });

  app.post('/api/v1/workflows/:id/run', async (request) => {
    const actor = requireRole(request, ['owner', 'admin', 'member']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const input = savedWorkflowRunSchema.parse(request.body ?? {});
    const workflow = extensions(app).workflows.get(id);
    if (workflow === undefined) {
      throw new DomainError('NOT_FOUND', 'Workflow 不存在', { statusCode: 404 });
    }
    assertWorkflowSkillsEnabled(app, workflow);
    const result = await createOrchestrator(app, actor).runWorkflow(
      workflow,
      input.variables,
      input.locale,
    );
    auditWorkflow(app, actor.id, 'workflow.run', id, {
      stepCount: workflow.steps.length,
    });
    return result;
  });

  /** 兼容旧客户端的临时 Workflow 执行接口；定义不会被保存。 */
  app.post('/api/v1/workflows/run', async (request) => {
    const actor = requireRole(request, ['owner', 'admin', 'member']);
    const input = workflowRunSchema.parse(request.body);
    let workflow: WorkflowDefinition;
    try {
      workflow = new WorkflowRegistry(extensions(app).skills).register(input.workflow);
    } catch (error) {
      throw workflowBadRequest(error);
    }
    assertWorkflowSkillsEnabled(app, workflow);
    return createOrchestrator(app, actor).runWorkflow(workflow, input.variables, input.locale);
  });

  app.get('/api/v1/plugins', async (request) => {
    requireRole(request, ['owner', 'admin']);
    return { plugins: await extensions(app).plugins.list() };
  });

  app.post('/api/v1/plugins/install', async (request, reply) => {
    requireRole(request, ['owner']);
    const source = pluginInstallSchema.parse(request.body);
    const plugin = await extensions(app).plugins.install(source);
    reply.code(201);
    return plugin;
  });

  app.post('/api/v1/plugins/:id/actions', async (request) => {
    requireRole(request, ['owner']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const { action } = pluginActionSchema.parse(request.body);
    const runtime = extensions(app).plugins;
    if (action === 'approve') await runtime.approve(id);
    else if (action === 'revoke') await runtime.revoke(id);
    else if (action === 'enable') await runtime.enable(id);
    else await runtime.disable(id);
    return { success: true };
  });

  app.delete('/api/v1/plugins/:id', async (request) => {
    requireRole(request, ['owner']);
    const id = z
      .string()
      .min(1)
      .parse((request.params as { id?: unknown }).id);
    const recoverablePath = await extensions(app).plugins.uninstall(id);
    return { success: true, recoverablePath };
  });
}
