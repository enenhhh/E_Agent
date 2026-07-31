import { z } from 'zod';

import { chatRoleSchema, toolCallSchema } from './chat.js';
import {
  isoDateTimeSchema,
  pageInfoSchema,
  paginationQuerySchema,
  resourceIdSchema,
} from './common.js';

export const conversationMessageSchema = z.object({
  id: resourceIdSchema,
  conversationId: resourceIdSchema,
  parentMessageId: resourceIdSchema.nullable(),
  role: chatRoleSchema,
  content: z.string(),
  reasoning: z.string().nullable(),
  reasoningDurationMs: z.number().int().nonnegative().nullable().default(null),
  toolCalls: z.array(toolCallSchema),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  feedback: z.enum(['helpful', 'unhelpful']).nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export const conversationForkKindSchema = z.enum(['branch', 'retry', 'edit']);

export const conversationSchema = z.object({
  id: resourceIdSchema,
  projectId: resourceIdSchema.nullable(),
  userId: resourceIdSchema.nullable(),
  parentConversationId: resourceIdSchema.nullable(),
  branchedFromMessageId: resourceIdSchema.nullable(),
  forkKind: conversationForkKindSchema.nullable().default(null),
  originMessageId: resourceIdSchema.nullable().default(null),
  title: z.string().min(1).max(240),
  pinned: z.boolean(),
  archived: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const createConversationRequestSchema = z.object({
  projectId: resourceIdSchema.nullable().default(null),
  title: z.string().min(1).max(240).default('新对话'),
});

export const updateConversationRequestSchema = z
  .object({
    title: z.string().min(1).max(240).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少需要提供一个更新字段');

export const branchConversationRequestSchema = z
  .object({
    operationId: z.string().min(8).max(128).optional(),
    fromMessageId: resourceIdSchema,
    includeFromMessage: z.boolean().default(true),
    kind: conversationForkKindSchema.default('branch'),
    originMessageId: resourceIdSchema.optional(),
    title: z.string().min(1).max(240).optional(),
  })
  .superRefine((value, context) => {
    if (value.kind !== 'branch' && value.originMessageId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['originMessageId'],
        message: '重试或编辑分支必须声明来源消息',
      });
    }
  });

export const deleteMessageQuerySchema = z.object({
  operationId: z.string().min(8).max(128).optional(),
  expectedMessageCount: z.coerce.number().int().nonnegative(),
  expectedTailMessageId: resourceIdSchema,
});

export const messageFeedbackRequestSchema = z.object({
  feedback: z.enum(['helpful', 'unhelpful']).nullable(),
});

export const conversationListQuerySchema = paginationQuerySchema.extend({
  projectId: resourceIdSchema.optional(),
  archived: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  pageInfo: pageInfoSchema,
});

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(conversationMessageSchema),
});

export const snapshotSchema = z.object({
  id: resourceIdSchema,
  conversationId: resourceIdSchema,
  messageCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
});

export const deleteMessageResponseSchema = z.object({
  conversation: conversationSchema,
  snapshot: snapshotSchema,
  removedCount: z.number().int().positive(),
});

export const fileChangeStatusSchema = z.enum(['pending', 'accepted', 'rejected']);

export const fileChangeSchema = z.object({
  id: resourceIdSchema,
  conversationId: resourceIdSchema,
  path: z.string(),
  diff: z.string(),
  status: fileChangeStatusSchema,
  acceptedLines: z.array(z.number().int().positive()).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const createFileChangeRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value), '必须使用工作区相对路径')
    .refine(
      (value) => !value.replaceAll('\\', '/').split('/').includes('..'),
      '路径不能逃逸工作区',
    ),
  diff: z.string().min(1).max(2_000_000),
});

export const updateFileChangeRequestSchema = z.object({
  status: z.enum(['accepted', 'rejected']),
  acceptedLines: z.array(z.number().int().positive()).max(100_000).optional(),
});

export const decideFileChangeRequestSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  acceptedLines: z.array(z.number().int().positive()).max(100_000).optional(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;
export type BranchConversationRequest = z.infer<typeof branchConversationRequestSchema>;
export type ConversationForkKind = z.infer<typeof conversationForkKindSchema>;
export type DeleteMessageQuery = z.infer<typeof deleteMessageQuerySchema>;
export type DeleteMessageResponse = z.infer<typeof deleteMessageResponseSchema>;
export type MessageFeedbackRequest = z.infer<typeof messageFeedbackRequestSchema>;
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type FileChangeStatus = z.infer<typeof fileChangeStatusSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type CreateFileChangeRequest = z.infer<typeof createFileChangeRequestSchema>;
export type UpdateFileChangeRequest = z.infer<typeof updateFileChangeRequestSchema>;
export type DecideFileChangeRequest = z.infer<typeof decideFileChangeRequestSchema>;
