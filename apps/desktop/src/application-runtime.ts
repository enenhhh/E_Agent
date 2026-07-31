import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  ApiKeySummary,
  AppSettings as CoreSettings,
  AuthResponse,
  ChatMessageInput,
  ChatStreamEvent,
  Conversation as CoreConversation,
  ConversationMessage,
  Model as CoreModel,
  Provider,
  UpdateApiKeyRequest,
  UpdateSettingsRequest,
  User as CoreUser,
} from '@e-agent/contracts';
import {
  bootstrapDefaultProviders,
  createCoreServices,
  estimateTokens,
  type Actor,
  type ChatClientFactory,
  type CoreServices,
} from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import type { McpToolResult } from '@e-agent/mcp-runtime';
import type { JsonValue } from '@e-agent/plugin-sdk';
import { deriveMasterKey, redactSensitive, redactText } from '@e-agent/security';
import { z } from 'zod';

import type { ApplicationHandlers, ApplicationStreamHandlers } from './ipc.js';
import {
  agentToolDefinitions,
  executeAutomaticWorkspaceTool,
  isAutomaticWorkspaceTool,
  parseAgentToolInvocation,
  parseToolEnvelope,
  serializeToolEnvelope,
  toolResultEnvelopeSchema,
  type ParsedAgentToolInvocation,
  type ToolResultEnvelope,
} from './services/agent-tool-registry.js';
import type {
  BrowserToolArguments,
  SafeBrowserToolService,
} from './services/browser-tool-service.js';
import { composeDesktopChatMessages } from './services/chat-message-composer.js';
import {
  assertSafeCommand,
  WorkspaceCommandRunner,
  type CommandRunResult,
} from './services/command-runner.js';
import type { DesktopContextResolver } from './services/context-resolver.js';
import { DesktopError, serializeDesktopError } from './services/errors.js';
import { DesktopFileChangeCoordinator } from './services/file-change-coordinator.js';
import type { AppLogger } from './services/logger.js';
import type { DesktopMcpService, DesktopMcpToolDescriptor } from './services/mcp-service.js';
import type { DesktopPluginHookRunner } from './services/plugin-hook-runner.js';
import { safeSystemInfo, SystemProcessInspector } from './services/process-inspector.js';
import type { DesktopSecretStore } from './services/secret-store.js';
import type { DesktopSkillResolver } from './services/skill-resolver.js';
import {
  createToolPermissionMetadata,
  isBrowserTool,
  isWorkspaceBoundTool,
} from './services/tool-permissions.js';
import { DesktopWorkflowService } from './services/workflow-service.js';
import type { WorkspaceService } from './services/workspace.js';
import { applicationInvokeSchemas, applicationStreamSchemas } from './shared/application-ipc.js';

const localOwnerEmail = 'local-owner@e-agent.invalid';
const desktopSettingsScope = 'desktop-ui-extras';
const costAlertNotificationScope = 'desktop-cost-alert-notifications';
const toolContinuationSnapshotTtlMs = 30 * 60 * 1_000;
const toolContinuationTombstoneTtlMs = 24 * 60 * 60 * 1_000;
const maximumToolContinuationSnapshotBytes = 16 * 1_024 * 1_024;
const maximumToolContinuationSnapshotTotalBytes = 32 * 1_024 * 1_024;
const maximumToolContinuationSnapshots = 64;
const maximumToolContinuationTombstones = 1_024;
type DesktopMcpServicePort = Pick<
  DesktopMcpService,
  | 'activate'
  | 'callTool'
  | 'describeTool'
  | 'list'
  | 'listChatTools'
  | 'refresh'
  | 'remove'
  | 'save'
  | 'setEnabled'
>;

const persistedSessionSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
    localOwner: z.boolean(),
  })
  .strict();

const desktopSettingsExtrasSchema = z
  .object({
    autoCompressContext: z.boolean().default(true),
    autoUpdate: z.boolean().default(true),
    telemetryEnabled: z.boolean().default(false),
    ollamaFallback: z.boolean().default(false),
    reasoningDisplay: z.enum(['collapsed', 'expanded', 'hidden']).default('collapsed'),
    tutorialCompletedVersion: z.number().int().nonnegative().default(0),
    autoExpandRunningTools: z.boolean().default(true),
  })
  .passthrough();

const credentialUpdateSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    provider: z.string().min(1).max(80).optional(),
    apiKey: z.string().max(8_192).optional(),
    baseUrl: z.string().url().max(2_048).optional(),
    strategy: z.enum(['round-robin', 'priority', 'failover']).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    dailyLimit: z.number().nonnegative().nullable().optional(),
    monthlyLimit: z.number().nonnegative().nullable().optional(),
    quotaUnit: z.enum(['usd', 'tokens']).optional(),
    proxyUrl: z.string().url().max(2_048).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const settingsUpdateSchema = z
  .object({
    locale: z.enum(['zh-CN', 'en-US']).optional(),
    theme: z.string().min(1).max(100).optional(),
    defaultModels: z.record(z.string(), z.string()).optional(),
    maxConcurrency: z.number().int().min(1).max(50).optional(),
    costAlertThreshold: z.number().nonnegative().max(1_000_000).optional(),
    autoCompressContext: z.boolean().optional(),
    autoUpdate: z.boolean().optional(),
    telemetryEnabled: z.boolean().optional(),
    ollamaFallback: z.boolean().optional(),
    reasoningDisplay: z.enum(['collapsed', 'expanded', 'hidden']).optional(),
    tutorialCompletedVersion: z.number().int().nonnegative().optional(),
    autoExpandRunningTools: z.boolean().optional(),
    toolExecutionPolicy: z.enum(['always-ask', 'allow-safe', 'disabled']).optional(),
    toolCommandTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    toolOutputLimitBytes: z.number().int().min(4_096).max(1_048_576).optional(),
  })
  .strict();

export interface DesktopApplicationRuntimeOptions {
  databasePath: string;
  secrets: DesktopSecretStore;
  workspace: WorkspaceService;
  logger: AppLogger;
  locale: 'zh-CN' | 'en-US';
  openAiBaseUrl?: string;
  ollamaUrl?: string;
  contextResolver?: DesktopContextResolver;
  skillResolver?: DesktopSkillResolver;
  pluginHookRunner?: DesktopPluginHookRunner;
  notifyCostAlert?: (input: { currentUsd: number; thresholdUsd: number }) => Promise<void>;
  autoCreateOwner?: boolean;
  autoDiscoverModels?: boolean;
  chatClientFactory?: ChatClientFactory;
  commandRunner?: Pick<WorkspaceCommandRunner, 'run'>;
  browserTools?: Pick<SafeBrowserToolService, 'dispose' | 'execute'>;
  processInspector?: Pick<SystemProcessInspector, 'list'>;
  mcpService?: DesktopMcpServicePort;
}

export interface DesktopApplicationRuntime {
  readonly handlers: ApplicationHandlers;
  readonly streamHandlers: ApplicationStreamHandlers;
  readonly services: CoreServices;
  isAutoUpdateEnabled(): boolean;
  startBackgroundTasks(): void;
  dispose(): Promise<void>;
}

/**
 * 创建 Electron 主进程内的应用服务组合根。
 *
 * 所有业务调用直接访问本地 SQLite 和共享 core 服务，不启动或依赖 HTTP 服务。
 */
export async function createDesktopApplicationRuntime(
  options: DesktopApplicationRuntimeOptions,
): Promise<DesktopApplicationRuntime> {
  const masterKey = await options.secrets.loadOrCreateMasterKey();
  const derivedKey = deriveMasterKey(masterKey);
  const sessionSecret = createHash('sha256')
    .update(derivedKey)
    .update('e-agent:desktop-session-secret', 'utf8')
    .digest('hex');
  derivedKey.fill(0);

  let database: DatabaseContext | undefined;
  try {
    database = openDatabase({ url: options.databasePath });
    const loggerAdapter = {
      warn(fields: Record<string, unknown>, message: string): void {
        options.logger.warn(message, fields);
      },
    } as never;
    const services = createCoreServices({
      database,
      masterKey,
      sessionSecret,
      logger: loggerAdapter,
      systemPromptSurface: 'desktop',
      ...(options.chatClientFactory === undefined
        ? {}
        : { chatClientFactory: options.chatClientFactory }),
    });
    bootstrapDefaultProviders(services.repositories, {
      openAiBaseUrl:
        options.openAiBaseUrl ??
        process.env['E_AGENT_OPENAI_BASE_URL'] ??
        'https://api.openai.com/v1',
      ollamaUrl: options.ollamaUrl ?? process.env['E_AGENT_OLLAMA_URL'] ?? 'http://127.0.0.1:11434',
    });
    const fileChanges = new DesktopFileChangeCoordinator({
      workspace: options.workspace,
      secrets: options.secrets,
      ...(options.pluginHookRunner === undefined
        ? {}
        : { fileHookRunner: options.pluginHookRunner }),
    });
    await fileChanges.initialize();
    const workflows =
      options.skillResolver === undefined
        ? undefined
        : new DesktopWorkflowService({
            services,
            skills: options.skillResolver,
            logger: options.logger,
          });

    const sessions = new LocalSessionManager({
      services,
      secrets: options.secrets,
      autoCreateOwner: options.autoCreateOwner ?? true,
    });
    const application = new ApplicationAdapter({
      services,
      sessions,
      logger: options.logger,
      workspace: options.workspace,
      fileChanges,
      commandRunner:
        options.commandRunner ??
        new WorkspaceCommandRunner({
          workspace: options.workspace,
        }),
      processInspector: options.processInspector ?? new SystemProcessInspector(),
      ...(options.mcpService === undefined ? {} : { mcpService: options.mcpService }),
      ...(options.browserTools === undefined ? {} : { browserTools: options.browserTools }),
      locale: options.locale,
      ...(options.contextResolver === undefined
        ? {}
        : { contextResolver: options.contextResolver }),
      ...(options.skillResolver === undefined ? {} : { skillResolver: options.skillResolver }),
      ...(workflows === undefined ? {} : { workflows }),
      ...(options.notifyCostAlert === undefined
        ? {}
        : { notifyCostAlert: options.notifyCostAlert }),
    });
    let stopHealthChecks: (() => void) | undefined;
    let discoveryController: AbortController | undefined;
    let discoveryTask: Promise<void> | undefined;
    let disposed = false;

    return {
      handlers: application.handlers,
      streamHandlers: application.streamHandlers,
      services,
      isAutoUpdateEnabled: () => desktopSettingsExtras(services).autoUpdate,
      startBackgroundTasks(): void {
        if (disposed || stopHealthChecks !== undefined) {
          return;
        }
        stopHealthChecks = application.startHealthChecks();
        if (options.autoDiscoverModels !== false) {
          discoveryController = new AbortController();
          discoveryTask = services.models
            .discover(undefined, discoveryController.signal)
            .then((results) => {
              options.logger.info('桌面端模型自动发现完成', {
                providers: results.map((result) => ({
                  providerId: result.providerId,
                  discovered: result.discovered,
                  succeeded: result.error === null,
                })),
              });
            })
            .catch((error: unknown) => {
              if (!discoveryController?.signal.aborted) {
                options.logger.warn('桌面端模型自动发现失败', {
                  message: error instanceof Error ? error.message : 'unknown',
                });
              }
            });
        }
      },
      async dispose(): Promise<void> {
        if (disposed) {
          return;
        }
        disposed = true;
        discoveryController?.abort();
        stopHealthChecks?.();
        await application.dispose();
        await discoveryTask;
        database?.close();
        database = undefined;
      },
    };
  } catch (error) {
    database?.close();
    throw error;
  }
}

interface LocalSessionManagerOptions {
  services: CoreServices;
  secrets: DesktopSecretStore;
  autoCreateOwner: boolean;
}

interface SessionInfo {
  user: {
    id: string;
    name: string;
    email: string;
    role: CoreUser['role'];
    active: boolean;
  };
  expiresAt: string;
}

class LocalSessionManager {
  private current: z.infer<typeof persistedSessionSchema> | undefined;
  private loaded = false;
  private autoOwnerSuppressed = false;
  private getInFlight: Promise<SessionInfo | null> | undefined;

  public constructor(private readonly options: LocalSessionManagerOptions) {}

  public get(): Promise<SessionInfo | null> {
    if (this.getInFlight !== undefined) {
      return this.getInFlight;
    }
    const task = this.resolveSession().finally(() => {
      if (this.getInFlight === task) {
        this.getInFlight = undefined;
      }
    });
    this.getInFlight = task;
    return task;
  }

  private async resolveSession(): Promise<SessionInfo | null> {
    await this.load();
    if (this.current !== undefined) {
      const user = this.options.services.repositories.users.findById(this.current.userId);
      if (user !== undefined) {
        if (new Date(this.current.expiresAt).getTime() > Date.now() || this.current.localOwner) {
          if (new Date(this.current.expiresAt).getTime() <= Date.now()) {
            await this.persistUser(user.id, true);
          }
          return mapSessionUser(
            this.options.services.auth.getUser(user.id),
            this.current?.expiresAt ?? futureExpiry(),
          );
        }
      }
      this.current = undefined;
      await this.options.secrets.remove('session');
    }

    if (!this.options.autoCreateOwner || this.autoOwnerSuppressed) {
      return null;
    }
    const existing = this.options.services.repositories.users.findByEmail(localOwnerEmail);
    if (existing !== undefined) {
      const expiresAt = futureExpiry();
      await this.persistUser(existing.id, true, expiresAt);
      return mapSessionUser(this.options.services.auth.getUser(existing.id), expiresAt);
    }
    if (this.options.services.repositories.users.count() > 0) {
      return null;
    }
    const response = await this.options.services.auth.register({
      email: localOwnerEmail,
      displayName: 'Local Owner',
      password: randomBytes(32).toString('base64url'),
    });
    await this.persist(response, true);
    return mapAuthResponse(response);
  }

  public async setup(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<SessionInfo> {
    const response = await this.options.services.auth.register({
      displayName: input.name,
      email: input.email,
      password: input.password,
    });
    await this.persist(response, false);
    return mapAuthResponse(response);
  }

  public async login(input: { email: string; password: string }): Promise<SessionInfo> {
    const response = await this.options.services.auth.login(input);
    await this.persist(response, response.user.email.toLowerCase() === localOwnerEmail);
    this.autoOwnerSuppressed = false;
    return mapAuthResponse(response);
  }

  public async logout(): Promise<void> {
    this.current = undefined;
    this.autoOwnerSuppressed = true;
    await this.options.secrets.remove('session');
  }

  public async actor(): Promise<Actor> {
    const session = await this.get();
    if (session === null) {
      throw new DesktopError('UNAUTHORIZED', '请先登录');
    }
    return { id: session.user.id, role: session.user.role };
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const stored = await this.options.secrets.readJson<unknown>('session');
    if (stored !== undefined) {
      const parsed = persistedSessionSchema.safeParse(stored);
      if (!parsed.success) {
        throw new DesktopError('SESSION_STATE_INVALID', '本地会话状态无效，请重新登录');
      }
      this.current = parsed.data;
    }
    this.loaded = true;
  }

  private async persist(response: AuthResponse, localOwner: boolean): Promise<void> {
    this.current = {
      version: 1,
      userId: response.user.id,
      expiresAt: localOwner ? futureExpiry() : response.expiresAt,
      localOwner,
    };
    await this.options.secrets.writeJson('session', this.current);
  }

  private async persistUser(
    userId: string,
    localOwner: boolean,
    expiresAt = futureExpiry(),
  ): Promise<void> {
    this.current = {
      version: 1,
      userId,
      expiresAt,
      localOwner,
    };
    await this.options.secrets.writeJson('session', this.current);
  }
}

interface ApplicationAdapterOptions {
  services: CoreServices;
  sessions: LocalSessionManager;
  logger: AppLogger;
  workspace: WorkspaceService;
  fileChanges: DesktopFileChangeCoordinator;
  commandRunner: Pick<WorkspaceCommandRunner, 'run'>;
  browserTools?: Pick<SafeBrowserToolService, 'dispose' | 'execute'>;
  processInspector: Pick<SystemProcessInspector, 'list'>;
  mcpService?: DesktopMcpServicePort;
  locale: 'zh-CN' | 'en-US';
  contextResolver?: DesktopContextResolver;
  skillResolver?: DesktopSkillResolver;
  workflows?: DesktopWorkflowService;
  notifyCostAlert?: (input: { currentUsd: number; thresholdUsd: number }) => Promise<void>;
}

interface ToolContinuationSnapshot {
  readonly id: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly modelId: string;
  readonly skill?: string;
  readonly toolCallIds: readonly string[];
  readonly supplementalMessages: readonly ChatMessageInput[];
  readonly byteLength: number;
  readonly expiresAt: number;
  sealed: boolean;
  claimed: boolean;
}

interface TerminalToolCallGroup {
  readonly assistantMessage: ConversationMessage;
  readonly canonicalToolCallId: string;
  readonly toolCallIds: readonly string[];
  readonly canonicalEnvelope: ToolResultEnvelope;
  readonly continuationStateId?: string;
}

class ApplicationAdapter {
  public readonly handlers: ApplicationHandlers;
  public readonly streamHandlers: ApplicationStreamHandlers;
  private readonly shutdownController = new AbortController();
  private readonly activeHandlers = new Set<Promise<void>>();
  private readonly activeStreams = new Set<Promise<void>>();
  private readonly notifyingCostAlertDays = new Set<string>();
  private readonly toolDecisionTails = new Map<string, Promise<void>>();
  private readonly toolContinuationSnapshots = new Set<ToolContinuationSnapshot>();
  private readonly toolContinuationSnapshotsByCall = new Map<string, ToolContinuationSnapshot>();
  private readonly toolContinuationTombstones = new Map<string, number>();
  private toolContinuationSnapshotBytes = 0;

