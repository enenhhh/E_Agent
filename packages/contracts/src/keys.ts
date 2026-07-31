import { z } from 'zod';

import { isoDateTimeSchema, resourceIdSchema } from './common.js';
import { providerTypeSchema, type ProviderType } from './models.js';

export const keyStrategySchema = z.enum(['round-robin', 'priority']);
export const keyHealthSchema = z.enum(['unknown', 'healthy', 'warning', 'unhealthy', 'paused']);
export const quotaUnitSchema = z.enum(['usd', 'tokens']);
const sensitiveQueryName = /(?:api[-_]?key|token|secret|password|authorization)/i;
const httpUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '仅支持不含片段的 HTTP(S) 地址',
      });
    }
  });
const providerBaseUrlSchema = httpUrlSchema.superRefine((value, context) => {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '提供商地址不能包含明文凭据',
    });
  }
  for (const name of url.searchParams.keys()) {
    if (sensitiveQueryName.test(name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '提供商地址不能在查询参数中包含凭据',
      });
      break;
    }
  }
});
const proxyUrlSchema = httpUrlSchema.superRefine((value, context) => {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search !== '') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '代理地址不能包含路径或查询参数',
    });
  }
});

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

/**
 * 判断 Provider 传输地址是否满足安全基线。
 *
 * 云端和自定义 Provider 必须使用 HTTPS；仅 Ollama 可通过 HTTP 访问本机回环地址，
 * 防止 API Key 被明文发送到远端或把协作服务变成通用内网请求入口。
 */
export function isAllowedProviderBaseUrl(type: ProviderType, value: string): boolean {
  if (value.length > 4_096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  for (const name of url.searchParams.keys()) {
    if (sensitiveQueryName.test(name)) return false;
  }
  if (url.protocol === 'https:') return true;
  return type === 'ollama' && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

function validateProviderTransport(
  type: ProviderType,
  baseUrl: string,
  context: z.RefinementCtx,
): void {
  if (!isAllowedProviderBaseUrl(type, baseUrl)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseUrl'],
      message: '云端提供商必须使用 HTTPS；HTTP 仅允许 Ollama 的本机回环地址',
    });
  }
}

export const providerSchema = z.object({
  id: resourceIdSchema,
  type: providerTypeSchema,
  name: z.string().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  enabled: z.boolean(),
  keyStrategy: keyStrategySchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const apiKeySummarySchema = z.object({
  id: resourceIdSchema,
  providerId: resourceIdSchema,
  label: z.string().min(1).max(120),
  maskedKey: z.string().min(4),
  priority: z.number().int().min(0).max(10_000),
  health: keyHealthSchema,
  enabled: z.boolean(),
  pausedReason: z.string().nullable(),
  dailyLimit: z.number().positive().nullable(),
  monthlyLimit: z.number().positive().nullable(),
  quotaUnit: quotaUnitSchema,
  todayUsed: z.number().nonnegative(),
  monthUsed: z.number().nonnegative(),
  proxyConfigured: z.boolean(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const providerInputSchema = z.object({
  type: providerTypeSchema,
  name: z.string().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  keyStrategy: keyStrategySchema.default('round-robin'),
});

export const createProviderRequestSchema = providerInputSchema.superRefine((input, context) => {
  validateProviderTransport(input.type, input.baseUrl, context);
});

export const updateProviderRequestSchema = providerInputSchema
  .extend({ enabled: z.boolean() })
  .partial()
  .superRefine((input, context) => {
    if (input.type !== undefined && input.baseUrl !== undefined) {
      validateProviderTransport(input.type, input.baseUrl, context);
      return;
    }
    if (input.baseUrl !== undefined) {
      const url = new URL(input.baseUrl);
      if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'HTTP 提供商地址只能使用本机回环地址',
        });
      }
    }
  });

export const createApiKeyRequestSchema = z.object({
  providerId: resourceIdSchema,
  label: z.string().min(1).max(120),
  apiKey: z.string().min(8).max(4096),
  priority: z.number().int().min(0).max(10_000).default(100),
  dailyLimit: z.number().positive().nullable().default(null),
  monthlyLimit: z.number().positive().nullable().default(null),
  quotaUnit: quotaUnitSchema.default('usd'),
  proxyUrl: proxyUrlSchema.nullable().default(null),
});

export const updateApiKeyRequestSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(8).max(4096).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  dailyLimit: z.number().positive().nullable().optional(),
  monthlyLimit: z.number().positive().nullable().optional(),
  quotaUnit: quotaUnitSchema.optional(),
  proxyUrl: proxyUrlSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const keyListResponseSchema = z.object({
  providers: z.array(providerSchema),
  keys: z.array(apiKeySummarySchema),
  totals: z.object({
    available: z.number().int().nonnegative(),
    todayUsed: z.number().nonnegative(),
    monthUsed: z.number().nonnegative(),
  }),
});

export const apiKeyHealthCheckSchema = z.object({
  id: resourceIdSchema,
  health: z.enum(['healthy', 'warning', 'unhealthy']),
  latencyMs: z.number().int().nonnegative(),
  checkedAt: isoDateTimeSchema,
  error: z.string().nullable(),
});

/**
 * 单 Key 健康检查同时返回刷新后的 Key 摘要。
 *
 * 顶层诊断字段兼容只消费健康检查结果的客户端，完整 Key 字段则避免客户端
 * 为刷新状态额外发起一次列表请求。
 */
export const apiKeyHealthCheckResponseSchema = apiKeySummarySchema.extend({
  latencyMs: z.number().int().nonnegative(),
  checkedAt: isoDateTimeSchema,
  error: z.string().nullable(),
});

export const apiKeyHealthCheckAllResponseSchema = z.object({
  results: z.array(apiKeyHealthCheckSchema),
  keys: z.array(apiKeySummarySchema),
});

export type KeyStrategy = z.infer<typeof keyStrategySchema>;
export type KeyHealth = z.infer<typeof keyHealthSchema>;
export type QuotaUnit = z.infer<typeof quotaUnitSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type UpdateApiKeyRequest = z.infer<typeof updateApiKeyRequestSchema>;
export type KeyListResponse = z.infer<typeof keyListResponseSchema>;
export type ApiKeyHealthCheck = z.infer<typeof apiKeyHealthCheckSchema>;
export type ApiKeyHealthCheckResponse = z.infer<typeof apiKeyHealthCheckResponseSchema>;
export type ApiKeyHealthCheckAllResponse = z.infer<typeof apiKeyHealthCheckAllResponseSchema>;
