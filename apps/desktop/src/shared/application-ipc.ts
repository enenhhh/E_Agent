import { z } from 'zod';

const emptySchema = z.object({}).strict();
const identifierSchema = z.string().min(1).max(128);
const operationIdentifierSchema = z.string().min(8).max(128);
const toolCallIdentifierSchema = z.string().min(1).max(256);
const rangeSchema = z.enum(['day', 'week', 'month']);
const providerTypeSchema = z.enum([
  'openai',
  'anthropic',
  'deepseek',
  'groq',
  'google',
  'ollama',
  'custom',
]);
const providerKeyStrategySchema = z.enum(['round-robin', 'priority']);
const skillIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u);
const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: skillIdentifierSchema,
    name: z.string().min(1).max(80),
    steps: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,48}$/u),
            skillId: skillIdentifierSchema,
            dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,48}$/u)).max(20),
            input: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/u), z.string().max(2_000_000)),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const workflowVariablesSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u), z.string().max(2_000_000))
  .refine((value) => Object.keys(value).length <= 32, 'Workflow 输入变量不能超过 32 个');
const contextMentionSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^@(file|folder|web):(?:"[^"]+"|[^\s]+)$/u);
const mcpServerIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);
const mcpEnvironmentSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string().max(32_768))
  .refine((value) => Object.keys(value).length <= 64, '环境变量最多 64 项');
const mcpHeadersSchema = z
  .record(z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u), z.string().max(32_768))
  .refine((value) => Object.keys(value).length <= 64, '请求头最多 64 项');
const mcpServerInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      id: mcpServerIdSchema.optional(),
      displayName: z.string().trim().min(1).max(80),
      enabled: z.boolean().optional(),
      transport: z.literal('stdio'),
      command: z.string().trim().min(1).max(2_048),
      args: z.array(z.string().max(4_096)).max(64).optional(),
      cwd: z.string().trim().min(1).max(2_048).optional(),
      env: mcpEnvironmentSchema.optional(),
      inheritEnv: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      id: mcpServerIdSchema.optional(),
      displayName: z.string().trim().min(1).max(80),
      enabled: z.boolean().optional(),
      transport: z.literal('streamable-http'),
      url: z.string().url().max(2_048),
      headers: mcpHeadersSchema.optional(),
      allowInsecureHttp: z.boolean().optional(),
    })
    .strict(),
]);

/**
 * app-ui 可调用的业务 IPC 通道。每个通道均有独立输入 schema，
 * 不提供可转发任意通道或任意方法的万能入口。
 */
