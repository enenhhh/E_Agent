import { ProviderError } from '@e-agent/ai-runtime';
import { type EAgentConfig, loadConfig } from '@e-agent/config';
import { apiErrorSchema } from '@e-agent/contracts';
import {
  bootstrapDefaultProviders,
  createCoreServices,
  DomainError,
  type ChatClientFactory,
  type CoreServices,
} from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger, metrics, recordHttpRequest, type AppLogger } from '@e-agent/observability';
import { RevocableTokenService } from '@e-agent/security';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { registerAuthentication } from './auth.js';
import { initializeExtensions } from './extensions.js';
import type { ExtensionServices } from './extensions.js';
import { registerRoutes } from './routes/index.js';
import './types.js';

export interface BuildServerOptions {
  config?: EAgentConfig;
  database?: DatabaseContext;
  services?: CoreServices;
  logger?: AppLogger;
  chatClientFactory?: ChatClientFactory;
  extensions?: ExtensionServices;
}

/** 在创建数据库、日志或网络监听器前拒绝不安全的生产认证配置。 */
function assertProductionAuthenticationEnabled(config: EAgentConfig): void {
  if (config.environment === 'production' && config.server.authDisabled) {
    throw new Error('安全配置无效：生产环境禁止 E_AGENT_AUTH_DISABLED=true');
  }
}

/** 构建可注入测试的 Fastify 服务，不在此函数内监听端口。 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  assertProductionAuthenticationEnabled(config);
  const logger =
    options.logger ??
    createLogger({
      level: config.logging.level,
      ...(config.environment === 'test' ? {} : { directory: config.logging.directory }),
      service: 'e-agent-server',
    });
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openDatabase({ url: config.database.url });
  const services =
    options.services ??
    createCoreServices({
      database,
      masterKey: config.security.masterKey,
      sessionSecret: config.security.sessionSecret,
      logger,
      systemPromptSurface: 'web',
      ...(options.chatClientFactory === undefined
        ? {}
        : { chatClientFactory: options.chatClientFactory }),
    });
  const authTokens = new RevocableTokenService(
    config.security.sessionSecret,
    services.repositories.revokedTokens,
  );
  authTokens.purgeExpired();
  bootstrapDefaultProviders(services.repositories, {
    openAiBaseUrl: config.providers.defaultBaseUrl,
    ollamaUrl: config.providers.ollamaUrl,
  });

  const app: FastifyInstance = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config.server.maxBodyBytes,
    requestTimeout: config.server.requestTimeoutMs,
    trustProxy: config.server.trustProxy,
    genReqId: (request) =>
      typeof request.headers['x-request-id'] === 'string'
        ? request.headers['x-request-id'].slice(0, 128)
        : crypto.randomUUID(),
  });
  app.decorate('eAgent', {
    services,
    database,
    extensions: options.extensions ?? null,
    authTokens,
  });

  await app.register(cors, {
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (origin === undefined || config.server.allowedOrigins.includes(origin))
        callback(null, true);
      else callback(new DomainError('FORBIDDEN', '该来源未获授权'), false);
    },
    credentials: true,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    ban: 3,
    keyGenerator: (request) => request.actor?.id ?? request.ip,
  });

  registerAuthentication(app, {
    environment: config.environment,
    authDisabled: config.server.authDisabled,
    users: services.repositories.users,
    tokens: authTokens,
  });
  registerRoutes(app, {
    environment: config.environment,
    bootstrapToken: config.security.bootstrapToken,
  });

  const startedRequests = new WeakMap<object, number>();
  app.addHook('onRequest', async (request) => {
    startedRequests.set(request, performance.now());
  });
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = performance.now() - (startedRequests.get(request) ?? performance.now());
    const route = request.routeOptions.url ?? 'unmatched';
    recordHttpRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
    });
    metrics.gauge('e_agent_queue_active', services.queue.snapshot.active);
    metrics.gauge('e_agent_queue_pending', services.queue.snapshot.pending);
  });

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return apiErrorSchema.parse({
      error: {
        code: 'NOT_FOUND',
        message: '接口不存在',
        requestId: request.id,
        retryable: false,
      },
    });
  });
  app.setErrorHandler(async (error, request, reply) => {
    let domain: DomainError;
    if (error instanceof DomainError) domain = error;
    else if (error instanceof ZodError) {
      domain = new DomainError('BAD_REQUEST', '请求参数无效', {
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    } else if (error instanceof ProviderError) {
      domain = new DomainError('PROVIDER_ERROR', error.message, {
        retryable: error.retryable,
        details: { providerCode: error.code },
      });
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 429
    ) {
      domain = new DomainError('RATE_LIMITED', '请求过于频繁，请稍后重试', {
        retryable: true,
      });
    } else {
      request.log.error({ err: error }, '未处理的服务端错误');
      domain = new DomainError('INTERNAL_ERROR', '服务暂时不可用');
    }
    reply.code(domain.statusCode);
    return apiErrorSchema.parse({
      error: {
        code: domain.code,
        message: domain.message,
        requestId: request.id,
        retryable: domain.retryable,
        ...(domain.details === undefined ? {} : { details: domain.details }),
      },
    });
  });

  if (ownsDatabase) {
    app.addHook('onClose', async () => {
      database.close();
    });
  }
  if (options.extensions !== undefined) {
    app.addHook('onClose', async () => options.extensions?.shutdown());
  }
  return app;
}

/** 监听端口并启动后台发现与每小时 Key 健康检查。 */
export async function startServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = await buildServer({ ...options, config });
  app.eAgent.extensions = await initializeExtensions({
    services: app.eAgent.services,
    logger: app.log as AppLogger,
    developmentMode: config.environment === 'development',
  });
  app.addHook('onClose', async () => app.eAgent.extensions?.shutdown());
  const stopHealthChecks = app.eAgent.services.keys.startHealthChecks();
  app.addHook('onClose', async () => stopHealthChecks());
  await app.listen({ host: config.server.host, port: config.server.port });
  void app.eAgent.services.models
    .discover()
    .then((results) => {
      app.log.info({ results }, '启动模型发现完成');
    })
    .catch((error: unknown) => {
      app.log.warn({ err: error }, '启动模型发现失败');
    });
  return app;
}
