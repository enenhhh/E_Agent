import { z } from 'zod';

import { resourceIdSchema } from './common.js';

export const appSettingsSchema = z.object({
  language: z.enum(['system', 'zh-CN', 'en-US']).default('system'),
  theme: z.string().min(1).default('system'),
  maxConcurrentRequests: z.number().int().min(1).max(32).default(5),
  dailyCostAlertUsd: z.number().positive().default(5),
  contextCompressionThreshold: z.number().min(0.5).max(0.9).default(0.7),
  contextCompressionModelId: resourceIdSchema.nullable().default(null),
  desktopNotifications: z.boolean().default(true),
  autoSnapshotInterval: z.number().int().min(10).max(500).default(50),
  toolExecutionPolicy: z.enum(['always-ask', 'allow-safe', 'disabled']).default('always-ask'),
  toolCommandTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  toolOutputLimitBytes: z.number().int().min(4_096).max(1_048_576).default(131_072),
  defaultModels: z
    .object({
      code: resourceIdSchema.nullable().default(null),
      chat: resourceIdSchema.nullable().default(null),
      embedding: resourceIdSchema.nullable().default(null),
      vision: resourceIdSchema.nullable().default(null),
    })
    .default({}),
});

export const updateSettingsRequestSchema = appSettingsSchema.partial().extend({
  defaultModels: z
    .object({
      code: resourceIdSchema.nullable().optional(),
      chat: resourceIdSchema.nullable().optional(),
      embedding: resourceIdSchema.nullable().optional(),
      vision: resourceIdSchema.nullable().optional(),
    })
    .optional(),
});

export const contextBreakdownSchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive(),
  utilization: z.number().min(0),
  compressed: z.boolean(),
  sources: z.array(
    z.object({
      source: z.enum(['system', 'history', 'file', 'folder', 'web', 'memory']),
      tokens: z.number().int().nonnegative(),
      percentage: z.number().min(0).max(100),
    }),
  ),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;
