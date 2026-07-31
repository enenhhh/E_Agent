import { z } from 'zod';

import { isoDateTimeSchema, paginationQuerySchema, resourceIdSchema } from './common.js';

export const usageRecordSchema = z.object({
  id: resourceIdSchema,
  occurredAt: isoDateTimeSchema,
  userId: resourceIdSchema.nullable(),
  projectId: resourceIdSchema.nullable(),
  conversationId: resourceIdSchema.nullable(),
  providerId: resourceIdSchema,
  apiKeyId: resourceIdSchema.nullable(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
  successful: z.boolean(),
  errorCode: z.string().nullable(),
});

export const usageQuerySchema = paginationQuerySchema.extend({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  projectId: resourceIdSchema.optional(),
  userId: resourceIdSchema.optional(),
  model: z.string().optional(),
  groupBy: z.enum(['hour', 'day', 'week', 'month', 'model', 'project', 'user']).default('day'),
});

export const usageBucketSchema = z.object({
  key: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  averageDurationMs: z.number().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});

export const usageSummarySchema = z.object({
  totals: usageBucketSchema.omit({ key: true }),
  buckets: z.array(usageBucketSchema),
  costAlert: z.object({
    thresholdUsd: z.number().positive(),
    currentUsd: z.number().nonnegative(),
    exceeded: z.boolean(),
  }),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type UsageBucket = z.infer<typeof usageBucketSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
