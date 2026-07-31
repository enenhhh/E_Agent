import type { OpenAICompatibleClientOptions } from '@e-agent/ai-runtime';
import { isAllowedProviderBaseUrl, type ProviderType } from '@e-agent/contracts';
import { createRepositories, type DatabaseContext, type Repositories } from '@e-agent/database';
import type { AppLogger } from '@e-agent/observability';
import { TokenService, type MasterKey } from '@e-agent/security';

import { AuditService } from './audit-service.js';
import { AuthService } from './auth-service.js';
import { ChatService, type ChatRuntimeClient } from './chat-service.js';
import { ConversationService } from './conversation-service.js';
import { KeyPool } from './key-pool.js';
import { ApiKeyService } from './key-service.js';
import { ModelService } from './model-service.js';
import { RequestQueue } from './request-queue.js';
import { SettingsService } from './settings-service.js';
import type { SystemPromptSurface } from './system-prompt.js';
import { UsageService } from './usage-service.js';

export interface CoreServices {
  repositories: Repositories;
  audit: AuditService;
  auth: AuthService;
  keys: ApiKeyService;
  keyPool: KeyPool;
  models: ModelService;
  conversations: ConversationService;
  settings: SettingsService;
  usage: UsageService;
  chat: ChatService;
  queue: RequestQueue;
}

export interface CreateCoreServicesOptions {
  database: DatabaseContext;
  masterKey: MasterKey;
  sessionSecret: string;
  logger?: AppLogger;
  chatClientFactory?: (options: OpenAICompatibleClientOptions) => ChatRuntimeClient;
  systemPromptSurface?: SystemPromptSurface;
}

/** 组装核心服务，所有依赖显式注入以便桌面端与 Web 服务复用。 */
export function createCoreServices(options: CreateCoreServicesOptions): CoreServices {
  const repositories = createRepositories(options.database.db);
  const queue = new RequestQueue();
  const settings = new SettingsService(repositories.settings, queue, repositories.audit);
  queue.setConcurrency(settings.get().maxConcurrentRequests);
  const keyPool = new KeyPool(repositories.providers, repositories.apiKeys, options.masterKey);
  const models = new ModelService(
    repositories.providers,
    repositories.models,
    keyPool,
    repositories.audit,
  );
  const usage = new UsageService(repositories.usage, repositories.settings, repositories.projects);
  return {
    repositories,
    audit: new AuditService(repositories.audit),
    auth: new AuthService(
      repositories.users,
      new TokenService(options.sessionSecret),
      repositories.audit,
    ),
    keys: new ApiKeyService(
      repositories.providers,
      repositories.apiKeys,
      options.masterKey,
      repositories.audit,
    ),
    keyPool,
    models,
    conversations: new ConversationService(
      repositories.conversations,
      repositories.projects,
      repositories.audit,
    ),
    settings,
    usage,
    chat: new ChatService({
      conversations: repositories.conversations,
      memories: repositories.memories,
      projects: repositories.projects,
      cache: repositories.cache,
      models,
      keyPool,
      settings,
      usage,
      queue,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.chatClientFactory === undefined
        ? {}
        : { clientFactory: options.chatClientFactory }),
      ...(options.systemPromptSurface === undefined
        ? {}
        : { systemPromptSurface: options.systemPromptSurface }),
    }),
    queue,
  };
}

/** 首次启动时建立安全的默认提供商元数据，不写入任何凭据。 */
export function bootstrapDefaultProviders(
  repositories: Repositories,
  options: { openAiBaseUrl: string; ollamaUrl: string },
): void {
  const assertBaseUrl = (type: ProviderType, baseUrl: string): string => {
    if (!isAllowedProviderBaseUrl(type, baseUrl)) {
      throw new Error(
        `默认 ${type} Provider 地址不安全：禁止凭据或敏感查询，云端必须使用 HTTPS，HTTP 仅允许 Ollama 本机回环地址`,
      );
    }
    return baseUrl;
  };
  const openAiBaseUrl = assertBaseUrl('openai', options.openAiBaseUrl);
  const ollamaBaseUrl = assertBaseUrl('ollama', `${options.ollamaUrl.replace(/\/+$/, '')}/v1`);
  const existing = repositories.providers.list();
  if (!existing.some((provider) => provider.type === 'openai')) {
    repositories.providers.create({
      type: 'openai',
      name: 'OpenAI Compatible',
      baseUrl: openAiBaseUrl,
      keyStrategy: 'round-robin',
    });
  }
  if (!existing.some((provider) => provider.type === 'ollama')) {
    repositories.providers.create({
      type: 'ollama',
      name: 'Local Ollama',
      baseUrl: ollamaBaseUrl,
      keyStrategy: 'round-robin',
    });
  }
}
