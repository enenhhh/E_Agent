import { z } from 'zod';

import { isoDateTimeSchema, resourceIdSchema } from './common.js';

export const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const userSchema = z.object({
  id: resourceIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: roleSchema,
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

export const registerRequestSchema = loginRequestSchema.extend({
  displayName: z.string().min(1).max(120),
});

export const createMemberRequestSchema = registerRequestSchema.extend({
  role: z.enum(['admin', 'member', 'viewer']),
});

export const updateMemberRequestSchema = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    role: z.enum(['admin', 'member', 'viewer']).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少提供一个要更新的字段',
  });

export const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: isoDateTimeSchema,
  user: userSchema,
});

export type Role = z.infer<typeof roleSchema>;
export type User = z.infer<typeof userSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
