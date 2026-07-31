import { z } from 'zod';

import { isoDateTimeSchema, paginationQuerySchema, resourceIdSchema } from './common.js';

export const auditLogSchema = z.object({
  id: resourceIdSchema,
  actorId: resourceIdSchema.nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipAddress: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

export const auditQuerySchema = paginationQuerySchema.extend({
  action: z.string().optional(),
  targetType: z.string().optional(),
});

export type AuditLog = z.infer<typeof auditLogSchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