  public constructor(private readonly options: ApplicationAdapterOptions) {
    const services = options.services;
    const sessions = options.sessions;
    const rawHandlers: ApplicationHandlers = {
      'auth:get-session': () => sessions.get(),
      'auth:setup': async (input) => {
        const parsed = applicationInvokeSchemas['auth:setup'].parse(input);
        return sessions.setup(parsed);
      },
      'auth:login': async (input) => {
        const parsed = applicationInvokeSchemas['auth:login'].parse(input);
        return sessions.login(parsed);
      },
      'auth:logout': () => sessions.logout(),
      'models:list': () => mapModels(services.models.list().models),
      'models:discover': async (input) => {
        const parsed = applicationInvokeSchemas['models:discover'].parse(input);
        assertOwnerOrAdmin(await sessions.actor(), '仅 Owner/Admin 可重新发现模型');
        const results = await services.models.discover(
          parsed.providerId,
          this.shutdownController.signal,
        );
        const failures = results.filter((result) => result.error !== null);
        if (results.length === 0 || failures.length === results.length) {
          throw new DesktopError(
            'MODEL_DISCOVERY_FAILED',
            failures
              .map((result) => result.error)
              .filter(Boolean)
              .join('；') || '没有可用于模型发现的服务商',
          );
        }
        if (failures.length > 0) {
          this.options.logger.warn('部分服务商模型发现失败', {
            providers: failures.map((result) => ({
              providerId: result.providerId,
              error: result.error,
            })),
          });
        }
        return mapModels(services.models.list().models);
      },
      'models:update-provider-selection': async (input) => {
        const parsed = applicationInvokeSchemas['models:update-provider-selection'].parse(input);
        const actor = await sessions.actor();
        assertOwnerOrAdmin(actor, '仅 Owner/Admin 可配置服务商模型');
        services.models.updateEnabledSelection(parsed.providerId, parsed.enabledModelIds, actor.id);
        return mapModels(services.models.list().models);
      },
      'providers:list': async () => {
        await sessions.actor();
        return services.keys.list().providers;
      },
      'providers:create': async (input) => {
        const parsed = applicationInvokeSchemas['providers:create'].parse(input);
        const actor = await sessions.actor();
        assertOwner(actor, '仅 Owner 可创建服务商');
        let provider = services.keys.createProvider(
          {
            type: parsed.type,
            name: parsed.name,
            baseUrl: parsed.baseUrl,
            keyStrategy: parsed.keyStrategy,
          },
          actor.id,
        );
        if (parsed.enabled === false) {
          provider = services.keys.updateProvider(provider.id, { enabled: false }, actor.id);
        }
        return provider;
      },
      'providers:update': async (input) => {
        const parsed = applicationInvokeSchemas['providers:update'].parse(input);
        const actor = await sessions.actor();
        assertOwner(actor, '仅 Owner 可修改服务商');
        const before = requireProvider(services, parsed.id);
        const provider = services.keys.updateProvider(parsed.id, parsed.input, actor.id);
        const endpointChanged =
          before.type !== provider.type || before.baseUrl !== provider.baseUrl;
        const reenabled = !before.enabled && provider.enabled;
        let modelDiscoveryError: string | null = null;
        if (endpointChanged || reenabled) {
          services.models.invalidateProvider(provider.id);
          if (provider.enabled) {
            const [result] = await services.models.discover(
              provider.id,
              this.shutdownController.signal,
            );
            modelDiscoveryError = result?.error ?? null;
          }
        }
        return {
          ...provider,
          ...(modelDiscoveryError === null ? {} : { modelDiscoveryError }),
        };
      },
      'credentials:list': () => mapCredentials(services.keys.list()),
      'credentials:create': async (input) => {
        const parsed = applicationInvokeSchemas['credentials:create'].parse(input);
        const actor = await sessions.actor();
        assertOwner(actor, '仅 Owner 可创建 API Key');
        let provider: Provider;
        if (parsed.providerId !== undefined) {
          provider = requireProvider(services, parsed.providerId);
        } else if (parsed.provider !== undefined) {
          provider = ensureProvider(
            services,
            {
              provider: parsed.provider,
              ...(parsed.providerName === undefined ? {} : { providerName: parsed.providerName }),
              ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
              strategy: parsed.strategy,
            },
            actor.id,
          );
        } else {
          throw new DesktopError('BAD_REQUEST', '必须选择服务商');
        }
        let key = services.keys.create(
          {
            providerId: provider.id,
            label: parsed.name,
            apiKey: parsed.apiKey,
            priority: parsed.priority,
            dailyLimit: positiveOrNull(parsed.dailyLimit),
            monthlyLimit: positiveOrNull(parsed.monthlyLimit),
            quotaUnit: parsed.quotaUnit ?? 'usd',
            proxyUrl: parsed.proxyUrl ?? null,
          },
          actor.id,
        );
        if (parsed.enabled === false) {
          key = services.keys.update(key.id, { enabled: false }, actor.id);
        }
        return mapCredential(key, provider);
      },
      'credentials:update': async (input) => {
        const parsed = applicationInvokeSchemas['credentials:update'].parse(input);
        const update = credentialUpdateSchema.parse(parsed.input);
        const actor = await sessions.actor();
        assertOwner(actor, '仅 Owner 可修改 API Key');
        const before = services.keys.list().keys.find((key) => key.id === parsed.id);
        if (before === undefined) {
          throw new DesktopError('NOT_FOUND', 'API Key 不存在');
        }
        const provider = services.keys
          .list()
          .providers.find((candidate) => candidate.id === before.providerId);
        if (provider === undefined) {
          throw new DesktopError('NOT_FOUND', 'API Key 的提供商不存在');
        }
        if (
          update.provider !== undefined &&
          ![
            provider.id.toLowerCase(),
            provider.name.toLowerCase(),
            provider.type.toLowerCase(),
          ].includes(update.provider.toLowerCase())
        ) {
          throw new DesktopError(
            'PROVIDER_CHANGE_REQUIRES_RECREATE',
            '更换 API Key 提供商需要重新创建凭据',
          );
        }
        let currentProvider = provider;
        if (update.baseUrl !== undefined || update.strategy !== undefined) {
          currentProvider = services.keys.updateProvider(
            provider.id,
            {
              ...(update.baseUrl === undefined ? {} : { baseUrl: update.baseUrl }),
              ...(update.strategy === undefined
                ? {}
                : { keyStrategy: coreStrategy(update.strategy) }),
            },
            actor.id,
          );
          if (currentProvider.baseUrl !== provider.baseUrl) {
            services.models.invalidateProvider(provider.id);
            await services.models.discover(provider.id, this.shutdownController.signal);
          }
        }
        const patch: UpdateApiKeyRequest = {
          ...(update.name === undefined ? {} : { label: update.name }),
          ...(update.apiKey === undefined || update.apiKey === '' ? {} : { apiKey: update.apiKey }),
          ...(update.priority === undefined ? {} : { priority: update.priority }),
          ...(update.dailyLimit === undefined
            ? {}
            : { dailyLimit: positiveOrNull(update.dailyLimit) }),
          ...(update.monthlyLimit === undefined
            ? {}
            : { monthlyLimit: positiveOrNull(update.monthlyLimit) }),
          ...(update.quotaUnit === undefined ? {} : { quotaUnit: update.quotaUnit }),
          ...(update.proxyUrl === undefined ? {} : { proxyUrl: update.proxyUrl }),
          ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
        };
        return mapCredential(services.keys.update(parsed.id, patch, actor.id), currentProvider);
      },
      'credentials:delete': async (input) => {
        const parsed = applicationInvokeSchemas['credentials:delete'].parse(input);
        const actor = await sessions.actor();
        assertOwner(actor, '仅 Owner 可删除 API Key');
        services.keys.delete(parsed.id, actor.id);
      },
      'credentials:check': async (input) => {
        const parsed = applicationInvokeSchemas['credentials:check'].parse(input);
        assertOwnerOrAdmin(await sessions.actor(), '仅 Owner/Admin 可检查 API Key 健康状态');
        await services.keys.check(parsed.id, this.shutdownController.signal);
        return requireCredential(services, parsed.id);
      },
      'credentials:check-all': async () => {
        assertOwnerOrAdmin(await sessions.actor(), '仅 Owner/Admin 可检查 API Key 健康状态');
        await services.keys.checkAll(this.shutdownController.signal);
        return mapCredentials(services.keys.list());
      },
      'conversations:list': async () => {
        const actor = await sessions.actor();
        return mapConversationsWithBranchCounts(listAllConversations(services, actor));
      },
      'conversations:get': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:get'].parse(input);
        const summary = services.conversations.getSummary(parsed.id, await sessions.actor());
        return mapConversation(summary.conversation, summary.branchCount);
      },
      'conversations:create': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:create'].parse(input);
        const actor = await sessions.actor();
        return mapConversation(
          services.conversations.create(
            {
              projectId: null,
              title: parsed.title?.trim() || '新会话',
            },
            actor,
          ),
        );
      },
      'conversations:update': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:update'].parse(input);
        const actor = await sessions.actor();
        const conversation = services.conversations.update(parsed.id, parsed.input, actor);
        return mapConversation(
          conversation,
          countDirectBranches(listAllConversations(services, actor), conversation.id),
        );
      },
      'conversations:delete': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:delete'].parse(input);
        services.conversations.delete(parsed.id, await sessions.actor());
      },
      'conversations:branch': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:branch'].parse(input);
        return mapConversation(
          services.conversations.branch(
            parsed.id,
            {
              ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
              fromMessageId: parsed.messageId,
              includeFromMessage: parsed.includeFromMessage ?? true,
              kind: parsed.kind ?? 'branch',
              ...(parsed.originMessageId === undefined
                ? {}
                : { originMessageId: parsed.originMessageId }),
              ...(parsed.title === undefined ? {} : { title: parsed.title }),
            },
            await sessions.actor(),
          ),
        );
      },
      'conversations:snapshot': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:snapshot'].parse(input);
        return services.conversations.createSnapshot(parsed.id, await sessions.actor());
      },
      'conversations:list-snapshots': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:list-snapshots'].parse(input);
        return services.conversations.listSnapshots(parsed.id, await sessions.actor());
      },
      'conversations:restore-snapshot': async (input) => {
        const parsed = applicationInvokeSchemas['conversations:restore-snapshot'].parse(input);
        const actor = await sessions.actor();
        const conversation = services.conversations.restoreSnapshot(
          parsed.id,
          parsed.snapshotId,
          actor,
        );
        return mapConversation(
          conversation,
          countDirectBranches(listAllConversations(services, actor), conversation.id),
        );
      },
      'messages:list': async (input) => {
        const parsed = applicationInvokeSchemas['messages:list'].parse(input);
        const actor = await sessions.actor();
        const detail = services.conversations.get(parsed.conversationId, actor);
        const fileChanges = services.conversations.listFileChanges(parsed.conversationId, actor);
        return mapMessages(detail.messages, fileChanges);
      },
      'messages:snapshot': async (input) => {
        const parsed = applicationInvokeSchemas['messages:snapshot'].parse(input);
        const actor = await sessions.actor();
        const detail = services.conversations.get(parsed.conversationId, actor);
        const fileChanges = services.conversations.listFileChanges(parsed.conversationId, actor);
        return {
          messages: mapMessages(detail.messages, fileChanges),
          messageCount: detail.messages.length,
          tailMessageId: detail.messages.at(-1)?.id ?? null,
        };
      },
      'messages:delete': async (input) => {
        const parsed = applicationInvokeSchemas['messages:delete'].parse(input);
        const actor = await sessions.actor();
        const result = services.conversations.deleteMessage(
          parsed.conversationId,
          parsed.messageId,
          {
            ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
            expectedMessageCount: parsed.expectedMessageCount,
            expectedTailMessageId: parsed.expectedTailMessageId,
          },
          actor,
        );
        return {
          ...result,
          conversation: mapConversation(
            result.conversation,
            countDirectBranches(listAllConversations(services, actor), result.conversation.id),
          ),
        };
      },
      'messages:feedback': async (input) => {
        const parsed = applicationInvokeSchemas['messages:feedback'].parse(input);
        return mapRendererMessage(
          services.conversations.updateMessageFeedback(
            parsed.conversationId,
            parsed.messageId,
            { feedback: parsed.feedback },
            await sessions.actor(),
          ),
        );
      },
      'context:get': async (input) => {
        const parsed = applicationInvokeSchemas['context:get'].parse(input);
        const actor = await sessions.actor();
        const detail = services.conversations.get(parsed.conversationId, actor);
        return mapContext(services, detail.messages);
      },
      'tools:decide': async (input) => {
        const parsed = applicationInvokeSchemas['tools:decide'].parse(input);
        const actor = await sessions.actor();
        assertCanApproveTools(actor);
        return this.exclusiveToolDecision(`conversation:${parsed.conversationId}`, async () =>
          this.attachToolContinuationTicket(
            parsed.conversationId,
            parsed.toolCallId,
            actor,
            await this.decideToolCall(parsed, actor),
          ),
        );
      },
      'workspace:decide-change': async (input) => {
        const parsed = applicationInvokeSchemas['workspace:decide-change'].parse(input);
        if (parsed.acceptedLines !== undefined) {
          throw new DesktopError(
            'PARTIAL_FILE_APPROVAL_UNSUPPORTED',
            '桌面聊天文件变更当前仅支持整体接受或拒绝，未执行任何写盘操作',
          );
        }
        const actor = await sessions.actor();
        assertCanApproveTools(actor);
        return this.exclusiveToolDecision(`conversation:${parsed.conversationId}`, async () => {
          const result = await this.decideWorkspaceFileChange(parsed, actor);
          return this.attachToolContinuationTicket(parsed.conversationId, result.id, actor, result);
        });
      },
      'usage:summary': async (input) => {
        const parsed = applicationInvokeSchemas['usage:summary'].parse(input);
        return mapUsageSummary(services, parsed.range);
      },
      'usage:records': async (input) => {
        const parsed = applicationInvokeSchemas['usage:records'].parse(input);
        const range = dateRange(parsed.range);
        return services.usage.records({ ...range, groupBy: 'day', limit: 100 }).map((record) => ({
          id: record.id,
          timestamp: record.occurredAt,
          model: record.model,
          project: record.projectId ?? '未绑定项目',
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cost: record.estimatedCostUsd,
          latencyMs: record.durationMs,
          cacheHit: record.cacheHit,
        }));
      },
      'usage:export': async (input) => {
        const parsed = applicationInvokeSchemas['usage:export'].parse(input);
        return services.usage.export(
          {
            ...dateRange(parsed.range),
            groupBy: 'day',
            limit: 200,
          },
          parsed.format,
        );
      },
      'workflows:list': async () => {
        if (this.options.workflows === undefined) {
          throw new DesktopError('WORKFLOW_UNAVAILABLE', '桌面 Workflow 服务尚未初始化');
        }
        return this.options.workflows.list(await sessions.actor());
      },
      'workflows:save': async (input) => {
        if (this.options.workflows === undefined) {
          throw new DesktopError('WORKFLOW_UNAVAILABLE', '桌面 Workflow 服务尚未初始化');
        }
        const parsed = applicationInvokeSchemas['workflows:save'].parse(input);
        return this.options.workflows.save(parsed.workflow, await sessions.actor());
      },
      'workflows:delete': async (input) => {
        if (this.options.workflows === undefined) {
          throw new DesktopError('WORKFLOW_UNAVAILABLE', '桌面 Workflow 服务尚未初始化');
        }
        const parsed = applicationInvokeSchemas['workflows:delete'].parse(input);
        await this.options.workflows.delete(parsed.id, await sessions.actor());
      },
      'workflows:run': async (input) => {
        if (this.options.workflows === undefined) {
          throw new DesktopError('WORKFLOW_UNAVAILABLE', '桌面 Workflow 服务尚未初始化');
        }
        const parsed = applicationInvokeSchemas['workflows:run'].parse(input);
        return this.options.workflows.run(
          parsed.id,
          parsed.variables,
          parsed.locale,
          await sessions.actor(),
          this.shutdownController.signal,
        );
      },
      'mcp:list': async () => {
        const actor = await sessions.actor();
        const servers = (await this.options.mcpService?.list()) ?? [];
        if (actor.role !== 'viewer') this.options.mcpService?.activate();
        return servers;
      },
      'mcp:save': async (input) => {
        if (this.options.mcpService === undefined) {
          throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
        }
        const parsed = applicationInvokeSchemas['mcp:save'].parse(input);
        const actor = await sessions.actor();
        assertCanManageMcp(actor);
        const saved = await this.options.mcpService.save(parsed);
        services.repositories.audit.record({
          actorId: actor.id,
          action: 'mcp.server.save',
          targetType: 'mcp-server',
          targetId: saved.id,
          metadata: {
            transport: saved.transport,
            enabled: saved.enabled,
          },
        });
        return saved;
      },
      'mcp:set-enabled': async (input) => {
        if (this.options.mcpService === undefined) {
          throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
        }
        const parsed = applicationInvokeSchemas['mcp:set-enabled'].parse(input);
        const actor = await sessions.actor();
        assertCanManageMcp(actor);
        const updated = await this.options.mcpService.setEnabled(parsed.id, parsed.enabled);
        services.repositories.audit.record({
          actorId: actor.id,
          action: parsed.enabled ? 'mcp.server.enable' : 'mcp.server.disable',
          targetType: 'mcp-server',
          targetId: parsed.id,
          metadata: {},
        });
        return updated;
      },
      'mcp:refresh': async (input) => {
        if (this.options.mcpService === undefined) {
          throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
        }
        const parsed = applicationInvokeSchemas['mcp:refresh'].parse(input);
        assertCanManageMcp(await sessions.actor());
        return this.options.mcpService.refresh(parsed.id);
      },
      'mcp:remove': async (input) => {
        if (this.options.mcpService === undefined) {
          throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
        }
        const parsed = applicationInvokeSchemas['mcp:remove'].parse(input);
        const actor = await sessions.actor();
        assertCanManageMcp(actor);
        await this.options.mcpService.remove(parsed.id);
        services.repositories.audit.record({
          actorId: actor.id,
          action: 'mcp.server.remove',
          targetType: 'mcp-server',
          targetId: parsed.id,
          metadata: {},
        });
      },
      'settings:get': () => mapSettings(services, options.locale),
      'settings:update': async (input) => {
        const parsed = settingsUpdateSchema.parse(input);
        const actor = await sessions.actor();
        assertOwnerOrAdmin(actor, '仅 Owner/Admin 可修改全局设置');
        const defaultModels = parsed.defaultModels;
        const coreUpdate: UpdateSettingsRequest = {
          ...(parsed.locale === undefined ? {} : { language: parsed.locale }),
          ...(parsed.theme === undefined ? {} : { theme: parsed.theme }),
          ...(parsed.maxConcurrency === undefined
            ? {}
            : { maxConcurrentRequests: parsed.maxConcurrency }),
          ...(parsed.costAlertThreshold === undefined
            ? {}
            : { dailyCostAlertUsd: parsed.costAlertThreshold }),
          ...(parsed.toolExecutionPolicy === undefined
            ? {}
            : { toolExecutionPolicy: parsed.toolExecutionPolicy }),
          ...(parsed.toolCommandTimeoutMs === undefined
            ? {}
            : { toolCommandTimeoutMs: parsed.toolCommandTimeoutMs }),
          ...(parsed.toolOutputLimitBytes === undefined
            ? {}
            : { toolOutputLimitBytes: parsed.toolOutputLimitBytes }),
          ...(parsed.autoCompressContext === undefined
            ? {}
            : {
                contextCompressionThreshold: parsed.autoCompressContext ? 0.7 : 0.9,
              }),
          ...(defaultModels === undefined
            ? {}
            : {
                defaultModels: {
                  ...optionalModel(defaultModels, 'code'),
                  ...optionalModel(defaultModels, 'chat'),
                  ...optionalModel(defaultModels, 'embedding'),
                  ...optionalModel(defaultModels, 'vision'),
                },
                ...('summarize' in defaultModels
                  ? {
                      contextCompressionModelId: defaultModels['summarize'] || null,
                    }
                  : {}),
              }),
        };
        services.settings.update(coreUpdate, 'global', actor.id);
        const previous = desktopSettingsExtras(services);
        services.repositories.settings.set(desktopSettingsScope, {
          ...previous,
          ...(parsed.autoCompressContext === undefined
            ? {}
            : { autoCompressContext: parsed.autoCompressContext }),
          ...(parsed.autoUpdate === undefined ? {} : { autoUpdate: parsed.autoUpdate }),
          ...(parsed.telemetryEnabled === undefined
            ? {}
            : { telemetryEnabled: parsed.telemetryEnabled }),
          ...(parsed.ollamaFallback === undefined ? {} : { ollamaFallback: parsed.ollamaFallback }),
          ...(parsed.reasoningDisplay === undefined
            ? {}
            : { reasoningDisplay: parsed.reasoningDisplay }),
          ...(parsed.tutorialCompletedVersion === undefined
            ? {}
            : { tutorialCompletedVersion: parsed.tutorialCompletedVersion }),
          ...(parsed.autoExpandRunningTools === undefined
            ? {}
            : { autoExpandRunningTools: parsed.autoExpandRunningTools }),
        });
        return mapSettings(services, options.locale);
      },
      'audit:list': async () => {
        assertOwnerOrAdmin(await sessions.actor(), '仅 Owner/Admin 可读取审计日志');
        const users = services.repositories.users;
        return services.audit.list({ limit: 100 }).logs.map((entry) => {
          const actor = entry.actorId === null ? undefined : users.findById(entry.actorId);
          return {
            id: entry.id,
            actorName: actor?.displayName ?? '系统',
            action: entry.action,
            target: `${entry.targetType}${entry.targetId === null ? '' : `:${entry.targetId}`}`,
            result:
              entry.metadata['result'] === 'failure' || entry.metadata['success'] === false
                ? ('failure' as const)
                : ('success' as const),
            createdAt: entry.createdAt,
            correlationId: entry.id,
          };
        });
      },
      'queue:status': () => ({
        running: services.queue.snapshot.active,
        queued: services.queue.snapshot.pending,
      }),
    };
    this.handlers = Object.fromEntries(
      Object.entries(rawHandlers).map(([channel, handler]) => [
        channel,
        (input: unknown) => this.trackHandler(() => handler(input)),
      ]),
    ) as ApplicationHandlers;

    this.streamHandlers = {
      'chat:stream': (input, signal) => this.trackStream(input, signal),
    };
  }

  public startHealthChecks(intervalMs = 60 * 60 * 1_000): () => void {
    const timer = setInterval(() => {
      void this.trackHandler(() =>
        this.options.services.keys.checkAll(this.shutdownController.signal),
      ).catch((error: unknown) => {
        if (!this.shutdownController.signal.aborted) {
          this.options.logger.warn('桌面端 API Key 后台健康检查失败', {
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  public async dispose(): Promise<void> {
    this.shutdownController.abort(new Error('桌面应用正在退出'));
    await Promise.allSettled([...this.activeHandlers, ...this.activeStreams]);
    this.clearToolContinuationState();
    await this.options.browserTools?.dispose();
  }

  private async trackHandler(operation: () => unknown | Promise<unknown>): Promise<unknown> {
    if (this.shutdownController.signal.aborted) {
      throw new DesktopError('APPLICATION_SHUTTING_DOWN', '桌面应用正在退出');
    }
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeHandlers.add(completion);
    try {
      return await operation();
    } finally {
      resolveCompletion?.();
      this.activeHandlers.delete(completion);
    }
  }

  private async *trackStream(input: unknown, signal: AbortSignal): AsyncGenerator<JsonValue> {
    const controller = new AbortController();
    const abortFromRequest = (): void => controller.abort(signal.reason);
    const abortFromShutdown = (): void => controller.abort(this.shutdownController.signal.reason);
    signal.addEventListener('abort', abortFromRequest, { once: true });
    this.shutdownController.signal.addEventListener('abort', abortFromShutdown, { once: true });
    if (signal.aborted) {
      abortFromRequest();
    } else if (this.shutdownController.signal.aborted) {
      abortFromShutdown();
    }
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeStreams.add(completion);
    try {
      yield* this.streamChat(input, controller.signal);
    } finally {
      signal.removeEventListener('abort', abortFromRequest);
      this.shutdownController.signal.removeEventListener('abort', abortFromShutdown);
      resolveCompletion?.();
      this.activeStreams.delete(completion);
    }
  }

  private async *streamChat(input: unknown, signal: AbortSignal): AsyncGenerator<JsonValue> {
    const parsed = applicationStreamSchemas['chat:stream'].parse(input);
    const actor = await this.options.sessions.actor();
    if (actor.role === 'viewer') {
      throw new DesktopError('FORBIDDEN', 'Viewer 角色不能发送消息');
    }
    const continuingToolCall = parsed.continuationToolCallId !== undefined;
    const toolContinuation =
      parsed.continuationToolCallId === undefined
        ? undefined
        : this.resolveToolContinuation(parsed.conversationId, parsed.continuationToolCallId, actor);
    const resumedContinuationSnapshot = toolContinuation?.snapshot;
    let resumedContinuationSettled = resumedContinuationSnapshot === undefined;
    try {
      const modelId = toolContinuation?.modelId ?? parsed.model;
      const activeSkill = toolContinuation?.skill ?? parsed.skill;
      const contextMessages = continuingToolCall
        ? []
        : this.options.contextResolver === undefined
          ? parsed.contextMentions.length === 0
            ? []
            : (() => {
                throw new DesktopError('CONTEXT_UNAVAILABLE', '桌面上下文解析器尚未初始化');
              })()
          : await this.options.contextResolver.resolve(parsed.contextMentions, signal);
      const supplementalMessages = continuingToolCall
        ? [...(toolContinuation?.supplementalMessages ?? [])]
        : [...contextMessages];
      if (!continuingToolCall && parsed.skill !== undefined) {
        if (this.options.skillResolver === undefined) {
          throw new DesktopError('SKILL_UNAVAILABLE', '桌面 Skill 解析器尚未初始化');
        }
        supplementalMessages.unshift({
          role: 'system',
          content: await this.options.skillResolver.resolve({
            command: parsed.skill,
            userContent: parsed.content,
            contextMessages: contextMessages.map((message) =>
              typeof message.content === 'string' ? message.content : '',
            ),
            contextMentions: parsed.contextMentions,
          }),
        });
      }
      const messages =
        toolContinuation === undefined
          ? composeDesktopChatMessages({
              history:
                supplementalMessages.length === 0
                  ? []
                  : this.options.services.conversations.get(parsed.conversationId, actor).messages,
              supplemental: supplementalMessages,
              userContent: parsed.content,
            })
          : toolContinuation.messages;
      const settings = this.options.services.settings.get();
      const selectedModel = this.options.services.models.get(modelId);
      const toolCallingEnabled =
        settings.toolExecutionPolicy !== 'disabled' &&
        selectedModel.capabilities.includes('function-calling');
      const builtInTools = agentToolDefinitions.filter(
        (tool) => this.options.browserTools !== undefined || !isBrowserTool(tool.function.name),
      );
      const mcpTools =
        !toolCallingEnabled || this.options.mcpService === undefined
          ? []
          : await this.options.mcpService.listChatTools().catch((error: unknown) => {
              this.options.logger.warn('MCP 工具目录读取失败，本轮仅使用内置工具', {
                message: error instanceof Error ? error.message : 'unknown',
              });
              return [];
            });
      const availableTools = [...builtInTools, ...mcpTools].slice(0, 64);
      if (builtInTools.length + mcpTools.length > availableTools.length) {
        this.options.logger.warn('工具数量超过模型协议上限，已截断本轮 MCP 工具目录', {
          builtIn: builtInTools.length,
          mcp: mcpTools.length,
          exposed: availableTools.length,
        });
      }
      const tools = toolCallingEnabled ? availableTools : undefined;
      let roundMessages = messages;
      let requestId: string = randomUUID();
      const knownToolCallIds = new Set(
        this.options.services.conversations
          .get(parsed.conversationId, actor)
          .messages.flatMap((message) => message.toolCalls.map((toolCall) => toolCall.id)),
      );

      for (let round = 0; round < 4; round += 1) {
        const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
        let failed = false;
        for await (const event of this.options.services.chat.stream(
          {
            conversationId: parsed.conversationId,
            ...(round === 0 && parsed.userMessageId !== undefined
              ? { userMessageId: parsed.userMessageId }
              : {}),
            modelId,
            messages: roundMessages,
            ...(activeSkill === undefined ? {} : { skill: activeSkill }),
            ...(tools === undefined ? {} : { tools }),
            stream: true,
            idempotencyKey: randomUUID(),
          },
          actor,
          { signal },
        )) {
          if (event.type === 'queue') {
            yield {
              type: 'queue',
              requestId,
              queue: {
                position: event.position,
                active: event.active,
                pending: event.pending,
              },
            };
          } else if (event.type === 'start') {
            requestId = event.requestId;
            yield { type: 'start', requestId, messageId: event.messageId };
          } else if (event.type === 'delta') {
            yield { type: 'delta', requestId, delta: event.content };
          } else if (event.type === 'reasoning_delta') {
            yield { type: 'reasoning', requestId, delta: event.content };
          } else if (event.type === 'tool_call_delta') {
            mergeToolCall(toolCalls, event, requestId);
          } else if (event.type === 'usage') {
            await this.notifyCostAlertIfNeeded();
            yield {
              type: 'usage',
              requestId,
              usage: {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                cost: event.usage.estimatedCostUsd,
                latencyMs: event.durationMs,
                ...(event.reasoningDurationMs === undefined
                  ? {}
                  : { reasoningDurationMs: event.reasoningDurationMs }),
              },
            };
          } else if (event.type === 'error') {
            failed = true;
            yield { type: 'error', requestId, message: event.message };
          }
        }
        if (failed) return;
        if (resumedContinuationSnapshot !== undefined && !resumedContinuationSettled) {
          this.consumeToolContinuationSnapshot(resumedContinuationSnapshot);
          resumedContinuationSettled = true;
        }
        const currentToolCallIds = [...toolCalls.values()].map((toolCall) => toolCall.id);
        const duplicateToolCallIds = [
          ...new Set([
            ...duplicateValues(currentToolCallIds),
            ...currentToolCallIds.filter((toolCallId) => knownToolCallIds.has(toolCallId)),
          ]),
        ];
        if (duplicateToolCallIds.length > 0) {
          this.options.logger.warn('模型返回重复的工具调用标识，本轮拒绝执行所有工具', {
            conversationId: parsed.conversationId,
            toolCallIds: duplicateToolCallIds,
          });
          yield {
            type: 'error',
            requestId,
            message: '模型返回了重复的工具调用标识，本轮未执行任何工具，请重新发送请求。',
          };
          yield { type: 'done', requestId };
          return;
        }
        for (const toolCallId of currentToolCallIds) knownToolCallIds.add(toolCallId);
        if (toolCalls.size === 0) {
          yield { type: 'done', requestId };
          return;
        }

        const continuationSnapshot = this.registerToolContinuationSnapshot({
          actorId: actor.id,
          conversationId: parsed.conversationId,
          modelId: selectedModel.id,
          skill: activeSkill,
          toolCallIds: currentToolCallIds,
          supplementalMessages,
        });
        let canContinue = true;
        let processedAllToolCalls = false;
        try {
          for (const call of [...toolCalls.values()]) {
            yield {
              type: 'tool_call',
              requestId,
              toolCall: {
                id: call.id,
                name: call.name || 'unknown_tool',
                arguments: call.arguments,
                status: 'running',
              },
            };
            const processed = await this.processAgentToolCall(
              parsed.conversationId,
              selectedModel.id,
              call,
              actor,
              settings.toolOutputLimitBytes,
            );
            if (processed.fileChange !== undefined) {
              yield { type: 'file_change', requestId, fileChange: processed.fileChange };
            }
            yield {
              type: 'tool_call',
              requestId,
              toolCall: mapToolCallForRenderer(
                call,
                processed.envelope,
                processed.fileChange?.status,
              ),
            };
            canContinue &&= processed.continueGeneration;
          }
          processedAllToolCalls = true;
        } finally {
          if (processedAllToolCalls) {
            continuationSnapshot.sealed = true;
          } else {
            this.invalidateToolContinuationSnapshot(continuationSnapshot);
          }
        }
        if (!canContinue || round === 3) {
          if (canContinue) {
            this.consumeToolContinuationSnapshot(continuationSnapshot);
          }
          yield { type: 'done', requestId };
          return;
        }
        this.consumeToolContinuationSnapshot(continuationSnapshot);
        roundMessages = this.buildContinuationMessages(
          parsed.conversationId,
          actor,
          supplementalMessages,
        );
      }
    } finally {
      if (resumedContinuationSnapshot !== undefined && !resumedContinuationSettled) {
        this.releaseToolContinuationSnapshot(resumedContinuationSnapshot);
      }
    }
  }

  private async processAgentToolCall(
    conversationId: string,
    modelId: string,
    call: { id: string; name: string; arguments: string },
    actor: Actor,
    outputLimitBytes: number,
  ): Promise<{
    envelope: ToolResultEnvelope;
    fileChange?: { id: string; path: string; diff: string; status: 'pending' };
    continueGeneration: boolean;
  }> {
    if (call.name.startsWith('mcp_')) {
      return this.processMcpToolCall(conversationId, modelId, call, outputLimitBytes);
    }
    const startedAt = new Date();
    const binding = this.options.workspace.getBinding();
    const settings = this.options.services.settings.get();
    const permission = createToolPermissionMetadata(call.name, {
      bindingId: binding?.bindingId ?? null,
      conversationId,
      outputLimitBytes,
      timeoutMs: settings.toolCommandTimeoutMs,
    });
    let invocation: ParsedAgentToolInvocation;
    try {
      invocation = parseAgentToolInvocation(call.name, call.arguments);
    } catch (error) {
      const serialized = serializeDesktopError(error);
      const envelope = this.persistToolEnvelope(conversationId, {
        schemaVersion: 1,
        toolCallId: call.id,
        toolName: (call.name || 'unknown_tool').slice(0, 128),
        modelId,
        status: 'failed',
        bindingId: binding?.bindingId ?? null,
        error: serialized,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        permission,
      });
      return { envelope, continueGeneration: true };
    }

    const base = {
      schemaVersion: 1 as const,
      toolCallId: call.id,
      toolName: invocation.name,
      modelId,
      bindingId: binding?.bindingId ?? null,
      input: invocation.input as JsonValue,
      startedAt: startedAt.toISOString(),
      permission,
    };
    try {
      if (settings.toolExecutionPolicy === 'disabled') {
        throw new DesktopError(
          'TOOL_EXECUTION_DISABLED',
          '设置已禁止工具执行，未执行模型返回的工具调用',
        );
      }
      if (isWorkspaceBoundTool(invocation.name) && binding === undefined) {
        throw new DesktopError('WORKSPACE_NOT_BOUND', '请先绑定工作区，再使用文件或命令工具');
      }
      if (isWorkspaceBoundTool(invocation.name) && binding !== undefined) {
        this.options.workspace.assertBinding(binding.bindingId);
      }
      if (isAutomaticWorkspaceTool(invocation)) {
        const result = await executeAutomaticWorkspaceTool(
          this.options.workspace,
          invocation,
          outputLimitBytes,
        );
        this.options.workspace.assertBinding(binding?.bindingId ?? '');
        const envelope = this.persistToolEnvelope(conversationId, {
          ...base,
          status: 'completed',
          result: result as unknown as JsonValue,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        });
        return { envelope, continueGeneration: true };
      }
      if (invocation.name === 'computer_system_info') {
        const envelope = this.persistToolEnvelope(conversationId, {
          ...base,
          status: 'completed',
          result: safeSystemInfo(),
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        });
        return { envelope, continueGeneration: true };
      }
      if (isBrowserTool(invocation.name)) {
        if (this.options.browserTools === undefined) {
          throw new DesktopError(
            'BROWSER_UNAVAILABLE',
            '当前桌面运行环境没有初始化隔离浏览器服务。',
          );
        }
        const envelope = this.persistToolEnvelope(conversationId, {
          ...base,
          status: 'approval-required',
          result: {
            kind: 'browser-request',
            operation: invocation.name,
            ...('url' in invocation.input ? { url: invocation.input.url } : {}),
            ...('sessionId' in invocation.input ? { sessionId: invocation.input.sessionId } : {}),
            requiresApproval: true,
          },
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        });
        return { envelope, continueGeneration: false };
      }
      if (invocation.name === 'workspace_propose_write') {
        if (binding === undefined) {
          throw new DesktopError('WORKSPACE_NOT_BOUND', '请先绑定工作区，再修改文件。');
        }
        const fileChange = await this.proposeWorkspaceWrite(
          conversationId,
          invocation.input,
          actor,
          binding.bindingId,
        );
        const envelope = this.persistToolEnvelope(conversationId, {
          ...base,
          status: 'approval-required',
          result: {
            kind: 'file-change',
            changeId: fileChange.id,
            path: fileChange.path,
            diff: fileChange.diff,
            status: fileChange.status,
          },
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        });
        return { envelope, fileChange, continueGeneration: false };
      }
      if (invocation.name === 'computer_list_processes') {
        const envelope = this.persistToolEnvelope(conversationId, {
          ...base,
          status: 'approval-required',
          result: {
            kind: 'process-list',
            query: invocation.input.query,
            maxResults: invocation.input.maxResults,
            requiresApproval: true,
          },
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        });
        return { envelope, continueGeneration: false };
      }

      if (invocation.name !== 'workspace_run_command') {
        throw new DesktopError('TOOL_NOT_REGISTERED', '工具没有可执行的安全处理器。');
      }
      assertSafeCommand(invocation.input);
      const envelope = this.persistToolEnvelope(conversationId, {
        ...base,
        status: 'approval-required',
        result: {
          kind: 'command',
          executable: invocation.input.executable,
          args: invocation.input.args,
          cwd: invocation.input.cwd,
          ...(invocation.input.timeoutMs === undefined
            ? {}
            : { timeoutMs: invocation.input.timeoutMs }),
          requiresApproval: true,
        },
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      });
      return { envelope, continueGeneration: false };
    } catch (error) {
      const serialized = serializeDesktopError(error);
      const envelope = this.persistToolEnvelope(conversationId, {
        ...base,
        status: 'failed',
        error: serialized,
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      });
      return { envelope, continueGeneration: true };
    }
  }

  private async processMcpToolCall(
    conversationId: string,
    modelId: string,
    call: { id: string; name: string; arguments: string },
    outputLimitBytes: number,
  ): Promise<{ envelope: ToolResultEnvelope; continueGeneration: boolean }> {
    const startedAt = new Date();
    const bindingId = this.options.workspace.getBinding()?.bindingId ?? null;
    let input: Record<string, unknown> = {};
    try {
      if (this.options.mcpService === undefined) {
        throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
      }
      input = parseMcpToolArguments(call.arguments);
      const descriptor = await this.options.mcpService.describeTool(call.name);
      if (descriptor === undefined) {
        throw new DesktopError('MCP_TOOL_NOT_FOUND', 'MCP 工具不存在或所属 Server 未连接');
      }
      const settings = this.options.services.settings.get();
      if (settings.toolExecutionPolicy === 'disabled') {
        throw new DesktopError('TOOL_EXECUTION_DISABLED', '设置已禁止 MCP 工具执行');
      }
      const permission = createToolPermissionMetadata(call.name, {
        bindingId,
        conversationId,
        outputLimitBytes,
        timeoutMs: settings.toolCommandTimeoutMs,
        mcpApproval: 'required',
      });
      const base: Omit<ToolResultEnvelope, 'status'> = {
        schemaVersion: 1,
        toolCallId: call.id,
        toolName: call.name,
        modelId,
        bindingId,
        input: redactSensitive(input) as JsonValue,
        startedAt: startedAt.toISOString(),
        permission,
      };
      const envelope = this.persistToolEnvelope(conversationId, {
        ...base,
        status: 'approval-required',
        result: {
          kind: 'mcp-request',
          serverId: descriptor.serverId,
          serverName: descriptor.serverName,
          endpoint: descriptor.endpoint,
          originalToolName: descriptor.originalName,
          displayName: descriptor.title ?? descriptor.originalName,
          approvalIdentity: descriptor.approvalIdentity,
          bindingRevision: descriptor.bindingRevision,
          readOnlyHint: descriptor.annotations?.['readOnlyHint'] === true,
          destructiveHint: descriptor.annotations?.['destructiveHint'] === true,
          openWorldHint: descriptor.annotations?.['openWorldHint'] === true,
          requiresApproval: true,
        },
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      });
      return { envelope, continueGeneration: false };
    } catch (error) {
      const settings = this.options.services.settings.get();
      const envelope = this.persistToolEnvelope(conversationId, {
        schemaVersion: 1,
        toolCallId: call.id,
        toolName: call.name.slice(0, 128),
        modelId,
        status: 'failed',
        bindingId,
        input: redactSensitive(input) as JsonValue,
        error: serializeDesktopError(error),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        permission: createToolPermissionMetadata(call.name, {
          bindingId,
          conversationId,
          outputLimitBytes,
          timeoutMs: settings.toolCommandTimeoutMs,
          mcpApproval: 'required',
        }),
      });
      return { envelope, continueGeneration: true };
    }
  }

  private async executeMcpTool(
    conversationId: string,
    running: ToolResultEnvelope,
    descriptor: DesktopMcpToolDescriptor,
    input: Readonly<Record<string, unknown>>,
    outputLimitBytes: number,
    signal: AbortSignal,
  ): Promise<ToolResultEnvelope> {
    if (this.options.mcpService === undefined) {
      throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
    }
    const startedAt = Date.now();
    try {
      const result = await this.options.mcpService.callTool(descriptor.name, input, {
        expectedApprovalIdentity: descriptor.approvalIdentity,
        signal,
        timeoutMs: this.options.services.settings.get().toolCommandTimeoutMs,
      });
      const normalized = normalizeMcpToolResult(result, descriptor, outputLimitBytes);
      return this.persistToolEnvelope(conversationId, {
        ...running,
        status: result.isError ? 'failed' : 'completed',
        result: normalized,
        ...(result.isError
          ? {
              error: {
                code: 'MCP_TOOL_ERROR',
                message: mcpErrorMessage(normalized),
              },
            }
          : {}),
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      return this.persistToolEnvelope(conversationId, {
        ...running,
        status: 'failed',
        error: serializeDesktopError(error),
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    }
  }

  private async proposeWorkspaceWrite(
    conversationId: string,
    input: Extract<ParsedAgentToolInvocation, { name: 'workspace_propose_write' }>['input'],
    actor: Actor,
    bindingId: string,
  ): Promise<{ id: string; path: string; diff: string; status: 'pending' }> {
    const proposal = await this.options.workspace.proposeWrite(
      input.path,
      input.content,
      input.expectedHash,
    );
    if (proposal.bindingId !== bindingId) {
      this.options.workspace.rejectProposal(proposal.id);
      throw new DesktopError(
        'WORKSPACE_CHANGED',
        '工作区已在文件变更创建期间切换，提案已失效且不会写盘',
      );
    }
    let fileChange: ReturnType<CoreServices['conversations']['createFileChange']> | undefined;
    try {
      fileChange = this.options.services.conversations.createFileChange(
        conversationId,
        {
          path: proposal.path,
          diff: proposal.diff,
        },
        actor,
      );
      await this.options.fileChanges.register({
        changeId: fileChange.id,
        conversationId,
        proposal,
        requestedContent: input.content,
      });
      this.options.workspace.assertBinding(bindingId);
      return {
        id: fileChange.id,
        path: fileChange.path,
        diff: fileChange.diff,
        status: 'pending',
      };
    } catch (error) {
      try {
        this.options.workspace.rejectProposal(proposal.id);
      } catch {
        // 提案已经失效时仍保持未写盘语义。
      }
      if (fileChange !== undefined) {
        await this.options.fileChanges
          .complete(fileChange.id, conversationId)
          .catch(() => undefined);
        try {
          this.options.services.conversations.decideFileChange(
            conversationId,
            fileChange.id,
            { status: 'rejected' },
            actor,
          );
        } catch {
          // 原始错误优先；孤立的 pending 记录因缺少可信映射仍会 fail closed。
        }
      }
      throw error;
    }
  }

  private persistToolEnvelope(
    conversationId: string,
    envelope: ToolResultEnvelope,
  ): ToolResultEnvelope {
    const snapshot = this.toolContinuationSnapshotsByCall.get(
      toolContinuationCallKey(conversationId, envelope.toolCallId),
    );
    if (
      snapshot !== undefined &&
      envelope.continuationStateId !== undefined &&
      envelope.continuationStateId !== snapshot.id
    ) {
      throw new DesktopError(
        'TOOL_CONTINUATION_STATE_INVALID',
        '工具结果携带了不匹配的续写状态标识',
      );
    }
    const parsed = toolResultEnvelopeSchema.parse({
      ...envelope,
      ...(envelope.continuationStateId !== undefined
        ? { continuationStateId: envelope.continuationStateId }
        : snapshot === undefined
          ? {}
          : { continuationStateId: snapshot.id }),
    });
    this.options.services.repositories.conversations.addMessage({
      conversationId,
      role: 'tool',
      parentMessageId: parsed.toolCallId,
      content: serializeToolEnvelope(parsed),
    });
    return parsed;
  }

  private async decideWorkspaceFileChange(
    input: {
      conversationId: string;
      changeId: string;
      decision: 'accept' | 'reject';
    },
    actor: Actor,
  ) {
    const state = this.resolveWorkspaceFileChangeTool(input.conversationId, input.changeId, actor);
    this.assertToolContinuationDecisionIsSealed(input.conversationId, state.toolCall.id, actor);
    const existingDecision =
      state.fileChange.status === 'accepted'
        ? 'accept'
        : state.fileChange.status === 'rejected'
          ? 'reject'
          : undefined;
    if (existingDecision !== undefined) {
      if (existingDecision !== input.decision) {
        throw new DesktopError(
          'FILE_CHANGE_ALREADY_DECIDED',
          existingDecision === 'accept'
            ? '文件变更已经接受，不能改为拒绝'
            : '文件变更已经拒绝，不能改为接受',
        );
      }
      const expectedStatus = existingDecision === 'accept' ? 'completed' : 'rejected';
      if (
        state.envelope.status !== 'approval-required' &&
        state.envelope.status !== expectedStatus
      ) {
        throw new DesktopError(
          'FILE_CHANGE_TOOL_STATE_INVALID',
          '文件变更记录与工具执行状态不一致，无法安全恢复',
        );
      }
      const normalized = this.normalizeFileChangeEnvelope(
        state.envelope,
        state.fileChange,
        expectedStatus,
      );
      const terminal = isNormalizedFileChangeEnvelope(
        state.envelope,
        state.fileChange,
        expectedStatus,
      )
        ? state.envelope
        : this.persistToolEnvelope(input.conversationId, normalized);
      if (terminal !== state.envelope) {
        await this.completeFileChangeMapping(input.conversationId, input.changeId);
      }
      return mapToolCallForRenderer(
        {
          id: state.toolCall.id,
          name: state.toolCall.function.name,
          arguments: state.toolCall.function.arguments,
        },
        terminal,
        state.fileChange.status,
      );
    }
    if (state.envelope.status !== 'approval-required') {
      throw new DesktopError(
        'FILE_CHANGE_TOOL_STATE_INVALID',
        '文件变更尚未审批，但工具状态不允许继续执行',
      );
    }

    if (input.decision === 'accept') {
      await this.options.fileChanges.prepareAccept(input.changeId, input.conversationId, {
        id: actor.id,
        role: actor.role,
      });
    } else {
      await this.options.fileChanges.prepareReject(input.changeId, input.conversationId);
    }
    const decided = this.options.services.conversations.decideFileChange(
      input.conversationId,
      input.changeId,
      {
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
      },
      actor,
    );
    const terminal = this.persistToolEnvelope(
      input.conversationId,
      this.normalizeFileChangeEnvelope(
        state.envelope,
        decided,
        input.decision === 'accept' ? 'completed' : 'rejected',
      ),
    );
    this.options.services.repositories.audit.record({
      actorId: actor.id,
      action: input.decision === 'accept' ? 'tool.file-change.accept' : 'tool.file-change.reject',
      targetType: 'tool-call',
      targetId: state.toolCall.id,
      metadata: {
        conversationId: input.conversationId,
        changeId: input.changeId,
        path: decided.path,
      },
    });
    await this.completeFileChangeMapping(input.conversationId, input.changeId);
    return mapToolCallForRenderer(
      {
        id: state.toolCall.id,
        name: state.toolCall.function.name,
        arguments: state.toolCall.function.arguments,
      },
      terminal,
      decided.status,
    );
  }

  private resolveWorkspaceFileChangeTool(
    conversationId: string,
    changeId: string,
    actor: Actor,
  ): {
    toolCall: ConversationMessage['toolCalls'][number];
    envelope: ToolResultEnvelope;
    fileChange: ReturnType<CoreServices['conversations']['listFileChanges']>[number];
  } {
    const detail = this.options.services.conversations.get(conversationId, actor);
    const fileChange = this.options.services.conversations
      .listFileChanges(conversationId, actor)
      .find((candidate) => candidate.id === changeId);
    if (fileChange === undefined) {
      throw new DesktopError('FILE_CHANGE_NOT_FOUND', '待审批文件变更不存在或不属于当前会话');
    }

    const latestEnvelopes = new Map<string, ToolResultEnvelope>();
    for (const message of detail.messages) {
      if (message.role !== 'tool' || message.parentMessageId === null) continue;
      const envelope = parseToolEnvelope(message.content);
      if (envelope?.toolCallId === message.parentMessageId) {
        latestEnvelopes.set(envelope.toolCallId, envelope);
      }
    }
    const associations = [...latestEnvelopes.values()].filter((envelope) => {
      const result = jsonObject(envelope.result);
      return result?.['kind'] === 'file-change' && result['changeId'] === changeId;
    });
    if (associations.length !== 1) {
      throw new DesktopError(
        associations.length === 0 ? 'FILE_CHANGE_TOOL_NOT_FOUND' : 'FILE_CHANGE_TOOL_AMBIGUOUS',
        associations.length === 0
          ? '文件变更没有关联可信的工具调用，已拒绝审批'
          : '文件变更关联了多个工具调用，已拒绝审批',
      );
    }
    const envelope = associations[0];
    if (envelope === undefined) {
      throw new DesktopError('FILE_CHANGE_TOOL_NOT_FOUND', '文件变更没有关联可信的工具调用');
    }
    const toolCalls = detail.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.toolCalls.filter((toolCall) => toolCall.id === envelope.toolCallId)
        : [],
    );
    const toolCall = toolCalls[0];
    const result = jsonObject(envelope.result);
    if (
      toolCalls.length !== 1 ||
      toolCall === undefined ||
      toolCall.function.name !== 'workspace_propose_write' ||
      result?.['path'] !== fileChange.path ||
      result['diff'] !== fileChange.diff
    ) {
      throw new DesktopError(
        'FILE_CHANGE_TOOL_STATE_INVALID',
        '文件变更与工具调用的持久化数据不一致，已拒绝审批',
      );
    }
    return { toolCall, envelope, fileChange };
  }

  private normalizeFileChangeEnvelope(
    envelope: ToolResultEnvelope,
    fileChange: ReturnType<CoreServices['conversations']['listFileChanges']>[number],
    status: 'completed' | 'rejected',
  ): ToolResultEnvelope {
    const finishedAt = new Date().toISOString();
    const startedAt =
      envelope.startedAt === undefined ? undefined : new Date(envelope.startedAt).getTime();
    return toolResultEnvelopeSchema.parse({
      ...envelope,
      status,
      result: {
        kind: 'file-change',
        changeId: fileChange.id,
        path: fileChange.path,
        diff: fileChange.diff,
        status: fileChange.status,
      },
      error: undefined,
      finishedAt,
      ...(startedAt === undefined ? {} : { durationMs: Math.max(0, Date.now() - startedAt) }),
    });
  }

  private async completeFileChangeMapping(conversationId: string, changeId: string): Promise<void> {
    try {
      await this.options.fileChanges.complete(changeId, conversationId);
    } catch (error) {
      if (error instanceof DesktopError && error.code === 'FILE_CHANGE_MAPPING_MISSING') {
        return;
      }
      this.options.logger.warn('文件变更已提交但恢复映射清理失败', {
        conversationId,
        changeId,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private buildContinuationMessages(
    conversationId: string,
    actor: Actor,
    supplementalMessages: readonly ChatMessageInput[],
  ): ChatMessageInput[] {
    const messages = this.options.services.conversations.get(conversationId, actor).messages;
    const latestToolMessageIds = new Map<string, string>();
    for (const message of messages) {
      if (message.role === 'tool' && message.parentMessageId !== null) {
        latestToolMessageIds.set(message.parentMessageId, message.id);
      }
    }
    const history = messages
      .filter(
        (message) =>
          message.role !== 'tool' ||
          message.parentMessageId === null ||
          latestToolMessageIds.get(message.parentMessageId) === message.id,
      )
      .map(mapConversationMessageToPrompt);
    return [...supplementalMessages, ...history];
  }

  private resolveToolContinuation(
    conversationId: string,
    toolCallId: string,
    actor: Actor,
  ): {
    messages: ChatMessageInput[];
    modelId: string;
    supplementalMessages: ChatMessageInput[];
    skill?: string;
    snapshot?: ToolContinuationSnapshot;
  } {
    this.pruneToolContinuationState();
    const callKey = toolContinuationCallKey(conversationId, toolCallId);
    if (this.toolContinuationTombstones.has(callKey)) {
      throw new DesktopError(
        'TOOL_CONTINUATION_ALREADY_USED',
        '该工具结果已经续写或续写上下文已过期，不能重复生成',
      );
    }

    const group = this.resolveTerminalToolCallGroup(conversationId, toolCallId, actor);
    const snapshot = this.toolContinuationSnapshotsByCall.get(callKey);
    let supplementalMessages: ChatMessageInput[] = [];
    let modelId = this.resolveToolContinuationModelId(
      group.canonicalEnvelope,
      group.assistantMessage,
    );
    let skill: string | undefined;
    if (snapshot !== undefined) {
      if (
        snapshot.actorId !== actor.id ||
        snapshot.conversationId !== conversationId ||
        !snapshot.sealed ||
        group.continuationStateId !== snapshot.id ||
        toolCallId !== group.canonicalToolCallId ||
        !sameStringArrays(snapshot.toolCallIds, group.toolCallIds)
      ) {
        this.invalidateToolContinuationSnapshot(snapshot);
        throw new DesktopError(
          'TOOL_CONTINUATION_STATE_INVALID',
          '工具续写状态与会话记录不一致，已拒绝继续生成',
        );
      }
      if (snapshot.claimed) {
        throw new DesktopError(
          'TOOL_CONTINUATION_IN_PROGRESS',
          '该工具结果正在续写中，不能并发重复生成',
        );
      }
      if (snapshot.modelId !== modelId) {
        this.invalidateToolContinuationSnapshot(snapshot);
        throw new DesktopError(
          'TOOL_CONTINUATION_MODEL_CHANGED',
          '工具审批前后的模型状态不一致，已拒绝继续生成',
        );
      }
      supplementalMessages = cloneChatMessages(snapshot.supplementalMessages);
      modelId = snapshot.modelId;
      skill = snapshot.skill;
    } else if (group.continuationStateId !== undefined) {
      this.markToolContinuationCallsUsed(conversationId, group.toolCallIds);
      throw new DesktopError(
        'TOOL_CONTINUATION_CONTEXT_EXPIRED',
        '工具续写上下文已随应用重启或超时失效，请重新发起原始请求',
      );
    }

    if (snapshot !== undefined) {
      snapshot.claimed = true;
    } else {
      this.markToolContinuationCallsUsed(conversationId, group.toolCallIds);
    }
    return {
      messages: this.buildContinuationMessages(conversationId, actor, supplementalMessages),
      modelId,
      supplementalMessages,
      ...(skill === undefined ? {} : { skill }),
      ...(snapshot === undefined ? {} : { snapshot }),
    };
  }

  private registerToolContinuationSnapshot(input: {
    actorId: string;
    conversationId: string;
    modelId: string;
    skill: string | undefined;
    toolCallIds: readonly string[];
    supplementalMessages: readonly ChatMessageInput[];
  }): ToolContinuationSnapshot {
    this.pruneToolContinuationState();
    if (
      input.toolCallIds.length === 0 ||
      input.toolCallIds.length > 64 ||
      new Set(input.toolCallIds).size !== input.toolCallIds.length ||
      input.toolCallIds.some((toolCallId) => toolCallId.length === 0 || toolCallId.length > 256)
    ) {
      throw new DesktopError(
        'TOOL_CONTINUATION_GROUP_INVALID',
        '模型返回的工具调用组无法建立安全续写状态',
      );
    }
    for (const toolCallId of input.toolCallIds) {
      const callKey = toolContinuationCallKey(input.conversationId, toolCallId);
      if (
        this.toolContinuationSnapshotsByCall.has(callKey) ||
        this.toolContinuationTombstones.has(callKey)
      ) {
        throw new DesktopError(
          'TOOL_CONTINUATION_GROUP_DUPLICATE',
          '工具调用标识已用于其他续写状态，已拒绝继续处理',
        );
      }
    }

    const bounded = cloneBoundedSupplementalMessages(input.supplementalMessages);
    if (
      this.toolContinuationSnapshots.size >= maximumToolContinuationSnapshots ||
      this.toolContinuationSnapshotBytes + bounded.byteLength >
        maximumToolContinuationSnapshotTotalBytes
    ) {
      throw new DesktopError(
        'TOOL_CONTINUATION_CAPACITY_EXCEEDED',
        '待审批工具的安全续写上下文已达到内存上限，请先处理现有审批',
      );
    }
    const snapshot: ToolContinuationSnapshot = {
      id: randomUUID(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      modelId: input.modelId,
      ...(input.skill === undefined ? {} : { skill: input.skill }),
      toolCallIds: Object.freeze([...input.toolCallIds]),
      supplementalMessages: Object.freeze(bounded.messages),
      byteLength: bounded.byteLength,
      expiresAt: Date.now() + toolContinuationSnapshotTtlMs,
      sealed: false,
      claimed: false,
    };
    this.toolContinuationSnapshots.add(snapshot);
    this.toolContinuationSnapshotBytes += snapshot.byteLength;
    for (const toolCallId of snapshot.toolCallIds) {
      this.toolContinuationSnapshotsByCall.set(
        toolContinuationCallKey(snapshot.conversationId, toolCallId),
        snapshot,
      );
    }
    return snapshot;
  }

  private attachToolContinuationTicket(
    conversationId: string,
    toolCallId: string,
    actor: Actor,
    toolCall: ReturnType<typeof mapToolCallForRenderer>,
  ): ReturnType<typeof mapToolCallForRenderer> {
    this.pruneToolContinuationState();
    const callKey = toolContinuationCallKey(conversationId, toolCallId);
    if (this.toolContinuationTombstones.has(callKey)) return toolCall;

    const snapshot = this.toolContinuationSnapshotsByCall.get(callKey);
    if (
      snapshot !== undefined &&
      (snapshot.actorId !== actor.id ||
        snapshot.conversationId !== conversationId ||
        !snapshot.sealed ||
        snapshot.claimed)
    ) {
      return toolCall;
    }
    let group: TerminalToolCallGroup;
    try {
      group = this.resolveTerminalToolCallGroup(conversationId, toolCallId, actor);
    } catch (error) {
      if (
        error instanceof DesktopError &&
        ['TOOL_CONTINUATION_NOT_READY', 'TOOL_CALL_AMBIGUOUS'].includes(error.code)
      ) {
        return toolCall;
      }
      this.options.logger.warn('工具已经完成，但续写资格校验失败', {
        conversationId,
        toolCallId,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return toolCall;
    }
    if (
      snapshot !== undefined &&
      (group.continuationStateId !== snapshot.id ||
        !sameStringArrays(snapshot.toolCallIds, group.toolCallIds))
    ) {
      this.invalidateToolContinuationSnapshot(snapshot);
      return toolCall;
    }
    if (snapshot === undefined && group.continuationStateId !== undefined) return toolCall;

    return {
      ...toolCall,
      metadata: {
        ...(toolCall.metadata ?? {}),
        continuationToolCallId: group.canonicalToolCallId,
      },
    };
  }

  private resolveTerminalToolCallGroup(
    conversationId: string,
    toolCallId: string,
    actor: Actor,
  ): TerminalToolCallGroup {
    const detail = this.options.services.conversations.get(conversationId, actor);
    const origins = assistantToolCallOrigins(detail.messages, toolCallId);
    const origin = origins[0];
    if (origin === undefined) {
      throw new DesktopError(
        'TOOL_CONTINUATION_NOT_READY',
        '工具调用不存在或不属于当前会话，不能继续生成',
      );
    }
    if (origins.length !== 1) {
      throw new DesktopError('TOOL_CALL_AMBIGUOUS', '会话中存在重复的工具调用标识，已拒绝继续生成');
    }
    const toolCallIds = origin.message.toolCalls.map((candidate) => candidate.id);
    if (toolCallIds.length === 0 || new Set(toolCallIds).size !== toolCallIds.length) {
      throw new DesktopError(
        'TOOL_CALL_AMBIGUOUS',
        '同一回复中存在重复的工具调用标识，已拒绝继续生成',
      );
    }

    let canonicalEnvelope: ToolResultEnvelope | undefined;
    const continuationStateIds: Array<string | undefined> = [];
    for (const siblingToolCallId of toolCallIds) {
      const siblingOrigins = assistantToolCallOrigins(detail.messages, siblingToolCallId);
      if (siblingOrigins.length !== 1 || siblingOrigins[0]?.message.id !== origin.message.id) {
        throw new DesktopError('TOOL_CALL_AMBIGUOUS', '工具调用组与会话记录不一致，已拒绝继续生成');
      }
      const envelope = latestToolEnvelope(detail.messages, siblingToolCallId);
      if (envelope === undefined || !isTerminalToolStatus(envelope.status)) {
        throw new DesktopError(
          'TOOL_CONTINUATION_NOT_READY',
          '同一回复中的工具尚未全部完成审批，不能继续生成',
        );
      }
      continuationStateIds.push(envelope.continuationStateId);
      if (siblingToolCallId === toolCallIds[0]) canonicalEnvelope = envelope;
    }
    if (canonicalEnvelope === undefined) {
      throw new DesktopError('TOOL_CONTINUATION_NOT_READY', '工具调用组尚未完成，不能继续生成');
    }
    const persistedStateIds = new Set(
      continuationStateIds.filter((stateId): stateId is string => stateId !== undefined),
    );
    if (
      persistedStateIds.size > 1 ||
      (persistedStateIds.size === 1 &&
        continuationStateIds.some((stateId) => stateId === undefined))
    ) {
      throw new DesktopError(
        'TOOL_CONTINUATION_STATE_INVALID',
        '同一工具组的续写状态标识不一致，已拒绝继续生成',
      );
    }
    const continuationStateId = persistedStateIds.values().next().value as string | undefined;
    return {
      assistantMessage: origin.message,
      canonicalToolCallId: toolCallIds[0] ?? toolCallId,
      toolCallIds,
      canonicalEnvelope,
      ...(continuationStateId === undefined ? {} : { continuationStateId }),
    };
  }

  private assertToolContinuationDecisionIsSealed(
    conversationId: string,
    toolCallId: string,
    actor: Actor,
  ): void {
    this.pruneToolContinuationState();
    const snapshot = this.toolContinuationSnapshotsByCall.get(
      toolContinuationCallKey(conversationId, toolCallId),
    );
    if (snapshot === undefined) return;
    if (snapshot.actorId !== actor.id || snapshot.conversationId !== conversationId) {
      throw new DesktopError('FORBIDDEN', '当前用户不能审批其他会话请求创建的工具调用');
    }
    if (!snapshot.sealed) {
      throw new DesktopError(
        'TOOL_CONTINUATION_GROUP_STREAMING',
        '模型仍在提交同一组工具调用，请等待本轮响应结束后再审批',
      );
    }
  }

  private consumeToolContinuationSnapshot(snapshot: ToolContinuationSnapshot): void {
    this.removeToolContinuationSnapshot(snapshot);
    this.markToolContinuationCallsUsed(snapshot.conversationId, snapshot.toolCallIds);
  }

  private releaseToolContinuationSnapshot(snapshot: ToolContinuationSnapshot): void {
    if (!this.toolContinuationSnapshots.has(snapshot)) return;
    if (snapshot.expiresAt <= Date.now()) {
      this.invalidateToolContinuationSnapshot(snapshot);
      return;
    }
    snapshot.claimed = false;
  }

  private invalidateToolContinuationSnapshot(snapshot: ToolContinuationSnapshot): void {
    this.removeToolContinuationSnapshot(snapshot);
    this.markToolContinuationCallsUsed(snapshot.conversationId, snapshot.toolCallIds);
  }

  private removeToolContinuationSnapshot(snapshot: ToolContinuationSnapshot): void {
    if (!this.toolContinuationSnapshots.delete(snapshot)) return;
    this.toolContinuationSnapshotBytes = Math.max(
      0,
      this.toolContinuationSnapshotBytes - snapshot.byteLength,
    );
    for (const toolCallId of snapshot.toolCallIds) {
      const key = toolContinuationCallKey(snapshot.conversationId, toolCallId);
      if (this.toolContinuationSnapshotsByCall.get(key) === snapshot) {
        this.toolContinuationSnapshotsByCall.delete(key);
      }
    }
  }

  private markToolContinuationCallsUsed(
    conversationId: string,
    toolCallIds: readonly string[],
  ): void {
    const expiresAt = Date.now() + toolContinuationTombstoneTtlMs;
    for (const toolCallId of toolCallIds) {
      this.toolContinuationTombstones.set(
        toolContinuationCallKey(conversationId, toolCallId),
        expiresAt,
      );
    }
    while (this.toolContinuationTombstones.size > maximumToolContinuationTombstones) {
      const oldestKey = this.toolContinuationTombstones.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.toolContinuationTombstones.delete(oldestKey);
    }
  }

  private pruneToolContinuationState(now = Date.now()): void {
    for (const [key, expiresAt] of this.toolContinuationTombstones) {
      if (expiresAt <= now) this.toolContinuationTombstones.delete(key);
    }
    for (const snapshot of this.toolContinuationSnapshots) {
      if (!snapshot.claimed && snapshot.expiresAt <= now) {
        this.invalidateToolContinuationSnapshot(snapshot);
      }
    }
  }

  private clearToolContinuationState(): void {
    this.toolContinuationSnapshots.clear();
    this.toolContinuationSnapshotsByCall.clear();
    this.toolContinuationTombstones.clear();
    this.toolContinuationSnapshotBytes = 0;
  }

  private resolveToolContinuationModelId(
    envelope: ToolResultEnvelope,
    assistantMessage: ConversationMessage,
  ): string {
    if (envelope.modelId !== undefined) {
      if (this.options.services.repositories.models.get(envelope.modelId) === undefined) {
        throw new DesktopError(
          'TOOL_CONTINUATION_MODEL_NOT_FOUND',
          '工具调用所使用的模型已不存在，无法继续生成',
        );
      }
      return envelope.modelId;
    }

    const legacyModel = assistantMessage.model;
    if (legacyModel === null || legacyModel.trim() === '') {
      throw new DesktopError(
        'TOOL_CONTINUATION_MODEL_NOT_FOUND',
        '旧版工具调用没有记录可恢复的模型，无法继续生成',
      );
    }
    const remoteMatches = this.options.services.repositories.models
      .list()
      .filter((model) => model.remoteId === legacyModel);
    if (remoteMatches.length > 1) {
      throw new DesktopError(
        'TOOL_CONTINUATION_MODEL_AMBIGUOUS',
        '旧版工具调用对应多个同名模型，请重新发起请求后再执行工具',
      );
    }
    const remoteMatch = remoteMatches[0];
    if (remoteMatch !== undefined) return remoteMatch.id;

    const exactMatch = this.options.services.repositories.models.get(legacyModel);
    if (exactMatch !== undefined) return exactMatch.id;
    throw new DesktopError(
      'TOOL_CONTINUATION_MODEL_NOT_FOUND',
      '旧版工具调用所使用的模型已不存在，无法继续生成',
    );
  }

  private async decideToolCall(
    input: {
      conversationId: string;
      toolCallId: string;
      decision: 'approve' | 'reject';
    },
    actor: Actor,
  ) {
    const detail = this.options.services.conversations.get(input.conversationId, actor);
    const origins = assistantToolCallOrigins(detail.messages, input.toolCallId);
    const toolCall = origins[0]?.toolCall;
    if (toolCall === undefined) {
      throw new DesktopError('TOOL_CALL_NOT_FOUND', '工具调用不存在或不属于当前会话');
    }
    if (origins.length !== 1) {
      throw new DesktopError(
        'TOOL_CALL_AMBIGUOUS',
        '会话中存在重复的工具调用标识，已拒绝执行审批操作',
      );
    }
    const isMcp = toolCall.function.name.startsWith('mcp_');
    const isBrowser = isBrowserTool(toolCall.function.name);
    if (
      !isMcp &&
      !isBrowser &&
      toolCall.function.name !== 'workspace_run_command' &&
      toolCall.function.name !== 'computer_list_processes'
    ) {
      throw new DesktopError('TOOL_DECISION_UNSUPPORTED', '该工具不通过命令审批通道执行');
    }
    let invocation: ParsedAgentToolInvocation | undefined;
    if (!isMcp) {
      const parsedInvocation = parseAgentToolInvocation(
        toolCall.function.name,
        toolCall.function.arguments,
      );
      if (
        parsedInvocation.name !== 'workspace_run_command' &&
        parsedInvocation.name !== 'computer_list_processes' &&
        !isBrowserTool(parsedInvocation.name)
      ) {
        throw new DesktopError('TOOL_DECISION_UNSUPPORTED', '该工具不是可审批工具');
      }
      invocation = parsedInvocation;
    }
    const current = latestToolEnvelope(detail.messages, input.toolCallId);
    if (current === undefined) {
      throw new DesktopError('TOOL_STATE_NOT_FOUND', '工具审批状态不存在');
    }
    this.assertToolContinuationDecisionIsSealed(input.conversationId, input.toolCallId, actor);
    if (isTerminalToolStatus(current.status)) {
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        current,
      );
    }
    if (current.status === 'running') {
      const interrupted = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'failed',
        error: {
          code: 'TOOL_EXECUTION_INTERRUPTED',
          message: '上一次命令执行已被应用退出中断，不能自动重放',
        },
        finishedAt: new Date().toISOString(),
      });
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        interrupted,
      );
    }
    if (current.status !== 'approval-required') {
      throw new DesktopError('TOOL_STATE_INVALID', '工具当前状态不能执行审批操作');
    }
    if (input.decision === 'reject') {
      this.options.services.repositories.audit.record({
        actorId: actor.id,
        action: isMcp
          ? 'tool.mcp.reject'
          : isBrowser
            ? 'tool.browser.reject'
            : invocation?.name === 'workspace_run_command'
              ? 'tool.command.reject'
              : 'tool.process-inspection.reject',
        targetType: 'tool-call',
        targetId: input.toolCallId,
        metadata: { conversationId: input.conversationId },
      });
      const rejected = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'rejected',
        result: {
          kind: isMcp
            ? 'mcp-request'
            : isBrowser
              ? 'browser-request'
              : invocation?.name === 'workspace_run_command'
                ? 'command'
                : 'process-list',
          rejected: true,
        },
        finishedAt: new Date().toISOString(),
      });
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        rejected,
      );
    }

    const settings = this.options.services.settings.get();
    if (settings.toolExecutionPolicy === 'disabled') {
      const disabled = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'failed',
        error: {
          code: 'TOOL_EXECUTION_DISABLED',
          message: '设置已禁止工具执行，命令未运行',
        },
        finishedAt: new Date().toISOString(),
      });
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        disabled,
      );
    }
    if (isMcp) {
      if (this.options.mcpService === undefined) {
        throw new DesktopError('MCP_UNAVAILABLE', '桌面 MCP 运行时尚未初始化');
      }
      const descriptor = await this.options.mcpService.describeTool(toolCall.function.name);
      if (descriptor === undefined) {
        throw new DesktopError('MCP_TOOL_NOT_FOUND', 'MCP 工具不存在或所属 Server 未连接');
      }
      const approvedRequest = jsonObject(current.result);
      const approvalIdentity =
        typeof approvedRequest?.['approvalIdentity'] === 'string'
          ? approvedRequest['approvalIdentity']
          : undefined;
      const bindingMatches =
        approvedRequest?.['kind'] === 'mcp-request' &&
        approvedRequest['serverId'] === descriptor.serverId &&
        approvedRequest['originalToolName'] === descriptor.originalName &&
        approvedRequest['bindingRevision'] === descriptor.bindingRevision &&
        approvalIdentity === descriptor.approvalIdentity;
      if (!bindingMatches || approvalIdentity === undefined) {
        this.options.services.repositories.audit.record({
          actorId: actor.id,
          action: 'tool.mcp.binding-changed',
          targetType: 'tool-call',
          targetId: input.toolCallId,
          metadata: { conversationId: input.conversationId },
        });
        const stale = this.persistToolEnvelope(input.conversationId, {
          ...current,
          status: 'failed',
          error: {
            code: 'MCP_TOOL_BINDING_CHANGED',
            message: 'MCP Server 或工具定义在审批前发生变化，请重新发起调用',
          },
          finishedAt: new Date().toISOString(),
        });
        return mapToolCallForRenderer(
          {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
          stale,
        );
      }
      const argumentsValue = parseMcpToolArguments(toolCall.function.arguments);
      this.options.services.repositories.audit.record({
        actorId: actor.id,
        action: 'tool.mcp.approve',
        targetType: 'tool-call',
        targetId: input.toolCallId,
        metadata: {
          conversationId: input.conversationId,
          serverId: descriptor.serverId,
          tool: descriptor.originalName,
        },
      });
      const running = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        durationMs: undefined,
      });
      const terminal = await this.executeMcpTool(
        input.conversationId,
        running,
        descriptor,
        argumentsValue,
        settings.toolOutputLimitBytes,
        this.shutdownController.signal,
      );
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        terminal,
      );
    }
    if (invocation === undefined) {
      throw new DesktopError('TOOL_DECISION_UNSUPPORTED', '工具审批类型无效');
    }
    if (isBrowser) {
      if (this.options.browserTools === undefined) {
        throw new DesktopError('BROWSER_UNAVAILABLE', '当前桌面运行环境没有初始化隔离浏览器服务。');
      }
      const browserInvocation = invocation as BrowserToolArguments;
      const approvedRequest = jsonObject(current.result);
      const approvedUrl =
        'url' in browserInvocation.input ? browserInvocation.input.url : undefined;
      const sessionId =
        'sessionId' in browserInvocation.input ? browserInvocation.input.sessionId : undefined;
      const approvalMatches =
        approvedRequest?.['kind'] === 'browser-request' &&
        approvedRequest['operation'] === browserInvocation.name &&
        (approvedUrl === undefined || approvedRequest['url'] === approvedUrl) &&
        (sessionId === undefined || approvedRequest['sessionId'] === sessionId);
      if (!approvalMatches) {
        const stale = this.persistToolEnvelope(input.conversationId, {
          ...current,
          status: 'failed',
          error: {
            code: 'BROWSER_APPROVAL_BINDING_CHANGED',
            message: '浏览器工具参数在审批前发生变化，已拒绝执行。',
          },
          finishedAt: new Date().toISOString(),
        });
        return mapToolCallForRenderer(
          {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
          stale,
        );
      }
      this.options.services.repositories.audit.record({
        actorId: actor.id,
        action: 'tool.browser.approve',
        targetType: 'tool-call',
        targetId: input.toolCallId,
        metadata: {
          conversationId: input.conversationId,
          operation: browserInvocation.name,
        },
      });
      const running = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        durationMs: undefined,
      });
      const startedAt = Date.now();
      let terminal: ToolResultEnvelope;
      try {
        const result = await this.options.browserTools.execute(browserInvocation, {
          conversationId: input.conversationId,
          outputLimitBytes: settings.toolOutputLimitBytes,
          timeoutMs: Math.min(settings.toolCommandTimeoutMs, 60_000),
          signal: this.shutdownController.signal,
          ...(approvedUrl === undefined ? {} : { networkNavigationApproval: { approvedUrl } }),
        });
        terminal = this.persistToolEnvelope(input.conversationId, {
          ...running,
          status: 'completed',
          result: result as JsonValue,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      } catch (error) {
        terminal = this.persistToolEnvelope(input.conversationId, {
          ...running,
          status: 'failed',
          error: serializeDesktopError(error),
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        terminal,
      );
    }
    if (invocation.name === 'computer_list_processes') {
      this.options.services.repositories.audit.record({
        actorId: actor.id,
        action: 'tool.process-inspection.approve',
        targetType: 'tool-call',
        targetId: input.toolCallId,
        metadata: {
          conversationId: input.conversationId,
          query: invocation.input.query,
        },
      });
      const running = this.persistToolEnvelope(input.conversationId, {
        ...current,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        durationMs: undefined,
      });
      let terminal: ToolResultEnvelope;
      const startedAt = Date.now();
      try {
        const result = await this.options.processInspector.list(invocation.input, {
          timeoutMs: Math.min(settings.toolCommandTimeoutMs, 30_000),
          outputLimitBytes: settings.toolOutputLimitBytes,
          signal: this.shutdownController.signal,
        });
        terminal = this.persistToolEnvelope(input.conversationId, {
          ...running,
          status: 'completed',
          result: result as unknown as JsonValue,
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      } catch (error) {
        terminal = this.persistToolEnvelope(input.conversationId, {
          ...running,
          status: 'failed',
          error: serializeDesktopError(error),
          finishedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }
      return mapToolCallForRenderer(
        {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        terminal,
      );
    }
    if (invocation.name !== 'workspace_run_command') {
      throw new DesktopError('TOOL_DECISION_UNSUPPORTED', '工具审批类型无效');
    }
    if (current.bindingId === null) {
      throw new DesktopError('WORKSPACE_NOT_BOUND', '工具创建时未绑定工作区，不能执行命令');
    }
    this.options.workspace.assertBinding(current.bindingId);
    assertSafeCommand(invocation.input);
    this.options.services.repositories.audit.record({
      actorId: actor.id,
      action: 'tool.command.approve',
      targetType: 'tool-call',
      targetId: input.toolCallId,
      metadata: {
        conversationId: input.conversationId,
        executable: invocation.input.executable,
      },
    });
    const running = this.persistToolEnvelope(input.conversationId, {
      ...current,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      durationMs: undefined,
    });
    let terminal: ToolResultEnvelope;
    try {
      const result = await this.options.commandRunner.run(invocation.input, {
        bindingId: current.bindingId,
        timeoutMs: settings.toolCommandTimeoutMs,
        outputLimitBytes: settings.toolOutputLimitBytes,
        signal: this.shutdownController.signal,
      });
      terminal = this.persistCommandResult(input.conversationId, running, result);
    } catch (error) {
      terminal = this.persistToolEnvelope(input.conversationId, {
        ...running,
        status: 'failed',
        error: serializeDesktopError(error),
        finishedAt: new Date().toISOString(),
      });
    }
    return mapToolCallForRenderer(
      {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
      terminal,
    );
  }

  private persistCommandResult(
    conversationId: string,
    running: ToolResultEnvelope,
    result: CommandRunResult,
  ): ToolResultEnvelope {
    return this.persistToolEnvelope(conversationId, {
      ...running,
      status: result.status,
      result: {
        kind: 'command',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        truncated: result.truncated,
        ...(result.error === undefined ? {} : { error: result.error }),
      },
      ...(result.error === undefined
        ? {}
        : { error: { code: 'COMMAND_FAILED', message: result.error } }),
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs,
    });
  }

  private async exclusiveToolDecision<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.toolDecisionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.toolDecisionTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      void tail.finally(() => {
        if (this.toolDecisionTails.get(key) === tail) {
          this.toolDecisionTails.delete(key);
        }
      });
    }
  }

  private async notifyCostAlertIfNeeded(): Promise<void> {
    if (this.options.notifyCostAlert === undefined) {
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const summary = this.options.services.usage.summary({
      ...dateRange('day'),
      groupBy: 'day',
      limit: 100,
    });
    if (!summary.costAlert.exceeded) {
      return;
    }
    const persisted = this.options.services.repositories.settings.get<{
      lastNotifiedDate?: string;
    }>(costAlertNotificationScope);
    if (persisted?.lastNotifiedDate === today || this.notifyingCostAlertDays.has(today)) {
      return;
    }
    this.notifyingCostAlertDays.add(today);
    try {
      await this.options.notifyCostAlert({
        currentUsd: summary.costAlert.currentUsd,
        thresholdUsd: summary.costAlert.thresholdUsd,
      });
      this.options.services.repositories.settings.set(costAlertNotificationScope, {
        lastNotifiedDate: today,
      });
    } finally {
      this.notifyingCostAlertDays.delete(today);
    }
  }
}

function futureExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

function mapAuthResponse(response: AuthResponse): SessionInfo {
  return mapSessionUser(response.user, response.expiresAt);
}

function mapSessionUser(user: CoreUser, expiresAt: string): SessionInfo {
  return {
    user: {
      id: user.id,
      name: user.displayName,
      email: user.email,
      role: user.role,
      active: user.active,
    },
    expiresAt,
  };
}

function providerType(value: string): Provider['type'] {
  const normalized = value.toLowerCase().replace(/\s+/gu, '-');
  if (normalized.includes('openai') && normalized.includes('compatible')) {
    return 'custom';
  }
  if (normalized.includes('openai')) return 'openai';
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('groq')) return 'groq';
  if (normalized.includes('google')) return 'google';
  if (normalized.includes('ollama')) return 'ollama';
  return 'custom';
}

function defaultProviderUrl(type: Provider['type']): string {
  const values: Record<Provider['type'], string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    ollama: 'http://127.0.0.1:11434/v1',
    custom: 'https://api.openai.com/v1',
  };
  return values[type];
}

function coreStrategy(value: 'round-robin' | 'priority' | 'failover'): Provider['keyStrategy'] {
  return value === 'round-robin' ? 'round-robin' : 'priority';
}

function ensureProvider(
  services: CoreServices,
  input: {
    provider: string;
    providerName?: string;
    baseUrl?: string;
    strategy: 'round-robin' | 'priority' | 'failover';
  },
  actorId: string,
): Provider {
  const providers = services.keys.list().providers;
  const type = providerType(input.provider);
  const baseUrl = normalizeProviderUrl(input.baseUrl ?? defaultProviderUrl(type));
  const requiresIsolatedProvider = type === 'custom' || input.baseUrl !== undefined;
  const providerLabel = input.provider.trim();
  const requestedName =
    input.providerName?.trim() ||
    (type === 'custom' && !isGenericCustomProviderLabel(providerLabel)
      ? providerLabel
      : requiresIsolatedProvider
        ? providerNameFromUrl(baseUrl)
        : providerLabel);
  const normalizedInput = input.provider.toLowerCase();
  let provider = requiresIsolatedProvider
    ? providers.find(
        (candidate) =>
          candidate.type === type &&
          normalizeProviderUrl(candidate.baseUrl) === baseUrl &&
          candidate.name.toLowerCase() === requestedName.toLowerCase(),
      )
    : providers.find(
        (candidate) =>
          candidate.id.toLowerCase() === normalizedInput ||
          candidate.name.toLowerCase() === normalizedInput,
      );
  if (provider === undefined && !requiresIsolatedProvider) {
    provider = providers.find((candidate) => candidate.type === type);
  }
  if (provider === undefined) {
    return services.keys.createProvider(
      {
        type,
        name: uniqueProviderName(requestedName, providers),
        baseUrl,
        keyStrategy: coreStrategy(input.strategy),
      },
      actorId,
    );
  }
  const strategy = coreStrategy(input.strategy);
  if (strategy !== provider.keyStrategy) {
    provider = services.keys.updateProvider(
      provider.id,
      {
        keyStrategy: strategy,
      },
      actorId,
    );
  }
  return provider;
}

function normalizeProviderUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/u, '');
}

function providerNameFromUrl(value: string): string {
  const hostname = new URL(value).hostname.replace(/^www\./u, '');
  return hostname === '' ? '自定义服务商' : hostname.slice(0, 120);
}

function isGenericCustomProviderLabel(value: string): boolean {
  return ['custom', 'openai-compatible'].includes(value.toLowerCase());
}

function uniqueProviderName(baseName: string, providers: readonly Provider[]): string {
  const normalizedNames = new Set(providers.map((provider) => provider.name.toLowerCase()));
  const initial = (baseName.trim() || '自定义服务商').slice(0, 120);
  if (!normalizedNames.has(initial.toLowerCase())) return initial;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const marker = ` (${suffix})`;
    const candidate = `${initial.slice(0, 120 - marker.length)}${marker}`;
    if (!normalizedNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${initial.slice(0, 79)}-${randomUUID()}`.slice(0, 120);
}

function positiveOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null || value <= 0 ? null : value;
}

function mapCredential(key: ApiKeySummary, provider: Provider) {
  const status =
    key.health === 'healthy'
      ? ('healthy' as const)
      : key.health === 'warning' || key.health === 'paused'
        ? ('warning' as const)
        : key.health === 'unhealthy'
          ? ('error' as const)
          : ('unknown' as const);
  return {
    id: key.id,
    name: key.label,
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.type,
    provider: provider.name,
    lastFour: key.maskedKey.slice(-4),
    status,
    strategy: provider.keyStrategy,
    priority: key.priority,
    dailyUsed: key.todayUsed,
    ...(key.dailyLimit === null ? {} : { dailyLimit: key.dailyLimit }),
    monthlyUsed: key.monthUsed,
    ...(key.monthlyLimit === null ? {} : { monthlyLimit: key.monthlyLimit }),
    quotaUnit: key.quotaUnit,
    proxyMode: key.proxyConfigured
      ? ('http' as const)
      : provider.type === 'ollama'
        ? ('local' as const)
        : ('direct' as const),
    ...(key.lastCheckedAt === null ? {} : { lastCheckedAt: key.lastCheckedAt }),
    enabled: key.enabled,
  };
}

function mapCredentials(list: ReturnType<CoreServices['keys']['list']>) {
  const providers = new Map(list.providers.map((provider) => [provider.id, provider]));
  return list.keys.flatMap((key) => {
    const provider = providers.get(key.providerId);
    return provider === undefined ? [] : [mapCredential(key, provider)];
  });
}

function requireProvider(services: CoreServices, id: string): Provider {
  const provider = services.keys.list().providers.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    throw new DesktopError('NOT_FOUND', '服务商不存在');
  }
  return provider;
}

function requireCredential(services: CoreServices, id: string) {
  const list = services.keys.list();
  const key = list.keys.find((candidate) => candidate.id === id);
  if (key === undefined) {
    throw new DesktopError('NOT_FOUND', 'API Key 不存在');
  }
  const provider = list.providers.find((candidate) => candidate.id === key.providerId);
  if (provider === undefined) {
    throw new DesktopError('NOT_FOUND', 'API Key 的提供商不存在');
  }
  return mapCredential(key, provider);
}

function mapModels(models: readonly CoreModel[]) {
  return models.map((model) => ({
    id: model.id,
    remoteId: model.remoteId,
    providerId: model.providerId,
    provider: model.provider,
    providerName: model.providerName,
    displayName: model.displayName,
    contextWindow: model.contextWindow ?? 0,
    capabilities: model.capabilities.filter(
      (capability): capability is 'code' | 'chat' | 'embedding' | 'vision' | 'function-calling' =>
        capability !== 'reasoning',
    ),
    configuredEnabled: model.configuredEnabled ?? model.enabled,
    available: model.enabled,
    stale: model.stale,
    ...(typeof model.metadata['latencyMs'] === 'number'
      ? { latencyMs: model.metadata['latencyMs'] }
      : {}),
    ...(model.inputPricePerMillion === null
      ? {}
      : { inputPricePerMillion: model.inputPricePerMillion }),
    ...(model.outputPricePerMillion === null
      ? {}
      : { outputPricePerMillion: model.outputPricePerMillion }),
  }));
}

function listAllConversations(services: CoreServices, actor: Actor): CoreConversation[] {
  const conversations: CoreConversation[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = services.conversations.list(
      {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      },
      actor,
    );
    conversations.push(...page.conversations);
    const nextCursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
    if (nextCursor === null || visitedCursors.has(nextCursor)) {
      cursor = undefined;
    } else {
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor !== undefined);

  return conversations;
}

function countDirectBranches(
  conversations: readonly CoreConversation[],
  conversationId: string,
): number {
  return conversations.filter(
    (conversation) => conversation.parentConversationId === conversationId,
  ).length;
}

function mapConversationsWithBranchCounts(conversations: readonly CoreConversation[]) {
  const branchCounts = new Map<string, number>();
  for (const conversation of conversations) {
    if (conversation.parentConversationId !== null) {
      branchCounts.set(
        conversation.parentConversationId,
        (branchCounts.get(conversation.parentConversationId) ?? 0) + 1,
      );
    }
  }
  return conversations.map((conversation) =>
    mapConversation(conversation, branchCounts.get(conversation.id) ?? 0),
  );
}

function mapConversation(conversation: CoreConversation, branchCount = 0) {
  return {
    id: conversation.id,
    ...(conversation.projectId === null ? {} : { projectId: conversation.projectId }),
    ...(conversation.parentConversationId === null
      ? {}
      : { parentConversationId: conversation.parentConversationId }),
    ...(conversation.branchedFromMessageId === null
      ? {}
      : { branchedFromMessageId: conversation.branchedFromMessageId }),
    ...(conversation.forkKind === null ? {} : { forkKind: conversation.forkKind }),
    ...(conversation.originMessageId === null
      ? {}
      : { originMessageId: conversation.originMessageId }),
    title: conversation.title,
    pinned: conversation.pinned,
    archived: conversation.archived,
    updatedAt: conversation.updatedAt,
    branchCount,
    messageCount: conversation.messageCount,
  };
}

function mapMessages(
  messages: readonly ConversationMessage[],
  fileChanges: ReadonlyArray<{
    id: string;
    path: string;
    diff: string;
    status: 'pending' | 'accepted' | 'rejected';
  }>,
) {
  const envelopes = new Map<string, ToolResultEnvelope>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const envelope = parseToolEnvelope(message.content);
    if (envelope !== undefined && envelope.toolCallId === message.parentMessageId) {
      envelopes.set(envelope.toolCallId, envelope);
    }
  }
  const changes = new Map(fileChanges.map((change) => [change.id, change]));
  return messages
    .filter((message) => message.role !== 'tool')
    .map((message) => {
      const mappedTools = message.toolCalls.map((tool) => {
        const envelope = envelopes.get(tool.id);
        if (envelope === undefined) {
          let error: unknown;
          try {
            parseAgentToolInvocation(tool.function.name, tool.function.arguments);
            error = new DesktopError(
              'TOOL_RESULT_MISSING',
              '工具执行结果缺失，为安全起见已按失败处理。',
            );
          } catch (parseError) {
            error = parseError;
          }
          const serialized = serializeDesktopError(error);
          return {
            id: tool.id,
            name: tool.function.name,
            arguments: tool.function.arguments,
            status: 'failed' as const,
            result: serialized.message,
            errorCode: serialized.code,
          };
        }
        const result = jsonObject(envelope.result);
        const changeId =
          result?.['kind'] === 'file-change' && typeof result['changeId'] === 'string'
            ? result['changeId']
            : undefined;
        return mapToolCallForRenderer(
          {
            id: tool.id,
            name: tool.function.name,
            arguments: tool.function.arguments,
          },
          envelope,
          changeId === undefined ? undefined : changes.get(changeId)?.status,
        );
      });
      const attachedChanges = message.toolCalls.flatMap((tool) => {
        const result = jsonObject(envelopes.get(tool.id)?.result);
        const changeId =
          result?.['kind'] === 'file-change' && typeof result['changeId'] === 'string'
            ? result['changeId']
            : undefined;
        const change = changeId === undefined ? undefined : changes.get(changeId);
        return change === undefined
          ? []
          : [
              {
                id: change.id,
                path: change.path,
                diff: change.diff,
                status: change.status,
              },
            ];
      });
      return {
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        ...(message.reasoning === null ? {} : { reasoning: message.reasoning }),
        ...(message.reasoningDurationMs === null
          ? {}
          : { reasoningDurationMs: message.reasoningDurationMs }),
        createdAt: message.createdAt,
        ...(message.model === null ? {} : { model: message.model }),
        status: 'completed' as const,
        inputTokens: message.inputTokens,
        outputTokens: message.outputTokens,
        feedback: message.feedback,
        toolCalls: mappedTools,
        ...(attachedChanges.length === 0 ? {} : { fileChanges: attachedChanges }),
      };
    });
}

function mapRendererMessage(message: ConversationMessage) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    ...(message.reasoning === null ? {} : { reasoning: message.reasoning }),
    ...(message.reasoningDurationMs === null
      ? {}
      : { reasoningDurationMs: message.reasoningDurationMs }),
    createdAt: message.createdAt,
    ...(message.model === null ? {} : { model: message.model }),
    status: 'completed' as const,
    inputTokens: message.inputTokens,
    outputTokens: message.outputTokens,
    feedback: message.feedback,
    toolCalls: message.toolCalls.map((tool) => ({
      id: tool.id,
      name: tool.function.name,
      arguments: tool.function.arguments,
      status: 'completed' as const,
    })),
  };
}

function mapConversationMessageToPrompt(message: ConversationMessage): ChatMessageInput {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls.length === 0 ? {} : { toolCalls: message.toolCalls }),
    ...(message.role === 'tool' && message.parentMessageId !== null
      ? { toolCallId: message.parentMessageId }
      : {}),
  };
}

function latestToolEnvelope(
  messages: readonly ConversationMessage[],
  toolCallId: string,
): ToolResultEnvelope | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool' || message.parentMessageId !== toolCallId) continue;
    const envelope = parseToolEnvelope(message.content);
    if (envelope?.toolCallId === toolCallId) return envelope;
  }
  return undefined;
}

function assistantToolCallOrigins(
  messages: readonly ConversationMessage[],
  toolCallId: string,
): Array<{
  message: ConversationMessage;
  toolCall: ConversationMessage['toolCalls'][number];
}> {
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.toolCalls
          .filter((toolCall) => toolCall.id === toolCallId)
          .map((toolCall) => ({ message, toolCall }))
      : [],
  );
}

function isTerminalToolStatus(status: ToolResultEnvelope['status']): boolean {
  return ['cancelled', 'completed', 'failed', 'rejected', 'timed-out'].includes(status);
}

function toolContinuationCallKey(conversationId: string, toolCallId: string): string {
  return JSON.stringify([conversationId, toolCallId]);
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneBoundedSupplementalMessages(messages: readonly ChatMessageInput[]): {
  messages: ChatMessageInput[];
  byteLength: number;
} {
  if (messages.length > 64) {
    throw new DesktopError(
      'TOOL_CONTINUATION_CONTEXT_TOO_LARGE',
      '待审批工具的补充上下文消息数量超过安全上限',
    );
  }
  const serialized = JSON.stringify(messages);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > maximumToolContinuationSnapshotBytes) {
    throw new DesktopError(
      'TOOL_CONTINUATION_CONTEXT_TOO_LARGE',
      '待审批工具的补充上下文超过 16 MiB 安全上限',
    );
  }
  return {
    messages: JSON.parse(serialized) as ChatMessageInput[],
    byteLength,
  };
}

function cloneChatMessages(messages: readonly ChatMessageInput[]): ChatMessageInput[] {
  return JSON.parse(JSON.stringify(messages)) as ChatMessageInput[];
}

function mapToolCallForRenderer(
  call: { id: string; name: string; arguments: string },
  envelope: ToolResultEnvelope,
  fileChangeStatus?: 'accepted' | 'pending' | 'rejected',
) {
  const result = jsonObject(envelope.result);
  const kind = typeof result?.['kind'] === 'string' ? result['kind'] : undefined;
  let status = envelope.status;
  if (kind === 'file-change') {
    status =
      fileChangeStatus === 'rejected'
        ? 'rejected'
        : fileChangeStatus === 'accepted'
          ? 'completed'
          : fileChangeStatus === 'pending'
            ? 'approval-required'
            : envelope.status;
  }

  let renderedResult: string | undefined;
  const metadata: Record<string, JsonValue> = {};
  if (envelope.permission !== undefined) {
    metadata['permission'] = envelope.permission;
  }
  if (kind === 'command') {
    const stdout = typeof result?.['stdout'] === 'string' ? result['stdout'] : '';
    const stderr = typeof result?.['stderr'] === 'string' ? result['stderr'] : '';
    renderedResult =
      stdout !== '' && stderr !== ''
        ? `${stdout}\n\n[stderr]\n${stderr}`
        : stdout || stderr || undefined;
    Object.assign(metadata, {
      kind: 'command',
      ...(typeof result?.['exitCode'] === 'number' ? { exitCode: result['exitCode'] } : {}),
      ...(typeof result?.['signal'] === 'string' ? { signal: result['signal'] } : {}),
      ...(typeof result?.['truncated'] === 'boolean' ? { truncated: result['truncated'] } : {}),
    });
  } else if (kind === 'file-change') {
    renderedResult = typeof result?.['diff'] === 'string' ? result['diff'] : undefined;
    Object.assign(metadata, {
      kind: 'file-change',
      format: 'diff',
      ...(typeof result?.['changeId'] === 'string' ? { changeId: result['changeId'] } : {}),
      ...(typeof result?.['path'] === 'string' ? { path: result['path'] } : {}),
    });
  } else if (envelope.result !== undefined) {
    renderedResult = JSON.stringify(envelope.result);
    Object.assign(metadata, {
      ...(kind === undefined ? {} : { kind }),
      format: 'json',
      ...(typeof result?.['path'] === 'string' ? { path: result['path'] } : {}),
      ...(typeof result?.['url'] === 'string' ? { url: result['url'] } : {}),
      ...(typeof result?.['serverName'] === 'string' ? { serverName: result['serverName'] } : {}),
      ...(typeof result?.['serverId'] === 'string' ? { serverId: result['serverId'] } : {}),
      ...(typeof result?.['endpoint'] === 'string' ? { endpoint: result['endpoint'] } : {}),
      ...(typeof result?.['originalToolName'] === 'string'
        ? { originalToolName: result['originalToolName'] }
        : {}),
      ...(typeof result?.['displayName'] === 'string'
        ? { displayName: result['displayName'] }
        : {}),
      ...(typeof result?.['readOnlyHint'] === 'boolean'
        ? { readOnlyHint: result['readOnlyHint'] }
        : {}),
      ...(typeof result?.['destructiveHint'] === 'boolean'
        ? { destructiveHint: result['destructiveHint'] }
        : {}),
      ...(typeof result?.['openWorldHint'] === 'boolean'
        ? { openWorldHint: result['openWorldHint'] }
        : {}),
      ...(typeof result?.['truncated'] === 'boolean' ? { truncated: result['truncated'] } : {}),
    });
  }
  if (envelope.error !== undefined) {
    renderedResult ??= envelope.error.message;
  }
  const truncated = result?.['truncated'] === true;
  return {
    id: call.id,
    name: call.name || envelope.toolName || 'unknown_tool',
    arguments: redactToolArguments(call.arguments),
    status,
    ...(renderedResult === undefined ? {} : { result: renderedResult }),
    ...(kind === undefined ? {} : { summary: toolSummary(kind, result) }),
    ...(envelope.durationMs === undefined ? {} : { durationMs: envelope.durationMs }),
    ...(envelope.error === undefined ? {} : { errorCode: envelope.error.code }),
    ...(truncated ? { truncated: true } : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function toolSummary(kind: string, result: Record<string, unknown> | undefined): string {
  if (kind === 'command') {
    return typeof result?.['executable'] === 'string'
      ? `等待执行 ${result['executable']}`
      : '命令执行结果';
  }
  if (kind === 'file-change') {
    return typeof result?.['path'] === 'string' ? `文件变更 ${result['path']}` : '文件变更';
  }
  if (kind === 'read-file') return '文件读取结果';
  if (kind === 'file-list') return '目录列表';
  if (kind === 'file-find') return '文件查找结果';
  if (kind === 'search-results') return '文本搜索结果';
  if (kind === 'system-info') return '系统信息';
  if (kind === 'process-list') return '进程检查结果';
  if (kind === 'browser-page') return '浏览器页面';
  if (kind === 'browser-extract') return '网页内容提取';
  if (kind === 'browser-screenshot') return '浏览器截图';
  if (kind === 'mcp-request') {
    return typeof result?.['serverName'] === 'string'
      ? `等待确认 · ${result['serverName']}`
      : '等待确认 MCP 工具';
  }
  if (kind === 'mcp-result') {
    return typeof result?.['serverName'] === 'string'
      ? `MCP · ${result['serverName']}`
      : 'MCP 工具结果';
  }
  return '工具执行结果';
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNormalizedFileChangeEnvelope(
  envelope: ToolResultEnvelope,
  fileChange: {
    id: string;
    path: string;
    diff: string;
    status: 'accepted' | 'pending' | 'rejected';
  },
  status: 'completed' | 'rejected',
): boolean {
  const result = jsonObject(envelope.result);
  return (
    envelope.status === status &&
    envelope.error === undefined &&
    result?.['kind'] === 'file-change' &&
    result['changeId'] === fileChange.id &&
    result['path'] === fileChange.path &&
    result['diff'] === fileChange.diff &&
    result['status'] === fileChange.status
  );
}

function parseMcpToolArguments(rawArguments: string): Record<string, unknown> {
  if (Buffer.byteLength(rawArguments, 'utf8') > 1_000_000) {
    throw new DesktopError('TOOL_ARGUMENTS_TOO_LARGE', 'MCP 工具参数超过安全大小上限');
  }
  let decoded: unknown;
  try {
    decoded = rawArguments.trim() === '' ? {} : (JSON.parse(rawArguments) as unknown);
  } catch {
    throw new DesktopError('TOOL_ARGUMENTS_INVALID', 'MCP 工具参数不是有效的 JSON');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new DesktopError('TOOL_ARGUMENTS_INVALID', 'MCP 工具参数必须是 JSON 对象');
  }
  return decoded as Record<string, unknown>;
}

function assertCanManageMcp(actor: Actor): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new DesktopError('FORBIDDEN', '仅 Owner/Admin 可管理 MCP Server');
  }
}

function assertCanApproveTools(actor: Actor): void {
  if (actor.role === 'viewer') {
    throw new DesktopError('FORBIDDEN', 'Viewer 角色不能批准或拒绝工具执行');
  }
}

function assertOwnerOrAdmin(actor: Actor, message: string): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new DesktopError('FORBIDDEN', message);
  }
}

function assertOwner(actor: Actor, message: string): void {
  if (actor.role !== 'owner') {
    throw new DesktopError('FORBIDDEN', message);
  }
}

function normalizeMcpToolResult(
  result: McpToolResult,
  descriptor: DesktopMcpToolDescriptor,
  outputLimitBytes: number,
): JsonValue {
  const maximumBytes = Math.max(4_096, Math.min(outputLimitBytes, 1_048_576));
  const value = redactSensitive({
    kind: 'mcp-result',
    serverId: descriptor.serverId,
    serverName: descriptor.serverName,
    originalToolName: descriptor.originalName,
    displayName: descriptor.title ?? descriptor.originalName,
    isError: result.isError,
    content: result.content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  });
  const serialized = JSON.stringify(value);
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  if (originalBytes <= maximumBytes) {
    return JSON.parse(serialized) as JsonValue;
  }
  const text = result.content
    .flatMap((item) => {
      const record = jsonObject(item);
      return record?.['type'] === 'text' && typeof record['text'] === 'string'
        ? [record['text']]
        : [];
    })
    .join('\n');
  const bounded = limitUtf8ForToolResult(
    text === '' ? 'MCP 返回了非文本大结果，界面已按安全上限省略。' : text,
    Math.max(1_024, maximumBytes - 2_048),
  );
  return redactSensitive({
    kind: 'mcp-result',
    serverId: descriptor.serverId,
    serverName: descriptor.serverName,
    originalToolName: descriptor.originalName,
    displayName: descriptor.title ?? descriptor.originalName,
    isError: result.isError,
    content: [{ type: 'text', text: bounded }],
    truncated: true,
    originalBytes,
  }) as JsonValue;
}

function mcpErrorMessage(result: JsonValue): string {
  const record = jsonObject(result);
  const content = Array.isArray(record?.['content']) ? record['content'] : [];
  const message = content
    .flatMap((item) => {
      const entry = jsonObject(item);
      return typeof entry?.['text'] === 'string' ? [entry['text']] : [];
    })
    .join('\n')
    .trim();
  return (message || 'MCP Server 返回工具执行错误').slice(0, 2_000);
}

function limitUtf8ForToolResult(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function redactToolArguments(rawArguments: string): string {
  try {
    const decoded = JSON.parse(rawArguments) as unknown;
    const redacted = redactSensitive(decoded);
    const serializedRedacted = JSON.stringify(redacted);
    const serializedOriginal = JSON.stringify(decoded);
    return (serializedRedacted === serializedOriginal ? rawArguments : serializedRedacted).slice(
      0,
      32_768,
    );
  } catch {
    return redactText(rawArguments).slice(0, 32_768);
  }
}

function mapContext(services: CoreServices, messages: readonly ConversationMessage[]) {
  const systemTokens = messages
    .filter((message) => message.role === 'system')
    .reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
  const historyTokens = messages
    .filter((message) => message.role !== 'system')
    .reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
  const settings = services.settings.get();
  let contextWindow = 64_000;
  if (settings.defaultModels.chat !== null) {
    try {
      contextWindow =
        services.models.get(settings.defaultModels.chat).contextWindow ?? contextWindow;
    } catch {
      // 已删除的默认模型不影响上下文概览，使用保守默认窗口。
    }
  }
  const usedTokens = systemTokens + historyTokens;
  return {
    usedTokens,
    contextWindow,
    sources: [
      ...(systemTokens === 0
        ? []
        : [
            {
              id: 'system',
              label: '系统提示',
              type: 'system' as const,
              tokens: systemTokens,
              removable: false,
            },
          ]),
      {
        id: 'history',
        label: '历史消息',
        type: 'history' as const,
        tokens: historyTokens,
        removable: false,
      },
    ],
    compressed: false,
  };
}

function dateRange(range: 'day' | 'week' | 'month'): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  if (range === 'day') {
    from.setHours(0, 0, 0, 0);
  } else {
    from.setDate(from.getDate() - (range === 'week' ? 6 : 29));
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function mapUsageSummary(services: CoreServices, range: 'day' | 'week' | 'month') {
  const dates = dateRange(range);
  const trend = services.usage.summary({
    ...dates,
    groupBy: 'day',
    limit: 100,
  });
  const models = services.usage.summary({
    ...dates,
    groupBy: 'model',
    limit: 100,
  });
  return {
    range,
    totalCost: trend.totals.estimatedCostUsd,
    totalTokens: trend.totals.totalTokens,
    requests: trend.totals.requestCount,
    cacheHitRate:
      trend.totals.totalTokens === 0 ? 0 : trend.totals.cachedTokens / trend.totals.totalTokens,
    budget: trend.costAlert.thresholdUsd,
    alertCost: trend.costAlert.currentUsd,
    trend: trend.buckets.map((bucket) => ({
      date: bucket.key,
      tokens: bucket.totalTokens,
      cost: bucket.estimatedCostUsd,
    })),
    byModel: models.buckets.map((bucket) => ({
      model: bucket.key,
      tokens: bucket.totalTokens,
      cost: bucket.estimatedCostUsd,
    })),
  };
}

function desktopSettingsExtras(services: CoreServices) {
  return desktopSettingsExtrasSchema.parse(
    services.repositories.settings.get<unknown>(desktopSettingsScope) ?? {},
  );
}

function mapSettings(services: CoreServices, systemLocale: 'zh-CN' | 'en-US') {
  const settings: CoreSettings = services.settings.get();
  const extras = desktopSettingsExtras(services);
  return {
    locale: settings.language === 'system' ? systemLocale : settings.language,
    theme: settings.theme,
    defaultModels: {
      code: settings.defaultModels.code ?? '',
      chat: settings.defaultModels.chat ?? '',
      summarize: settings.contextCompressionModelId ?? '',
      embedding: settings.defaultModels.embedding ?? '',
      vision: settings.defaultModels.vision ?? '',
    },
    maxConcurrency: settings.maxConcurrentRequests,
    costAlertThreshold: settings.dailyCostAlertUsd,
    autoCompressContext: extras.autoCompressContext,
    autoUpdate: extras.autoUpdate,
    telemetryEnabled: extras.telemetryEnabled,
    ollamaFallback: extras.ollamaFallback,
    reasoningDisplay: extras.reasoningDisplay,
    toolExecutionPolicy: settings.toolExecutionPolicy,
    toolCommandTimeoutMs: settings.toolCommandTimeoutMs,
    toolOutputLimitBytes: settings.toolOutputLimitBytes,
    tutorialCompletedVersion: extras.tutorialCompletedVersion,
    autoExpandRunningTools: extras.autoExpandRunningTools,
  };
}

function optionalModel(
  models: Record<string, string>,
  key: 'code' | 'chat' | 'embedding' | 'vision',
): Partial<Record<typeof key, string | null>> {
  return key in models ? { [key]: models[key] || null } : {};
}

function mergeToolCall(
  calls: Map<number, { id: string; name: string; arguments: string }>,
  event: Extract<ChatStreamEvent, { type: 'tool_call_delta' }>,
  requestId: string,
): void {
  const current = calls.get(event.index) ?? {
    id: `${requestId}-tool-call-${event.index}`.slice(0, 256),
    name: '',
    arguments: '',
  };
  if (event.id !== undefined && event.id.trim() !== '') {
    current.id = event.id.slice(0, 256);
  }
  if (event.snapshot === true) {
    if (event.name !== undefined) current.name = event.name;
    if (event.arguments !== undefined) current.arguments = event.arguments;
    calls.set(event.index, current);
    return;
  }
  if (event.name !== undefined) current.name += event.name;
  if (event.arguments !== undefined) current.arguments += event.arguments;
  calls.set(event.index, current);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates];
}
