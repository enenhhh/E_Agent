import { PluginRuntimeError, type PluginRuntime } from '@e-agent/plugin-runtime';
import type { JsonValue } from '@e-agent/plugin-sdk';
import { z } from 'zod';

import type { AppLogger } from './logger.js';

const actorSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
  })
  .strict();

const fileMetadataSchema = z
  .object({
    relativePath: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.startsWith('/') && !value.includes('\\'), {
        message: 'Hook 文件路径必须是使用正斜杠的相对路径',
      })
      .refine((value) => !value.split('/').includes('..'), {
        message: 'Hook 文件路径不能逃逸工作区',
      }),
    byteLength: z.number().int().nonnegative().max(10_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    changeId: z.string().uuid(),
  })
  .strict();

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    occurredAt: z.string().datetime({ offset: true }),
    requestId: z.string().uuid(),
    actor: actorSchema.nullable(),
    operation: z.literal('workspace.file-save'),
    file: fileMetadataSchema,
  })
  .strict();

const hookPayloadSchemas = {
  'file:before-save': envelopeSchema,
  'file:after-save': envelopeSchema
    .extend({
      outcome: z
        .object({
          success: z.boolean(),
          durationMs: z.number().int().nonnegative(),
          errorCode: z.string().min(1).max(64).nullable(),
        })
        .strict(),
    })
    .strict(),
} as const;

export type DesktopFileHookName = keyof typeof hookPayloadSchemas;
export type DesktopFileHookPayloadMap = {
  [Name in DesktopFileHookName]: z.infer<(typeof hookPayloadSchemas)[Name]>;
};

type PluginRuntimePort = Pick<PluginRuntime, 'invoke' | 'list'>;

/**
 * 在桌面主进程中触发文件保存 Hook。
 *
 * 只有已启用、已授权并在清单中声明对应 Hook 的插件会收到事件。事件只包含
 * 工作区相对路径、字节数和哈希等元数据；插件异常被隔离，不能阻断用户批准的写入。
 */
export class DesktopPluginHookRunner {
  public constructor(
    private readonly plugins: PluginRuntimePort,
    private readonly logger: AppLogger,
  ) {}

  public async run<Name extends DesktopFileHookName>(
    name: Name,
    payload: DesktopFileHookPayloadMap[Name],
  ): Promise<void> {
    const safeInput = hookPayloadSchemas[name].parse(payload) as JsonValue;
    let statuses: Awaited<ReturnType<PluginRuntimePort['list']>>;
    try {
      statuses = await this.plugins.list();
    } catch {
      this.logger.error('桌面文件 Hook 清单读取失败，已隔离', { hookName: name });
      return;
    }

    const eligible = statuses.filter(
      (status) =>
        status.enabled &&
        status.approved &&
        status.manifest.types.includes('hook') &&
        (status.manifest.contributes.hooks ?? []).includes(name),
    );

    await Promise.all(
      eligible.map(async (status) => {
        const startedAt = performance.now();
        try {
          await this.plugins.invoke(status.manifest.id, 'hook', name, safeInput);
          this.logger.debug('桌面文件 Hook 执行完成', {
            pluginId: status.manifest.id,
            hookName: name,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          });
        } catch (error) {
          this.logger.warn('桌面文件 Hook 执行失败，已隔离', {
            pluginId: status.manifest.id,
            hookName: name,
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            errorCode: error instanceof PluginRuntimeError ? error.code : 'HOOK_FAILED',
          });
        }
      }),
    );
  }
}
