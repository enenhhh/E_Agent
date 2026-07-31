import { z } from 'zod';

import { isoDateTimeSchema, resourceIdSchema } from './common.js';

export const providerTypeSchema = z.enum([
  'openai',
  'anthropic',
  'deepseek',
  'groq',
  'google',
  'ollama',
  'custom',
]);

export const modelCapabilitySchema = z.enum([
  'chat',
  'code',
  'embedding',
  'vision',
  'function-calling',
  'reasoning',
]);

export const modelSchema = z.object({
  id: resourceIdSchema,
  providerId: resourceIdSchema,
  provider: providerTypeSchema,
  providerName: z.string().min(1).max(120),
  remoteId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  capabilities: z.array(modelCapabilitySchema),
  contextWindow: z.number().int().positive().nullable(),
  inputPricePerMillion: z.number().nonnegative().nullable(),
  outputPricePerMillion: z.number().nonnegative().nullable(),
  configuredEnabled: z.boolean().optional(),
  enabled: z.boolean(),
  stale: z.boolean().default(false),
  discoveredAt: isoDateTimeSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const modelListResponseSchema = z.object({
  models: z.array(modelSchema),
  cachedAt: isoDateTimeSchema.nullable(),
});

export const discoverModelsRequestSchema = z.object({
  providerId: resourceIdSchema.optional(),
  force: z.boolean().default(false),
});

export const updateProviderModelSelectionRequestSchema = z
  .object({
    enabledModelIds: z.array(resourceIdSchema).max(5_000),
  })
  .superRefine((input, context) => {
    if (new Set(input.enabledModelIds).size !== input.enabledModelIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enabledModelIds'],
        message: '启用模型列表不能包含重复项',
      });
    }
  });

export const defaultModelGroupSchema = z.object({
  code: resourceIdSchema.nullable(),
  chat: resourceIdSchema.nullable(),
  embedding: resourceIdSchema.nullable(),
  vision: resourceIdSchema.nullable(),
});

export type ProviderType = z.infer<typeof providerTypeSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;
export type DiscoverModelsRequest = z.infer<typeof discoverModelsRequestSchema>;
export type UpdateProviderModelSelectionRequest = z.infer<
  typeof updateProviderModelSelectionRequestSchema
>;
export type DefaultModelGroup = z.infer<typeof defaultModelGroupSchema>;
