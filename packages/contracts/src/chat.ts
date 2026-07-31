import { z } from 'zod';

import { isoDateTimeSchema, resourceIdSchema } from './common.js';

export const chatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const chatContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    imageUrl: z.object({
      url: z.string().url(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

export const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

export const chatMessageInputSchema = z.object({
  role: chatRoleSchema,
  content: z.union([z.string(), z.array(chatContentPartSchema)]),
  name: z.string().min(1).max(128).optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});

export const chatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().max(2048).optional(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

export const chatSkillReferenceSchema = z.union([
  z.string().regex(/^@[a-z][a-z0-9-]{1,48}$/),
  z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
]);

export const contextMentionSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^@(file|folder|web|skill):(?:"[^"]+"|[^\s]+)$/u);

export const sendChatRequestSchema = z
  .object({
    conversationId: resourceIdSchema.optional(),
    userMessageId: resourceIdSchema.optional(),
    projectId: resourceIdSchema.optional(),
    modelId: resourceIdSchema.optional(),
    model: z.string().min(1).max(256).optional(),
    providerId: resourceIdSchema.optional(),
    messages: z.array(chatMessageInputSchema).min(1).max(500),
    tools: z.array(chatToolSchema).max(64).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(262_144).optional(),
    skill: chatSkillReferenceSchema.optional(),
    contextMentions: z.array(contextMentionSchema).max(32).optional(),
    stream: z.boolean().default(true),
    idempotencyKey: z.string().min(8).max(128).optional(),
    cancellationId: resourceIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.userMessageId !== undefined && value.messages.at(-1)?.role !== 'user') {
      context.addIssue({
        code: 'custom',
        path: ['userMessageId'],
        message: 'userMessageId 只能标识请求末尾的用户消息',
      });
    }
    if (value.cancellationId !== undefined && !value.stream) {
      context.addIssue({
        code: 'custom',
        path: ['cancellationId'],
        message: 'cancellationId 只能用于流式请求',
      });
    }
  });

export const chatUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().default(0),
  estimatedCostUsd: z.number().nonnegative(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('queue'),
    position: z.number().int().positive().nullable(),
    active: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('start'),
    requestId: z.string(),
    conversationId: resourceIdSchema,
    messageId: resourceIdSchema,
    model: z.string(),
    createdAt: isoDateTimeSchema,
  }),
  z.object({ type: z.literal('delta'), content: z.string() }),
  z.object({ type: z.literal('reasoning_delta'), content: z.string() }),
  z.object({
    type: z.literal('tool_call_delta'),
    index: z.number().int().nonnegative(),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    snapshot: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    usage: chatUsageSchema,
    durationMs: z.number().int().nonnegative(),
    reasoningDurationMs: z.number().int().nonnegative().optional(),
    cacheHit: z.boolean(),
  }),
  z.object({
    type: z.literal('done'),
    finishReason: z.string().nullable(),
    messageId: resourceIdSchema,
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

export const chatCompletionResponseSchema = z.object({
  requestId: z.string(),
  conversationId: resourceIdSchema,
  messageId: resourceIdSchema,
  model: z.string(),
  content: z.string(),
  reasoning: z.string().optional(),
  reasoningDurationMs: z.number().int().nonnegative().optional(),
  toolCalls: z.array(toolCallSchema).default([]),
  finishReason: z.string().nullable(),
  usage: chatUsageSchema,
  durationMs: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
});

/** Web 流式请求取消完成确认；settled 表示服务端生成器与持久化清理均已结束。 */
export const cancelChatStreamResponseSchema = z.object({
  cancellationId: resourceIdSchema,
  settled: z.literal(true),
});

export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatContentPart = z.infer<typeof chatContentPartSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;
export type ChatTool = z.infer<typeof chatToolSchema>;
export type ChatSkillReference = z.infer<typeof chatSkillReferenceSchema>;
export type ContextMention = z.infer<typeof contextMentionSchema>;
export type SendChatRequest = z.infer<typeof sendChatRequestSchema>;
export type ChatUsage = z.infer<typeof chatUsageSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;
export type CancelChatStreamResponse = z.infer<typeof cancelChatStreamResponseSchema>;
