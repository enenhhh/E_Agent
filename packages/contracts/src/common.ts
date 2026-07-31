import { z } from 'zod';

/** 所有对外资源使用的标识符。 */
export const resourceIdSchema = z.string().uuid();

/** ISO 8601 时间字符串。 */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const pageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'QUOTA_EXCEEDED',
  'QUEUE_FULL',
  'INTERNAL_ERROR',
]);

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string().min(1),
    retryable: z.boolean().default(false),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const successSchema = z.object({ success: z.literal(true) });

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type PageInfo = z.infer<typeof pageInfoSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
