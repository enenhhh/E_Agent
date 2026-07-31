import { z } from 'zod';

import { pluginManifestSchema } from './manifest.js';

const jsonValueSchema: z.ZodType<unknown> = z.json();

export const hostRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('initialize'),
      requestId: z.string().min(1),
      manifest: pluginManifestSchema,
      dataDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('invoke'),
      requestId: z.string().min(1),
      target: z.enum(['command', 'hook', 'provider']),
      id: z.string().min(1),
      input: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('deactivate'),
      requestId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('capability-result'),
      requestId: z.string().min(1),
      capabilityRequestId: z.string().min(1),
      ok: z.boolean(),
      value: jsonValueSchema.optional(),
      error: z.string().max(2_000).optional(),
    })
    .strict(),
]);

export const hostEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('response'),
      requestId: z.string().min(1),
      ok: z.boolean(),
      value: jsonValueSchema.optional(),
      error: z.string().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('registration'),
      target: z.enum(['command', 'hook', 'provider']),
      id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('capability-request'),
      capabilityRequestId: z.string().min(1),
      capability: z.enum([
        'network.request',
        'fileSystem.readText',
        'fileSystem.writeText',
        'fileSystem.list',
        'env.get',
        'notifications.show',
      ]),
      input: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('log'),
      level: z.enum(['debug', 'error', 'info', 'warn']),
      message: z.string().max(5_000),
      fields: z.record(z.string(), jsonValueSchema).optional(),
    })
    .strict(),
]);

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostEvent = z.infer<typeof hostEventSchema>;

/**
 * 校验发送给插件宿主的 IPC 消息。
 */
export function parseHostRequest(value: unknown): HostRequest {
  return hostRequestSchema.parse(value);
}

/**
 * 校验插件宿主发回的 IPC 消息。
 */
export function parseHostEvent(value: unknown): HostEvent {
  return hostEventSchema.parse(value);
}
