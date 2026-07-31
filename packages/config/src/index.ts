import { resolve } from 'node:path';

import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    E_AGENT_HOST: z.string().min(1).default('127.0.0.1'),
    E_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(4318),
    E_AGENT_DATABASE_URL: z.string().min(1).default('./data/e-agent.db'),
    E_AGENT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    E_AGENT_LOG_DIR: z.string().min(1).default('./logs'),
    E_AGENT_SESSION_SECRET: z.string().min(32).default('development-only-session-secret-change-me'),
    E_AGENT_MASTER_KEY: z.string().min(32).optional(),
    E_AGENT_BOOTSTRAP_TOKEN: z.string().min(32).or(z.literal('')).default(''),
    E_AGENT_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
    E_AGENT_PROVIDER_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    E_AGENT_DEFAULT_MODEL: z.string().default(''),
    E_AGENT_OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
    E_AGENT_SMTP_HOST: z.string().default(''),
    E_AGENT_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    E_AGENT_SMTP_USERNAME: z.string().default(''),
    E_AGENT_SMTP_PASSWORD: z.string().default(''),
    E_AGENT_OTEL_EXPORTER_URL: z.string().url().or(z.literal('')).default(''),
    E_AGENT_TRUST_PROXY: booleanFromEnvironment,
    E_AGENT_AUTH_DISABLED: booleanFromEnvironment,
    E_AGENT_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(20_000_000).default(2_000_000),
    E_AGENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    E_AGENT_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.E_AGENT_MASTER_KEY === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['E_AGENT_MASTER_KEY'],
        message: '生产环境必须配置 E_AGENT_MASTER_KEY',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.E_AGENT_SESSION_SECRET.startsWith('development-only')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['E_AGENT_SESSION_SECRET'],
        message: '生产环境必须更换会话签名密钥',
      });
    }
    if (environment.NODE_ENV === 'production' && environment.E_AGENT_AUTH_DISABLED) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['E_AGENT_AUTH_DISABLED'],
        message: '生产环境禁止关闭认证',
      });
    }
  });

export interface EAgentConfig {
  environment: 'development' | 'test' | 'production';
  server: {
    host: string;
    port: number;
    allowedOrigins: readonly string[];
    trustProxy: boolean;
    authDisabled: boolean;
    maxBodyBytes: number;
    requestTimeoutMs: number;
    shutdownTimeoutMs: number;
  };
  database: {
    url: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    directory: string;
  };
  security: {
    sessionSecret: string;
    masterKey: string;
    bootstrapToken: string | null;
  };
  providers: {
    defaultBaseUrl: string;
    defaultModel: string | null;
    ollamaUrl: string;
  };
  smtp: {
    host: string | null;
    port: number;
    username: string | null;
    password: string | null;
  };
  telemetry: {
    exporterUrl: string | null;
  };
}

/** 将空字符串规范化为 null，防止下游误把空配置当成有效凭据。 */
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读取并严格校验运行配置。 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): EAgentConfig {
  const parsed = environmentSchema.parse(environment);
  const databaseUrl =
    parsed.E_AGENT_DATABASE_URL === ':memory:'
      ? ':memory:'
      : resolve(cwd, parsed.E_AGENT_DATABASE_URL.replace(/^file:/, ''));
  const configuredMasterKey = parsed.E_AGENT_MASTER_KEY ?? parsed.E_AGENT_SESSION_SECRET;

  return {
    environment: parsed.NODE_ENV,
    server: {
      host: parsed.E_AGENT_HOST,
      port: parsed.E_AGENT_PORT,
      allowedOrigins: parsed.E_AGENT_ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      trustProxy: parsed.E_AGENT_TRUST_PROXY,
      authDisabled: parsed.E_AGENT_AUTH_DISABLED,
      maxBodyBytes: parsed.E_AGENT_MAX_BODY_BYTES,
      requestTimeoutMs: parsed.E_AGENT_REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: parsed.E_AGENT_SHUTDOWN_TIMEOUT_MS,
    },
    database: { url: databaseUrl },
    logging: {
      level: parsed.E_AGENT_LOG_LEVEL,
      directory: resolve(cwd, parsed.E_AGENT_LOG_DIR),
    },
    security: {
      sessionSecret: parsed.E_AGENT_SESSION_SECRET,
      masterKey: configuredMasterKey,
      bootstrapToken: nullable(parsed.E_AGENT_BOOTSTRAP_TOKEN),
    },
    providers: {
      defaultBaseUrl: parsed.E_AGENT_PROVIDER_BASE_URL.replace(/\/+$/, ''),
      defaultModel: nullable(parsed.E_AGENT_DEFAULT_MODEL),
      ollamaUrl: parsed.E_AGENT_OLLAMA_URL.replace(/\/+$/, ''),
    },
    smtp: {
      host: nullable(parsed.E_AGENT_SMTP_HOST),
      port: parsed.E_AGENT_SMTP_PORT,
      username: nullable(parsed.E_AGENT_SMTP_USERNAME),
      password: nullable(parsed.E_AGENT_SMTP_PASSWORD),
    },
    telemetry: {
      exporterUrl: nullable(parsed.E_AGENT_OTEL_EXPORTER_URL),
    },
  };
}

export { environmentSchema };
