import { z } from 'zod';

const relativeWorkspacePathSchema = z
  .string()
  .max(2_048)
  .refine((value) => !value.includes('\0'), '路径包含非法字符')
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value), '必须使用工作区相对路径');

const jsonValueSchema: z.ZodType<unknown> = z.json();

export const desktopInvokeSchemas = {
  'system:self-check': z.object({}).strict(),
  'system:notify': z
    .object({
      title: z.string().min(1).max(120),
      body: z.string().max(1_000),
    })
    .strict(),
  'system:open-external': z.object({ url: z.string().url().max(2_048) }).strict(),
  'window:minimize': z.object({}).strict(),
  'window:toggle-maximize': z.object({}).strict(),
  'window:close': z.object({}).strict(),
  'workspace:choose': z.object({}).strict(),
  'workspace:get-binding': z.object({}).strict(),
  'workspace:list': z
    .object({
      path: relativeWorkspacePathSchema.default(''),
      depth: z.number().int().min(0).max(5).default(2),
    })
    .strict(),
  'workspace:read': z
    .object({
      path: relativeWorkspacePathSchema,
      maximumBytes: z.number().int().min(1).max(10_000_000).optional(),
    })
    .strict(),
  'workspace:propose-write': z
    .object({
      path: relativeWorkspacePathSchema,
      content: z.string().max(10_000_000),
      expectedHash: z.string().length(64).optional(),
    })
    .strict(),
  'workspace:list-proposals': z.object({}).strict(),
  'workspace:apply-proposal': z
    .object({
      proposalId: z.string().uuid(),
      acceptedChangeIds: z.array(z.string().uuid()).max(100_000).optional(),
    })
    .strict(),
  'workspace:reject-proposal': z.object({ proposalId: z.string().uuid() }).strict(),
  'plugins:list': z.object({}).strict(),
  'plugins:install': z
    .discriminatedUnion('type', [
      z
        .object({
          type: z.literal('directory'),
          path: z.string().min(1).max(2_048),
        })
        .strict(),
      z
        .object({
          type: z.literal('git'),
          url: z.string().url().max(2_048),
          ref: z.string().min(1).max(255).optional(),
        })
        .strict(),
    ])
    .or(
      z
        .object({
          source: z.string().min(1).max(2_048),
        })
        .strict(),
    ),
  'plugins:approve': z.object({ pluginId: z.string().min(1).max(128) }).strict(),
  'plugins:revoke': z.object({ pluginId: z.string().min(1).max(128) }).strict(),
  'plugins:enable': z.object({ pluginId: z.string().min(1).max(128) }).strict(),
  'plugins:disable': z.object({ pluginId: z.string().min(1).max(128) }).strict(),
  'plugins:uninstall': z.union([
    z.object({ pluginId: z.string().min(1).max(128) }).strict(),
    z.object({ id: z.string().min(1).max(128) }).strict(),
  ]),
  'plugins:invoke': z
    .object({
      pluginId: z.string().min(1).max(128),
      target: z.enum(['command', 'hook', 'provider']),
      id: z.string().min(1).max(128),
      input: jsonValueSchema,
    })
    .strict(),
  'updates:check': z.object({}).strict(),
  'updates:download': z.object({}).strict(),
  'updates:install': z.object({}).strict(),
} as const;

export type DesktopInvokeChannel = keyof typeof desktopInvokeSchemas;
export const desktopInvokeChannels = Object.freeze(
  Object.keys(desktopInvokeSchemas) as DesktopInvokeChannel[],
);

export const desktopEventChannels = [
  'plugins:changed',
  'updates:status',
  'workspace:changed',
] as const;
export type DesktopEventChannel = (typeof desktopEventChannels)[number];

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export interface IpcFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type IpcResult<T> = IpcFailure | IpcSuccess<T>;

/**
 * 验证指定通道的输入；通道名本身也必须位于静态白名单。
 */
export function parseDesktopInvokeInput(channel: DesktopInvokeChannel, input: unknown): unknown {
  return desktopInvokeSchemas[channel].parse(input);
}