export const applicationInvokeSchemas = {
  'auth:get-session': emptySchema,
  'auth:setup': z
    .object({
      name: z.string().min(1).max(80),
      email: z.string().email().max(254),
      password: z.string().min(8).max(256),
    })
    .strict(),
  'auth:login': z
    .object({
      email: z.string().email().max(254),
      password: z.string().min(1).max(256),
    })
    .strict(),
  'auth:logout': emptySchema,
  'models:list': emptySchema,
  'models:discover': z.object({ providerId: z.string().uuid().optional() }).strict(),
  'models:update-provider-selection': z
    .object({
      providerId: z.string().uuid(),
      enabledModelIds: z.array(z.string().uuid()).max(5_000),
    })
    .strict()
    .refine((input) => new Set(input.enabledModelIds).size === input.enabledModelIds.length, {
      message: '启用模型列表不能包含重复项',
      path: ['enabledModelIds'],
    }),
  'providers:list': emptySchema,
  'providers:create': z
    .object({
      type: providerTypeSchema,
      name: z.string().min(1).max(120),
      baseUrl: z.string().url().max(4_096),
      keyStrategy: providerKeyStrategySchema,
      enabled: z.boolean().optional(),
    })
    .strict(),
  'providers:update': z
    .object({
      id: identifierSchema,
      input: z
        .object({
          type: providerTypeSchema.optional(),
          name: z.string().min(1).max(120).optional(),
          baseUrl: z.string().url().max(4_096).optional(),
          keyStrategy: providerKeyStrategySchema.optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  'credentials:list': emptySchema,
  'credentials:create': z
    .object({
      name: z.string().min(1).max(80),
      providerId: identifierSchema.optional(),
      provider: z.string().min(1).max(80).optional(),
      providerName: z.string().min(1).max(80).optional(),
      apiKey: z.string().min(1).max(8_192),
      baseUrl: z.string().url().max(2_048).optional(),
      strategy: z.enum(['round-robin', 'priority', 'failover']),
      priority: z.number().int().min(0).max(10_000),
      dailyLimit: z.number().nonnegative().optional(),
      monthlyLimit: z.number().nonnegative().optional(),
      quotaUnit: z.enum(['usd', 'tokens']).optional(),
      proxyUrl: z.string().url().max(2_048).optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .refine((input) => input.providerId !== undefined || input.provider !== undefined, {
      message: '必须选择服务商',
      path: ['providerId'],
    }),
  'credentials:update': z
    .object({
      id: identifierSchema,
      input: z.record(z.string(), z.json()),
    })
    .strict(),
  'credentials:delete': z.object({ id: identifierSchema }).strict(),
  'credentials:check': z.object({ id: identifierSchema }).strict(),
  'credentials:check-all': emptySchema,
  'conversations:list': emptySchema,
  'conversations:get': z.object({ id: identifierSchema }).strict(),
  'conversations:create': z.object({ title: z.string().max(200).optional() }).strict(),
  'conversations:update': z
    .object({
      id: identifierSchema,
      input: z
        .object({
          title: z.string().min(1).max(200).optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  'conversations:delete': z.object({ id: identifierSchema }).strict(),
  'conversations:branch': z
    .object({
      id: identifierSchema,
      messageId: identifierSchema,
      operationId: operationIdentifierSchema.optional(),
      includeFromMessage: z.boolean().optional(),
      kind: z.enum(['branch', 'retry', 'edit']).optional(),
      originMessageId: identifierSchema.optional(),
      title: z.string().min(1).max(240).optional(),
    })
    .strict(),
  'conversations:snapshot': z.object({ id: identifierSchema }).strict(),
  'conversations:list-snapshots': z.object({ id: identifierSchema }).strict(),
  'conversations:restore-snapshot': z
    .object({ id: identifierSchema, snapshotId: identifierSchema })
    .strict(),
  'messages:list': z.object({ conversationId: identifierSchema }).strict(),
  'messages:snapshot': z.object({ conversationId: identifierSchema }).strict(),
  'messages:delete': z
    .object({
      conversationId: identifierSchema,
      messageId: identifierSchema,
      operationId: operationIdentifierSchema.optional(),
      expectedMessageCount: z.number().int().nonnegative(),
      expectedTailMessageId: identifierSchema,
    })
    .strict(),
  'messages:feedback': z
    .object({
      conversationId: identifierSchema,
      messageId: identifierSchema,
      feedback: z.enum(['helpful', 'unhelpful']).nullable(),
    })
    .strict(),
  'context:get': z.object({ conversationId: identifierSchema }).strict(),
  'workspace:decide-change': z
    .object({
      conversationId: identifierSchema,
      changeId: identifierSchema,
      decision: z.enum(['accept', 'reject']),
      acceptedLines: z.array(z.number().int().positive()).max(100_000).optional(),
    })
    .strict(),
  'tools:decide': z
    .object({
      conversationId: identifierSchema,
      toolCallId: toolCallIdentifierSchema,
      decision: z.enum(['approve', 'reject']),
    })
    .strict(),
  'usage:summary': z.object({ range: rangeSchema }).strict(),
  'usage:records': z.object({ range: rangeSchema }).strict(),
  'usage:export': z
    .object({
      range: rangeSchema,
      format: z.enum(['csv', 'json', 'pdf']),
    })
    .strict(),
  'skills:list': emptySchema,
  'skills:set-enabled': z.object({ id: identifierSchema, enabled: z.boolean() }).strict(),
  'skills:install': z.object({ source: z.string().min(1).max(2_048) }).strict(),
  'workflows:list': emptySchema,
  'workflows:save': z.object({ workflow: workflowDefinitionSchema }).strict(),
  'workflows:delete': z.object({ id: skillIdentifierSchema }).strict(),
  'workflows:run': z
    .object({
      id: skillIdentifierSchema,
      variables: workflowVariablesSchema,
      locale: z.enum(['zh-CN', 'en-US']),
    })
    .strict(),
  'plugins:set-enabled': z.object({ id: identifierSchema, enabled: z.boolean() }).strict(),
  'mcp:list': emptySchema,
  'mcp:save': mcpServerInputSchema,
  'mcp:set-enabled': z.object({ id: mcpServerIdSchema, enabled: z.boolean() }).strict(),
  'mcp:refresh': z.object({ id: mcpServerIdSchema }).strict(),
  'mcp:remove': z.object({ id: mcpServerIdSchema }).strict(),
  'settings:get': emptySchema,
  'settings:update': z.record(z.string(), z.json()),
  'audit:list': emptySchema,
  'queue:status': emptySchema,
  'system:check': emptySchema,
} as const;

export type ApplicationInvokeChannel = keyof typeof applicationInvokeSchemas;
export const applicationInvokeChannels = Object.freeze(
  Object.keys(applicationInvokeSchemas) as ApplicationInvokeChannel[],
);

export const applicationStreamSchemas = {
  'chat:stream': z
    .object({
      conversationId: identifierSchema,
      userMessageId: z.string().uuid().optional(),
      content: z.string().max(1_000_000),
      model: z.string().min(1).max(256),
      continuationToolCallId: toolCallIdentifierSchema.optional(),
      skill: z.string().min(1).max(128).optional(),
      contextMentions: z.array(contextMentionSchema).max(32),
      compareModels: z.array(z.string().min(1).max(256)).max(4).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.continuationToolCallId === undefined && value.content.trim() === '') {
        context.addIssue({ code: 'custom', path: ['content'], message: '消息内容不能为空' });
      }
      if (
        value.continuationToolCallId !== undefined &&
        (value.content !== '' ||
          value.skill !== undefined ||
          value.contextMentions.length > 0 ||
          value.compareModels !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['continuationToolCallId'],
          message: '工具续跑请求不能附带新的用户输入、Skill、上下文或模型对比',
        });
      }
    }),
} as const;

export type ApplicationStreamChannel = keyof typeof applicationStreamSchemas;
export const applicationStreamChannels = Object.freeze(
  Object.keys(applicationStreamSchemas) as ApplicationStreamChannel[],
);

export const streamStartSchema = z
  .object({
    streamId: z.string().uuid(),
    channel: z.literal('chat:stream'),
    payload: applicationStreamSchemas['chat:stream'],
  })
  .strict();

export const streamAbortSchema = z.object({ streamId: z.string().uuid() }).strict();

export const streamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      streamId: z.string().uuid(),
      type: z.literal('event'),
      data: z.json(),
    })
    .strict(),
  z
    .object({
      streamId: z.string().uuid(),
      type: z.literal('error'),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      streamId: z.string().uuid(),
      type: z.literal('complete'),
    })
    .strict(),
]);
