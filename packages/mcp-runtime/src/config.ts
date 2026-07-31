import { z } from 'zod';

import { McpRuntimeError } from './errors.js';

const serverIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u, '服务器 ID 必须使用小写字母、数字、点或短横线');
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const safeStringSchema = z.string().refine(
  (value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== 0 && code !== 10 && code !== 13;
    }),
  '值包含非法控制字符',
);
const processValueSchema = z.string().refine((value) => !value.includes('\0'), '值包含 NUL 字符');
const headerNameSchema = z
  .string()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u)
  .refine(
    (value) =>
      ![
        'connection',
        'content-length',
        'content-type',
        'host',
        'mcp-protocol-version',
        'mcp-session-id',
        'transfer-encoding',
      ].includes(value.toLowerCase()),
    '该请求头由 MCP 运行时管理',
  );
const headersSchema = z
  .record(z.string(), safeStringSchema.max(32_768))
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers)) {
      const parsed = headerNameSchema.safeParse(name);
      if (!parsed.success) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: parsed.error.issues[0]?.message ?? '请求头名称无效',
        });
      }
    }
  });

const toolPolicySchema = z
  .object({
    allow: z.array(z.string().min(1).max(128)).max(256).optional(),
    deny: z.array(z.string().min(1).max(128)).max(256).optional(),
  })
  .strict()
  .refine(
    (value) => value.allow === undefined || value.deny === undefined,
    'allow 与 deny 不能同时配置',
  );

const stdioTransportSchema = z
  .object({
    type: z.literal('stdio'),
    command: safeStringSchema.pipe(z.string().min(1).max(2_048)),
    args: z
      .array(processValueSchema.pipe(z.string().max(8_192)))
      .max(256)
      .default([]),
    cwd: safeStringSchema.pipe(z.string().min(1).max(4_096)).optional(),
    env: z.record(environmentNameSchema, processValueSchema.max(32_768)).default({}),
    inheritEnv: z.array(environmentNameSchema).max(128).default([]),
    shutdownGraceMs: z.number().int().min(0).max(10_000).default(1_000),
  })
  .strict();

const streamableHttpTransportSchema = z
  .object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    headers: headersSchema.default({}),
    allowInsecureHttp: z.boolean().default(false),
    openEventStream: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({ code: 'custom', message: 'MCP 地址只支持 HTTP 或 HTTPS' });
      return;
    }
    const local =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1';
    if (url.protocol === 'http:' && !local && !value.allowInsecureHttp) {
      context.addIssue({
        code: 'custom',
        message: '远程 MCP 服务必须使用 HTTPS；仅 localhost 可默认使用 HTTP',
      });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'MCP 地址不能内嵌用户名或密码' });
    }
  });

export const mcpServerConfigSchema = z
  .object({
    id: serverIdSchema,
    displayName: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion('type', [stdioTransportSchema, streamableHttpTransportSchema]),
    connectTimeoutMs: z.number().int().min(500).max(120_000).default(10_000),
    requestTimeoutMs: z.number().int().min(500).max(600_000).default(30_000),
    maxMessageBytes: z
      .number()
      .int()
      .min(64 * 1_024)
      .max(32 * 1_024 * 1_024)
      .default(4 * 1_024 * 1_024),
    maxConcurrentCalls: z.number().int().min(1).max(32).default(4),
    toolPolicy: toolPolicySchema.optional(),
  })
  .strict();

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type StdioMcpTransportConfig = Extract<McpServerConfig['transport'], { type: 'stdio' }>;
export type StreamableHttpMcpTransportConfig = Extract<
  McpServerConfig['transport'],
  { type: 'streamable-http' }
>;

/** 校验并填充单个 MCP 服务配置的生产默认值。 */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  const parsed = mcpServerConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpRuntimeError(
      'CONFIG_INVALID',
      parsed.error.issues[0]?.message ?? 'MCP 服务配置无效。',
    );
  }
  return parsed.data;
}

/** 批量校验配置，并拒绝会导致工具路由歧义的重复 ID。 */
export function parseMcpServerConfigs(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) {
    throw new McpRuntimeError('CONFIG_INVALID', 'MCP 服务配置必须是数组。');
  }
  if (value.length > 64) {
    throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP Server 数量不能超过 64 个。');
  }
  const configs = value.map(parseMcpServerConfig);
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.id)) {
      throw new McpRuntimeError('CONFIG_INVALID', `MCP 服务 ID 重复：${config.id}`);
    }
    seen.add(config.id);
  }
  return configs;
}
