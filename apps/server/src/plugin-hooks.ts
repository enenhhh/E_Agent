import type { AuditRepository } from '@e-agent/database';
import type { AppLogger } from '@e-agent/observability';
import { PluginRuntimeError, type PluginRuntime } from '@e-agent/plugin-runtime';
import { z } from 'zod';

const actorSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
  })
  .strict();

const hookEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  requestId: z.string().min(1).max(128),
  actor: actorSchema.nullable(),
});

const requestMetadataSchema = z
  .object({
    stream: z.boolean(),
    messageCount: z.number().int().min(1).max(500),
    textCharacterCount: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    toolCount: z.number().int().min(0).max(64),
    contextMentionCount: z.number().int().min(0).max(32),
    hasConversation: z.boolean(),
    hasProject: z.boolean(),
    hasExplicitModel: z.boolean(),
    hasProvider: z.boolean(),
    hasSkill: z.boolean(),
  })
  .strict();

const outcomeSchema = z
  .object({
    success: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    errorCode: z.string().min(1).max(64).nullable(),
  })
  .strict();

const responseMetadataSchema = z
  .object({
    conversationId: z.string().uuid().nullable(),
    messageId: z.string().uuid().nullable(),
    cacheHit: z.boolean().nullable(),
  })
  .strict();

const fileMetadataSchema = z
  .object({
    relativePath: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.startsWith('/') && !value.includes('\\'), {
        message: 'Hook 文件路径必须是使用正斜杠的相对路径',
      })
      .refine((value) => !value.split('/').includes('..'), {
        message: 'Hook 文件路径不能逃逸工作区',
      }),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    changeId: z.string().uuid().nullable(),
  })
  .strict();

const hookPayloadSchemas = {
  'request:before': hookEnvelopeSchema
    .extend({
      operation: z.literal('chat.completion'),
      request: requestMetadataSchema,
    })
    .strict(),
  'request:after': hookEnvelopeSchema
    .extend({
      operation: z.literal('chat.completion'),
      request: requestMetadataSchema,
      outcome: outcomeSchema,
      response: responseMetadataSchema,
    })
    .strict(),
  'file:before-save': hookEnvelopeSchema
    .extend({
      operation: z.literal('workspace.file-save'),
      file: fileMetadataSchema,
    })
    .strict(),
  'file:after-save': hookEnvelopeSchema
    .extend({
      operation: z.literal('workspace.file-save'),
      file: fileMetadataSchema,
      outcome: outcomeSchema,
    })
    .strict(),
  'session:created': hookEnvelopeSchema
    .extend({
      operation: z.literal('session.created'),
      flow: z.enum(['register', 'login']),
    })
    .strict(),
  'session:closed': hookEnvelopeSchema
    .extend({
      operation: z.literal('session.closed'),
      reason: z.literal('logout'),
    })
    .strict(),
} as const;

export type ServerHookName = keyof typeof hookPayloadSchemas;
export type ServerHookPayloadMap = {
  [Name in ServerHookName]: z.infer<(typeof hookPayloadSchemas)[Name]>;
};

export interface HookRunContext {
  actorId?: string | null;
}

export interface HookRunResult {
  pluginId: string;
  success: boolean;
  durationMs: number;
  errorCode: string | null;
}

type PluginInput = Parameters<PluginRuntime['invoke']>[3];
type PluginRuntimePort = Pick<PluginRuntime, 'invoke' | 'list'>;
type AuditPort = Pick<AuditRepository, 'record'>;

function pluginErrorCode(error: unknown): string {
  return error instanceof PluginRuntimeError ? error.code : 'HOOK_FAILED';
}

/**
 * 以只读、严格校验的元数据触发插件 Hook。
 *
 * Hook 输出不会修改请求或响应；未启用、未授权或未在清单声明的插件不会被调用。
 * 单个插件失败会被隔离，原始异常文本不会进入日志或审计记录。
 */
export class PluginHookRunner {
  public constructor(
    private readonly plugins: PluginRuntimePort,
    private readonly audit: AuditPort,
    private readonly logger: AppLogger,
  ) {}

  public async run<Name extends ServerHookName>(
    name: Name,
    payload: ServerHookPayloadMap[Name],
    context: HookRunContext = {},
  ): Promise<readonly HookRunResult[]> {
    const safeInput = hookPayloadSchemas[name].parse(payload) as PluginInput;
    let statuses: Awaited<ReturnType<PluginRuntimePort['list']>>;
    try {
      statuses = await this.plugins.list();
    } catch {
      this.logger.error({ hookName: name }, '插件 Hook 清单读取失败，已隔离');
      this.recordFailure({
        actorId: context.actorId ?? null,
        action: 'plugin.hook.discovery-failed',
        targetId: null,
        hookName: name,
        errorCode: 'PLUGIN_DISCOVERY_FAILED',
      });
      return [];
    }

    const eligible = statuses.filter(
      (status) =>
        status.enabled &&
        status.approved &&
        status.manifest.types.includes('hook') &&
        (status.manifest.contributes.hooks ?? []).includes(name),
    );

    return Promise.all(
      eligible.map(async (status): Promise<HookRunResult> => {
        const startedAt = performance.now();
        try {
          await this.plugins.invoke(status.manifest.id, 'hook', name, safeInput);
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          this.logger.debug(
            { pluginId: status.manifest.id, hookName: name, durationMs },
            '插件 Hook 执行完成',
          );
          return {
            pluginId: status.manifest.id,
            success: true,
            durationMs,
            errorCode: null,
          };
        } catch (error) {
          const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          const errorCode = pluginErrorCode(error);
          this.logger.warn(
            { pluginId: status.manifest.id, hookName: name, durationMs, errorCode },
            '插件 Hook 执行失败，已隔离',
          );
          this.recordFailure({
            actorId: context.actorId ?? null,
            action: 'plugin.hook.failed',
            targetId: status.manifest.id,
            hookName: name,
            errorCode,
          });
          return {
            pluginId: status.manifest.id,
            success: false,
            durationMs,
            errorCode,
          };
        }
      }),
    );
  }

  private recordFailure(input: {
    actorId: string | null;
    action: string;
    targetId: string | null;
    hookName: ServerHookName;
    errorCode: string;
  }): void {
    try {
      this.audit.record({
        actorId: input.actorId,
        action: input.action,
        targetType: 'plugin',
        targetId: input.targetId,
        metadata: {
          hookName: input.hookName,
          errorCode: input.errorCode,
        },
      });
    } catch {
      this.logger.error(
        {
          pluginId: input.targetId,
          hookName: input.hookName,
          errorCode: input.errorCode,
        },
        '插件 Hook 审计写入失败',
      );
    }
  }
}
