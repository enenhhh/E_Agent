import { z } from 'zod';

const identifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9]*(?:[.-][a-z0-9]+)+$/, '标识符必须使用反向域名或带短横线的小写格式');

const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\\'), '清单路径必须使用正斜杠')
  .refine((value) => !value.startsWith('/'), '清单路径必须是相对路径')
  .refine((value) => !value.split('/').includes('..'), '清单路径不能逃逸插件目录');

const networkHostSchema = z
  .string()
  .max(255)
  .regex(
    /^(?:\*\.)?(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::\d{1,5})?$/i,
    '网络权限必须是主机名，可使用 *.example.com 通配子域',
  );

const commandContributionSchema = z
  .object({
    id: identifierSchema,
    title: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    skill: identifierSchema.optional(),
  })
  .strict();

const skillContributionSchema = z
  .object({
    id: identifierSchema,
    definition: relativePathSchema,
  })
  .strict();

const providerContributionSchema = z
  .object({
    id: identifierSchema,
    displayName: z.string().min(1).max(80),
  })
  .strict();

const uiContributionSchema = z
  .object({
    location: z.enum(['sidebar', 'toolbar', 'context-menu']),
    command: identifierSchema,
    title: z.string().min(1).max(80),
    icon: relativePathSchema.optional(),
  })
  .strict();

/**
 * 插件清单的运行时校验器。
 *
 * 权限均为显式白名单；未声明的能力由宿主默认拒绝。子进程隔离用于降低故障影响，
 * 不是对恶意 Node.js 代码的绝对安全边界。
 */
export const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    name: z.string().min(1).max(80),
    version: z
      .string()
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
        'version 必须是语义化版本',
      ),
    description: z.string().min(1).max(500),
    publisher: z.string().min(1).max(80),
    entry: relativePathSchema,
    engines: z
      .object({
        eAgent: z.string().min(1).max(64),
        node: z.string().min(1).max(64).optional(),
      })
      .strict(),
    types: z
      .array(z.enum(['ui', 'hook', 'provider', 'tool']))
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length, {
        message: '插件类型不能重复',
      }),
    permissions: z
      .object({
        network: z
          .object({
            hosts: z.array(networkHostSchema).max(32),
          })
          .strict()
          .optional(),
        fileSystem: z
          .object({
            read: z.array(z.string().min(1).max(512)).max(32).default([]),
            write: z.array(z.string().min(1).max(512)).max(32).default([]),
          })
          .strict()
          .optional(),
        env: z
          .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
          .max(32)
          .optional(),
        notifications: z.boolean().optional(),
      })
      .strict()
      .default({}),
    contributes: z
      .object({
        commands: z.array(commandContributionSchema).max(64).optional(),
        skills: z.array(skillContributionSchema).max(32).optional(),
        hooks: z
          .array(
            z.enum([
              'request:before',
              'request:after',
              'file:before-save',
              'file:after-save',
              'session:created',
              'session:closed',
            ]),
          )
          .max(16)
          .optional(),
        providers: z.array(providerContributionSchema).max(16).optional(),
        ui: z.array(uiContributionSchema).max(32).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginPermissionRequest = PluginManifest['permissions'];
export type PluginHookName = NonNullable<PluginManifest['contributes']['hooks']>[number];

/**
 * 对未知 JSON 值执行严格的插件清单校验。
 */
export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}
