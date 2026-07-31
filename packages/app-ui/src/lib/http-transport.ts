import { clientConfig } from '../config';
import type {
  AppSettings,
  AuditEntry,
  ChatRequest,
  ContextOverview,
  Conversation,
  Credential,
  Message,
  McpServerInput,
  McpServerSummary,
  Model,
  Plugin,
  ProviderConfig,
  SessionInfo,
  Skill,
  Snapshot,
  StreamEvent,
  ToolCall,
  UsageRecord,
  UsageSummary,
  User,
  WorkspaceBinding,
  WorkflowDefinition,
  WorkflowResult,
} from '../types';

import { parseSseResponse } from './sse';
import { TransportError } from './transport';
import type {
  BranchConversationOptions,
  CredentialInput,
  DeleteMessagePrecondition,
  DeleteMessageResult,
  EAgentTransport,
  LoginInput,
  MessageSnapshot,
  ProviderInput,
  SetupInput,
  TeamMemberInput,
} from './transport';

interface ApiEnvelope<T> {
  data: T;
  error?: {
    code: string;
    message: string;
    correlationId?: string;
    requestId?: string;
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  role: SessionInfo['user']['role'];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiAuthResponse {
  accessToken: string;
  expiresAt: string;
  user: ApiUser;
}

interface ApiProvider {
  id: string;
  type: ProviderConfig['type'];
  name: string;
  baseUrl: string;
  enabled: boolean;
  keyStrategy: 'round-robin' | 'priority';
  modelDiscoveryError?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ApiKey {
  id: string;
  providerId: string;
  label: string;
  maskedKey: string;
  priority: number;
  health: 'unknown' | 'healthy' | 'warning' | 'unhealthy' | 'paused';
  enabled: boolean;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  quotaUnit: 'usd' | 'tokens';
  todayUsed: number;
  monthUsed: number;
  proxyConfigured: boolean;
  lastCheckedAt: string | null;
}

interface ApiKeyHealthCheck {
  id: string;
  health: 'healthy' | 'warning' | 'unhealthy';
  latencyMs: number;
  checkedAt: string;
  error: string | null;
}

interface ApiConversation {
  id: string;
  projectId: string | null;
  parentConversationId: string | null;
  branchedFromMessageId: string | null;
  forkKind: 'branch' | 'retry' | 'edit' | null;
  originMessageId: string | null;
  title: string;
  pinned: boolean;
  archived: boolean;
  messageCount: number;
  updatedAt: string;
}

interface ApiSnapshot {
  id: string;
  conversationId: string;
  messageCount: number;
  createdAt: string;
}

interface ApiMessage {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  reasoning?: string | null;
  reasoningDurationMs?: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  feedback: 'helpful' | 'unhelpful' | null;
  createdAt: string;
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface ApiConversationDetail {
  conversation: ApiConversation;
  messages: ApiMessage[];
}

interface ApiSkill {
  id: string;
  command: string;
  name: { 'zh-CN': string; 'en-US': string };
  version: string;
  description: { 'zh-CN': string; 'en-US': string };
  executor?: { pluginId: string; commandId: string };
  source?: Skill['source'];
  variables: Skill['variables'];
  enabled: boolean;
}

interface ApiPluginStatus {
  manifest: {
    id: string;
    name: string;
    description: string;
    version: string;
    types: Plugin['types'];
    permissions: {
      network?: { hosts: string[] };
      fileSystem?: { read: string[]; write: string[] };
      env?: string[];
      notifications?: boolean;
    };
  };
  integrity: string;
  enabled: boolean;
  approved: boolean;
}

interface ApiSettings {
  language: 'system' | 'zh-CN' | 'en-US';
  theme: string;
  maxConcurrentRequests: number;
  dailyCostAlertUsd: number;
  contextCompressionThreshold: number;
  contextCompressionModelId: string | null;
  desktopNotifications: boolean;
  autoSnapshotInterval: number;
  toolExecutionPolicy?: AppSettings['toolExecutionPolicy'];
  toolCommandTimeoutMs?: number;
  toolOutputLimitBytes?: number;
  defaultModels: {
    code: string | null;
    chat: string | null;
    embedding: string | null;
    vision: string | null;
  };
}

interface LocalSettingExtras {
  autoCompressContext?: boolean;
  autoUpdate?: boolean;
  telemetryEnabled?: boolean;
  ollamaFallback?: boolean;
  reasoningDisplay?: AppSettings['reasoningDisplay'];
  tutorialCompletedVersion?: number;
  autoExpandRunningTools?: boolean;
}

const LOCAL_SETTING_KEY = 'e-agent-local-settings';

function readLocalSettingExtras(): LocalSettingExtras {
  try {
    const value = window.localStorage.getItem(LOCAL_SETTING_KEY);
    return value ? (JSON.parse(value) as LocalSettingExtras) : {};
  } catch {
    return {};
  }
}

function writeLocalSettingExtras(value: LocalSettingExtras): void {
  window.localStorage.setItem(LOCAL_SETTING_KEY, JSON.stringify(value));
}

function mapSkill(value: ApiSkill): Skill {
  return {
    id: value.id,
    name: value.name['zh-CN'],
    description: value.description['zh-CN'],
    version: value.version,
    source: value.source ?? (value.executor ? 'local' : 'builtin'),
    enabled: value.enabled,
    command: value.command,
    permissions: value.executor ? [`plugin:${value.executor.pluginId}`] : [],
    variables: value.variables,
  };
}

function mapPlugin(value: ApiPluginStatus): Plugin {
  const permissions: string[] = [];
  for (const host of value.manifest.permissions.network?.hosts ?? []) {
    permissions.push(`network:${host}`);
  }
  for (const path of value.manifest.permissions.fileSystem?.read ?? []) {
    permissions.push(`fileSystem:read:${path}`);
  }
  for (const path of value.manifest.permissions.fileSystem?.write ?? []) {
    permissions.push(`fileSystem:write:${path}`);
  }
  for (const name of value.manifest.permissions.env ?? []) {
    permissions.push(`env:${name}`);
  }
  if (value.manifest.permissions.notifications === true) {
    permissions.push('notifications');
  }
  if (!value.approved) {
    permissions.push('待授权');
  }
  return {
    id: value.manifest.id,
    name: value.manifest.name,
    description: value.manifest.description,
    version: value.manifest.version,
    enabled: value.enabled,
    approved: value.approved,
    source: value.integrity,
    types: value.manifest.types,
    permissions,
  };
}

function mapSettings(value: ApiSettings): AppSettings {
  const local = readLocalSettingExtras();
  const locale =
    value.language === 'system'
      ? navigator.language.toLowerCase().startsWith('zh')
        ? 'zh-CN'
        : 'en-US'
      : value.language;
  return {
    locale,
    theme: value.theme,
    defaultModels: {
      code: value.defaultModels.code ?? '',
      chat: value.defaultModels.chat ?? '',
      summarize: value.contextCompressionModelId ?? '',
      embedding: value.defaultModels.embedding ?? '',
      vision: value.defaultModels.vision ?? '',
    },
    maxConcurrency: value.maxConcurrentRequests,
    costAlertThreshold: value.dailyCostAlertUsd,
    autoCompressContext: local.autoCompressContext ?? value.contextCompressionThreshold <= 0.7,
    autoUpdate: local.autoUpdate ?? true,
    telemetryEnabled: local.telemetryEnabled ?? false,
    ollamaFallback: local.ollamaFallback ?? false,
    reasoningDisplay: local.reasoningDisplay ?? 'collapsed',
    toolExecutionPolicy: value.toolExecutionPolicy ?? 'always-ask',
    toolCommandTimeoutMs: value.toolCommandTimeoutMs ?? 60_000,
    toolOutputLimitBytes: value.toolOutputLimitBytes ?? 131_072,
    tutorialCompletedVersion: local.tutorialCompletedVersion ?? 0,
    autoExpandRunningTools: local.autoExpandRunningTools ?? true,
  };
}

function mapSession(response: ApiAuthResponse): SessionInfo {
  return {
    expiresAt: response.expiresAt,
    user: {
      id: response.user.id,
      email: response.user.email,
      name: response.user.displayName,
      role: response.user.role,
      active: response.user.active,
    },
  };
}

function mapUser(value: ApiUser): User {
  return {
    id: value.id,
    email: value.email,
    name: value.displayName,
    role: value.role,
    active: value.active,
  };
}

function mapConversation(value: ApiConversation, branchCount = 0): Conversation {
  return {
    id: value.id,
    projectId: value.projectId ?? undefined,
    parentConversationId: value.parentConversationId ?? undefined,
    branchedFromMessageId: value.branchedFromMessageId ?? undefined,
    forkKind: value.forkKind ?? undefined,
    originMessageId: value.originMessageId ?? undefined,
    title: value.title,
    pinned: value.pinned,
    archived: value.archived,
    updatedAt: value.updatedAt,
    branchCount,
    messageCount: value.messageCount,
  };
}

function mapMessage(value: ApiMessage): Message {
  return {
    id: value.id,
    conversationId: value.conversationId,
    role: value.role,
    content: value.content,
    reasoning: value.reasoning ?? undefined,
    reasoningDurationMs: value.reasoningDurationMs ?? undefined,
    createdAt: value.createdAt,
    model: value.model ?? undefined,
    status: 'completed',
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    feedback: value.feedback,
    toolCalls: value.toolCalls.map((tool) => ({
      id: tool.id,
      name: tool.function.name,
      arguments: tool.function.arguments,
      status: tool.function.name.startsWith('workspace_') ? 'failed' : 'pending',
      ...(tool.function.name.startsWith('workspace_')
        ? { result: 'Web 模式未配置隔离的工作区执行器，未执行本机操作。' }
        : {}),
    })),
  };
}

function providerType(value: string): ProviderConfig['type'] {
  const normalized = value.toLowerCase().replace(/\s+/g, '-');
  if (normalized.includes('openai') && normalized.includes('compatible')) return 'custom';
  if (normalized.includes('openai')) return 'openai';
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('groq')) return 'groq';
  if (normalized.includes('google')) return 'google';
  if (normalized.includes('ollama')) return 'ollama';
  return 'custom';
}

function defaultProviderUrl(type: ProviderConfig['type']): string {
  const values: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    ollama: 'http://127.0.0.1:11434',
    custom: 'https://api.openai.com/v1',
  };
  return values[type] ?? values.custom!;
}

function normalizeProviderUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return value.replace(/\/+$/u, '');
  }
}

function uniqueProviderName(
  preferredName: string,
  baseUrl: string,
  providers: readonly ApiProvider[],
): string {
  const names = new Set(providers.map((provider) => provider.name.trim().toLowerCase()));
  if (!names.has(preferredName.toLowerCase())) return preferredName;

  let hostname = 'custom';
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // URL 会在服务端再次校验；这里仅为重名服务商生成可区分的显示名称。
  }
  const suffix = ` (${hostname})`;
  const baseName = preferredName.slice(0, Math.max(1, 120 - suffix.length));
  const withHost = `${baseName}${suffix}`;
  if (!names.has(withHost.toLowerCase())) return withHost;

  for (let index = 2; index <= 999; index += 1) {
    const numberedSuffix = ` (${hostname} #${index})`;
    const candidate = `${preferredName.slice(0, Math.max(1, 120 - numberedSuffix.length))}${numberedSuffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${preferredName.slice(0, 111)} (${crypto.randomUUID().slice(0, 6)})`;
}

function dateRange(range: UsageSummary['range']): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  if (range === 'day') from.setHours(0, 0, 0, 0);
  else from.setDate(from.getDate() - (range === 'week' ? 6 : 29));
  return { from: from.toISOString(), to: to.toISOString() };
}

function chatAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (
    typeof signal.reason === 'object' &&
    signal.reason !== null &&
    'name' in signal.reason &&
    'message' in signal.reason
  ) {
    return signal.reason as Error;
  }
  return new DOMException('请求已取消', 'AbortError');
}

function waitForCancellationRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, delayMs);
    function finish(): void {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class HttpTransport implements EAgentTransport {
  public readonly kind = 'http' as const;
  private readonly baseUrl: string;
  private accessToken: string | null;
  private providers: ApiProvider[] = [];
  private readonly branchCounts = new Map<string, number>();
  private readonly parentConversationIds = new Map<string, string | null>();
  private readonly pendingMutationIds = new Map<string, string>();
  private readonly conversationDetailRequests = new Map<string, Promise<ApiConversationDetail>>();
  private authenticationGeneration = 0;
  private readonly requestTimeoutMs: number;

  public constructor(baseUrl: string, options: { requestTimeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs ?? clientConfig.requestTimeoutMs;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error('HTTP 请求超时必须是正数');
    }
    this.accessToken = window.sessionStorage.getItem('e-agent-access-token');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestController = new AbortController();
    const callerSignal = init.signal;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      requestController.abort(new DOMException('请求超时', 'TimeoutError'));
    }, this.requestTimeoutMs);
    const forwardCallerAbort = (): void => {
      requestController.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted) {
      forwardCallerAbort();
    } else {
      callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: requestController.signal,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          ...init.headers,
        },
      });

      const correlationId = response.headers.get('x-correlation-id') ?? undefined;
      const contentType = response.headers.get('content-type') ?? '';
      const payload = contentType.includes('application/json')
        ? ((await response.json()) as ApiEnvelope<T> | T)
        : null;

      if (!response.ok) {
        const envelope = payload as ApiEnvelope<T> | null;
        throw new TransportError(envelope?.error?.message ?? `请求失败（${response.status}）`, {
          code: envelope?.error?.code ?? 'HTTP_ERROR',
          correlationId:
            envelope?.error?.correlationId ?? envelope?.error?.requestId ?? correlationId,
          status: response.status,
        });
      }

      if (payload && typeof payload === 'object' && 'data' in payload) {
        return (payload as ApiEnvelope<T>).data;
      }

      return payload as T;
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (timedOut) {
        throw new TransportError(`请求超时（${String(this.requestTimeoutMs)}ms）`, {
          code: 'REQUEST_TIMEOUT',
        });
      }
      if (callerSignal?.aborted) {
        throw chatAbortReason(callerSignal);
      }
      throw new TransportError(
        error instanceof Error ? error.message : '无法连接到 E Agent 服务。',
        {
          code: 'NETWORK_ERROR',
        },
      );
    } finally {
      window.clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
    }
  }

  /**
   * 合并同一会话同时发起的详情读取，避免消息与摘要刷新重复下载完整消息历史。
   */
  private conversationDetailRequestKey(id: string, authenticationGeneration: number): string {
    return JSON.stringify([authenticationGeneration, id]);
  }

  private invalidateConversationDetail(
    id: string,
    authenticationGeneration = this.authenticationGeneration,
  ): void {
    this.conversationDetailRequests.delete(
      this.conversationDetailRequestKey(id, authenticationGeneration),
    );
  }

  private loadConversationDetail(id: string): Promise<ApiConversationDetail> {
    const authenticationGeneration = this.authenticationGeneration;
    const requestKey = this.conversationDetailRequestKey(id, authenticationGeneration);
    const existing = this.conversationDetailRequests.get(requestKey);
    if (existing !== undefined) return existing;
    const request = this.request<ApiConversationDetail>(
      `/api/v1/conversations/${encodeURIComponent(id)}`,
    );
    this.conversationDetailRequests.set(requestKey, request);
    const clear = (): void => {
      if (this.conversationDetailRequests.get(requestKey) === request) {
        this.conversationDetailRequests.delete(requestKey);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  /**
   * 写操作遇到网络中断或响应超时时，以原始 operationId 重放一次。
   * 服务端会从持久化记录返回首次提交结果，不会重复执行业务写入。
   */
  private async requestMutation<T>(path: string, init: RequestInit): Promise<T> {
    try {
      return await this.request<T>(path, init);
    } catch (error) {
      if (
        !(error instanceof TransportError) ||
        (error.code !== 'NETWORK_ERROR' && error.code !== 'REQUEST_TIMEOUT')
      ) {
        throw error;
      }
      return this.request<T>(path, init);
    }
  }

  private mutationOperationId(actionKey: string, suppliedOperationId?: string): string {
    if (suppliedOperationId !== undefined) return suppliedOperationId;
    const pending = this.pendingMutationIds.get(actionKey);
    if (pending !== undefined) return pending;
    if (this.pendingMutationIds.size >= 128) {
      const oldest = this.pendingMutationIds.keys().next().value as string | undefined;
      if (oldest !== undefined) this.pendingMutationIds.delete(oldest);
    }
    const operationId = crypto.randomUUID();
    this.pendingMutationIds.set(actionKey, operationId);
    return operationId;
  }

  private settleMutation(actionKey: string, operationId: string): void {
    if (this.pendingMutationIds.get(actionKey) === operationId) {
      this.pendingMutationIds.delete(actionKey);
    }
  }

  public async getSession(): Promise<SessionInfo | null> {
    if (!this.accessToken) {
      try {
        const status = await this.request<{
          initialized: boolean;
          bootstrapTokenRequired?: boolean;
        }>('/api/v1/auth/status');
        if (!status.initialized) {
          throw new TransportError('需要先初始化 E Agent。', {
            code: 'SETUP_REQUIRED',
            bootstrapTokenRequired: status.bootstrapTokenRequired === true,
          });
        }
      } catch (error) {
        if (
          error instanceof TransportError &&
          (error.code === 'SETUP_REQUIRED' || error.status !== 404)
        ) {
          throw error;
        }
      }
      return null;
    }
    try {
      const user = await this.request<ApiUser>('/api/v1/auth/me');
      const expiresAt =
        window.sessionStorage.getItem('e-agent-token-expires-at') ??
        new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return mapSession({ accessToken: this.accessToken, expiresAt, user });
    } catch (error) {
      if (error instanceof TransportError && error.status === 401) {
        this.clearSession();
        return null;
      }
      throw error;
    }
  }

  public async setup(input: SetupInput): Promise<SessionInfo> {
    const response = await this.request<ApiAuthResponse>('/api/v1/auth/register', {
      method: 'POST',
      ...(input.bootstrapToken
        ? { headers: { 'x-e-agent-bootstrap-token': input.bootstrapToken } }
        : {}),
      body: JSON.stringify({
        displayName: input.name,
        email: input.email,
        password: input.password,
      }),
    });
    this.saveSession(response);
    return mapSession(response);
  }

  public async login(input: LoginInput): Promise<SessionInfo> {
    const response = await this.request<ApiAuthResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.saveSession(response);
    return mapSession(response);
  }

  public async logout(): Promise<void> {
    try {
      if (this.accessToken !== null) {
        await this.request<null>('/api/v1/auth/logout', { method: 'POST' });
      }
    } catch {
      // 服务不可用或令牌已失效时仍必须完成本地退出。
    } finally {
      this.clearSession();
    }
  }

  public async listUsers(): Promise<User[]> {
    return (await this.request<ApiUser[]>('/api/v1/users')).map(mapUser);
  }

  public async createUser(input: TeamMemberInput): Promise<User> {
    return mapUser(
      await this.request<ApiUser>('/api/v1/users', {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          displayName: input.name,
          password: input.password,
          role: input.role,
        }),
      }),
    );
  }

  public async updateUser(
    id: string,
    input: Partial<Pick<User, 'name' | 'role' | 'active'>>,
  ): Promise<User> {
    return mapUser(
      await this.request<ApiUser>(`/api/v1/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(input.name === undefined ? {} : { displayName: input.name }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.active === undefined ? {} : { active: input.active }),
        }),
      }),
    );
  }

  public async deleteUser(id: string): Promise<void> {
    await this.request(`/api/v1/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  public getWorkspaceBinding(): Promise<WorkspaceBinding | null> {
    return Promise.resolve(null);
  }

  public chooseWorkspace(): Promise<WorkspaceBinding | null> {
    return Promise.reject(
      new TransportError('浏览器无法直接绑定本机文件夹，请使用桌面端。', {
        code: 'WORKSPACE_DESKTOP_ONLY',
      }),
    );
  }

  private saveSession(response: ApiAuthResponse): void {
    this.authenticationGeneration += 1;
    this.conversationDetailRequests.clear();
    this.accessToken = response.accessToken;
    window.sessionStorage.setItem('e-agent-access-token', response.accessToken);
    window.sessionStorage.setItem('e-agent-token-expires-at', response.expiresAt);
  }

  private clearSession(): void {
    this.authenticationGeneration += 1;
    this.conversationDetailRequests.clear();
    this.accessToken = null;
    window.sessionStorage.removeItem('e-agent-access-token');
    window.sessionStorage.removeItem('e-agent-token-expires-at');
  }

  public async listModels(signal?: AbortSignal): Promise<Model[]> {
    const response = await this.request<{
      models: Array<{
        id: string;
        providerId: string;
        provider: string;
        providerName?: string;
        remoteId: string;
        displayName: string;
        capabilities: string[];
        contextWindow: number | null;
        inputPricePerMillion: number | null;
        outputPricePerMillion: number | null;
        configuredEnabled?: boolean;
        enabled: boolean;
        stale?: boolean;
        metadata?: Record<string, unknown>;
      }>;
    }>('/api/v1/models', signal ? { signal } : {});
    return response.models.map((model) => ({
      id: model.id,
      remoteId: model.remoteId,
      providerId: model.providerId,
      providerName:
        model.providerName ??
        this.providers.find((provider) => provider.id === model.providerId)?.name ??
        model.provider,
      provider: model.provider,
      displayName: model.displayName,
      contextWindow: model.contextWindow ?? 0,
      capabilities: model.capabilities.filter(
        (capability): capability is Model['capabilities'][number] =>
          ['code', 'chat', 'embedding', 'vision', 'function-calling'].includes(capability),
      ),
      configuredEnabled: model.configuredEnabled ?? model.enabled,
      available: model.enabled,
      stale: model.stale ?? false,
      latencyMs:
        typeof model.metadata?.latencyMs === 'number' ? model.metadata.latencyMs : undefined,
      inputPricePerMillion: model.inputPricePerMillion ?? undefined,
      outputPricePerMillion: model.outputPricePerMillion ?? undefined,
    }));
  }

  public async discoverModels(providerId?: string): Promise<Model[]> {
    const response = await this.request<{
      results: Array<{ providerId: string; discovered: number; error: string | null }>;
    }>('/api/v1/models/discover', {
      method: 'POST',
      body: JSON.stringify({
        force: true,
        ...(providerId === undefined ? {} : { providerId }),
      }),
    });
    const results = Array.isArray(response.results) ? response.results : [];
    const failures = results.filter((result) => result.error !== null);
    if (results.length === 0 || failures.length === results.length) {
      throw new TransportError(
        failures
          .map((result) => result.error)
          .filter((message): message is string => message !== null)
          .join('；') || '没有可用于模型发现的服务商。',
        { code: 'MODEL_DISCOVERY_FAILED' },
      );
    }
    return this.listModels();
  }

  public async updateProviderModelSelection(
    providerId: string,
    enabledModelIds: string[],
  ): Promise<Model[]> {
    await this.request(`/api/v1/providers/${encodeURIComponent(providerId)}/models`, {
      method: 'PATCH',
      body: JSON.stringify({ enabledModelIds }),
    });
    return this.listModels();
  }

  private mapProvider(provider: ApiProvider): ProviderConfig {
    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      keyStrategy: provider.keyStrategy,
      ...(provider.modelDiscoveryError === undefined
        ? {}
        : { modelDiscoveryError: provider.modelDiscoveryError }),
      ...(provider.createdAt === undefined ? {} : { createdAt: provider.createdAt }),
      ...(provider.updatedAt === undefined ? {} : { updatedAt: provider.updatedAt }),
    };
  }

  public async listProviders(): Promise<ProviderConfig[]> {
    const response = await this.request<{ providers: ApiProvider[] }>('/api/v1/providers');
    this.providers = response.providers;
    return response.providers.map((provider) => this.mapProvider(provider));
  }

  public async createProvider(input: ProviderInput): Promise<ProviderConfig> {
    let provider = await this.request<ApiProvider>('/api/v1/providers', {
      method: 'POST',
      body: JSON.stringify({
        type: input.type,
        name: input.name,
        baseUrl: input.baseUrl,
        keyStrategy: input.keyStrategy,
      }),
    });
    if (input.enabled === false) {
      provider = await this.request<ApiProvider>(
        `/api/v1/providers/${encodeURIComponent(provider.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        },
      );
    }
    this.providers = [...this.providers.filter((item) => item.id !== provider.id), provider];
    return this.mapProvider(provider);
  }

  public async updateProvider(id: string, input: Partial<ProviderInput>): Promise<ProviderConfig> {
    const provider = await this.request<ApiProvider>(
      `/api/v1/providers/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    );
    this.providers = [...this.providers.filter((item) => item.id !== provider.id), provider];
    return this.mapProvider(provider);
  }

  private mapCredential(key: ApiKey): Credential {
    const provider = this.providers.find((item) => item.id === key.providerId);
    const nearLimit =
      (key.dailyLimit !== null && key.todayUsed / key.dailyLimit >= 0.8) ||
      (key.monthlyLimit !== null && key.monthUsed / key.monthlyLimit >= 0.8);
    const health: Credential['status'] =
      key.health === 'healthy'
        ? nearLimit
          ? 'warning'
          : 'healthy'
        : key.health === 'warning' || key.health === 'paused'
          ? 'warning'
          : key.health === 'unhealthy'
            ? 'error'
            : 'unknown';
    return {
      id: key.id,
      name: key.label,
      providerId: key.providerId,
      ...(provider === undefined
        ? {}
        : {
            providerName: provider.name,
            providerType: provider.type,
          }),
      provider: provider?.name ?? provider?.type ?? '未知厂商',
      lastFour: key.maskedKey.slice(-4),
      status: health,
      strategy: provider?.keyStrategy ?? 'round-robin',
      priority: key.priority,
      dailyUsed: key.todayUsed,
      dailyLimit: key.dailyLimit ?? undefined,
      monthlyUsed: key.monthUsed,
      monthlyLimit: key.monthlyLimit ?? undefined,
      quotaUnit: key.quotaUnit,
      proxyMode: key.proxyConfigured ? 'http' : provider?.type === 'ollama' ? 'local' : 'direct',
      lastCheckedAt: key.lastCheckedAt ?? undefined,
      enabled: key.enabled,
    };
  }

  public async listCredentials(): Promise<Credential[]> {
    const response = await this.request<{
      providers: ApiProvider[];
      keys: ApiKey[];
    }>('/api/v1/keys');
    this.providers = response.providers;
    return response.keys.map((key) => this.mapCredential(key));
  }

  private async ensureProvider(input: CredentialInput): Promise<ApiProvider> {
    if (
      this.providers.length === 0 ||
      (input.providerId !== undefined &&
        !this.providers.some((provider) => provider.id === input.providerId))
    ) {
      await this.listProviders();
    }
    if (input.providerId !== undefined) {
      const selected = this.providers.find((provider) => provider.id === input.providerId);
      if (selected === undefined) {
        throw new TransportError('所选服务商不存在，请刷新后重试。', {
          code: 'PROVIDER_NOT_FOUND',
        });
      }
      return selected;
    }
    if (input.provider === undefined || input.provider.trim() === '') {
      throw new TransportError('添加 API Key 前必须先选择服务商。', {
        code: 'PROVIDER_REQUIRED',
      });
    }
    const type = providerType(input.provider);
    const preferredName = input.providerName?.trim() || input.provider.trim();
    const baseUrl = input.baseUrl?.trim() || defaultProviderUrl(type);
    const normalizedBaseUrl = normalizeProviderUrl(baseUrl);
    const hasExplicitName = Boolean(input.providerName?.trim());
    const hasExplicitBaseUrl = Boolean(input.baseUrl?.trim());
    const existing = this.providers.find((provider) => {
      if (provider.type !== type) return false;
      const sameName = provider.name.trim().toLowerCase() === preferredName.toLowerCase();
      const sameBaseUrl = normalizeProviderUrl(provider.baseUrl) === normalizedBaseUrl;

      if (hasExplicitName) {
        return sameName && (!hasExplicitBaseUrl || sameBaseUrl);
      }
      if (type === 'custom' || hasExplicitBaseUrl) {
        return sameName && sameBaseUrl;
      }
      return sameName || sameBaseUrl;
    });
    if (existing) {
      return existing;
    }
    const name = uniqueProviderName(preferredName, baseUrl, this.providers);
    const provider = await this.request<ApiProvider>('/api/v1/providers', {
      method: 'POST',
      body: JSON.stringify({
        type,
        name,
        baseUrl,
        keyStrategy: input.strategy === 'round-robin' ? 'round-robin' : 'priority',
      }),
    });
    this.providers.push(provider);
    return provider;
  }

  public async createCredential(input: CredentialInput): Promise<Credential> {
    const provider = await this.ensureProvider(input);
    const key = await this.request<ApiKey>('/api/v1/keys', {
      method: 'POST',
      body: JSON.stringify({
        providerId: provider.id,
        label: input.name,
        apiKey: input.apiKey || 'ollama-local',
        priority: input.priority,
        dailyLimit: input.dailyLimit ?? null,
        monthlyLimit: input.monthlyLimit ?? null,
        quotaUnit: input.quotaUnit ?? 'usd',
        proxyUrl: input.proxyUrl ?? null,
      }),
    });
    return this.mapCredential(key);
  }

  public async updateCredential(id: string, input: Partial<CredentialInput>): Promise<Credential> {
    const key = await this.request<ApiKey>(`/api/v1/keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(input.name === undefined ? {} : { label: input.name }),
        ...(input.apiKey === undefined || input.apiKey === '' ? {} : { apiKey: input.apiKey }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
        ...(input.monthlyLimit === undefined ? {} : { monthlyLimit: input.monthlyLimit }),
        ...(input.quotaUnit === undefined ? {} : { quotaUnit: input.quotaUnit }),
        ...(input.proxyUrl === undefined || input.proxyUrl === ''
          ? {}
          : { proxyUrl: input.proxyUrl }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      }),
    });
    return this.mapCredential(key);
  }

  public async deleteCredential(id: string): Promise<void> {
    await this.request(`/api/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  public async checkCredential(id: string): Promise<Credential> {
    await this.request<ApiKeyHealthCheck>(`/api/v1/keys/${encodeURIComponent(id)}/check`, {
      method: 'POST',
    });
    const refreshed = (await this.listCredentials()).find((credential) => credential.id === id);
    if (!refreshed) {
      throw new TransportError('健康检查完成，但 API Key 已不存在。', {
        code: 'KEY_NOT_FOUND',
      });
    }
    return refreshed;
  }

  public async checkAllCredentials(): Promise<Credential[]> {
    await this.request<{ results: ApiKeyHealthCheck[] }>('/api/v1/keys/check-all', {
      method: 'POST',
    });
    return this.listCredentials();
  }

  public async listConversations(): Promise<Conversation[]> {
    const conversations: ApiConversation[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await this.request<{
        conversations: ApiConversation[];
        pageInfo?: { hasMore: boolean; nextCursor: string | null };
      }>(`/api/v1/conversations?${query.toString()}`);
      conversations.push(...response.conversations);
      const nextCursor = response.pageInfo?.hasMore ? response.pageInfo.nextCursor : null;
      if (!nextCursor || visitedCursors.has(nextCursor)) {
        cursor = null;
      } else {
        visitedCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } while (cursor);

    this.branchCounts.clear();
    this.parentConversationIds.clear();
    for (const conversation of conversations) {
      this.parentConversationIds.set(conversation.id, conversation.parentConversationId);
      if (conversation.parentConversationId) {
        this.branchCounts.set(
          conversation.parentConversationId,
          (this.branchCounts.get(conversation.parentConversationId) ?? 0) + 1,
        );
      }
    }
    return conversations.map((conversation) =>
      mapConversation(conversation, this.branchCounts.get(conversation.id) ?? 0),
    );
  }

  public async getConversation(id: string): Promise<Conversation> {
    const detail = await this.loadConversationDetail(id);
    this.parentConversationIds.set(
      detail.conversation.id,
      detail.conversation.parentConversationId,
    );
    return mapConversation(detail.conversation, this.branchCounts.get(detail.conversation.id) ?? 0);
  }

  public async createConversation(title?: string): Promise<Conversation> {
    const conversation = await this.request<ApiConversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: title || '新会话', projectId: null }),
    });
    this.branchCounts.set(conversation.id, 0);
    this.parentConversationIds.set(conversation.id, conversation.parentConversationId);
    return mapConversation(conversation, 0);
  }

  public async updateConversation(
    id: string,
    input: Partial<Pick<Conversation, 'title' | 'pinned' | 'archived'>>,
  ): Promise<Conversation> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(id, authenticationGeneration);
    try {
      const conversation = await this.request<ApiConversation>(
        `/api/v1/conversations/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      );
      this.parentConversationIds.set(conversation.id, conversation.parentConversationId);
      return mapConversation(conversation, this.branchCounts.get(conversation.id) ?? 0);
    } finally {
      this.invalidateConversationDetail(id, authenticationGeneration);
    }
  }

  public async deleteConversation(id: string): Promise<void> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(id, authenticationGeneration);
    try {
      await this.request(`/api/v1/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const parentId = this.parentConversationIds.get(id);
      if (parentId) {
        this.branchCounts.set(parentId, Math.max(0, (this.branchCounts.get(parentId) ?? 0) - 1));
      }
      this.parentConversationIds.delete(id);
      this.branchCounts.delete(id);
    } finally {
      this.invalidateConversationDetail(id, authenticationGeneration);
    }
  }

  public async branchConversation(
    id: string,
    messageId: string,
    options: BranchConversationOptions = {},
  ): Promise<Conversation> {
    const authenticationGeneration = this.authenticationGeneration;
    let createdConversationId: string | undefined;
    this.invalidateConversationDetail(id, authenticationGeneration);
    try {
      const actionKey = JSON.stringify({
        action: 'conversation.branch',
        id,
        messageId,
        includeFromMessage: options.includeFromMessage ?? true,
        kind: options.kind ?? 'branch',
        originMessageId: options.originMessageId ?? null,
        title: options.title ?? null,
      });
      const operationId = this.mutationOperationId(actionKey, options.operationId);
      let conversation: ApiConversation;
      try {
        conversation = await this.requestMutation<ApiConversation>(
          `/api/v1/conversations/${encodeURIComponent(id)}/branch`,
          {
            method: 'POST',
            body: JSON.stringify({
              operationId,
              fromMessageId: messageId,
              includeFromMessage: options.includeFromMessage ?? true,
              kind: options.kind ?? 'branch',
              ...(options.originMessageId === undefined
                ? {}
                : { originMessageId: options.originMessageId }),
              ...(options.title === undefined ? {} : { title: options.title }),
            }),
          },
        );
        this.settleMutation(actionKey, operationId);
      } catch (error) {
        if (
          error instanceof TransportError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          this.settleMutation(actionKey, operationId);
        }
        throw error;
      }
      createdConversationId = conversation.id;
      const parentId = conversation.parentConversationId ?? id;
      this.branchCounts.set(parentId, (this.branchCounts.get(parentId) ?? 0) + 1);
      this.branchCounts.set(conversation.id, 0);
      this.parentConversationIds.set(conversation.id, conversation.parentConversationId);
      return mapConversation(conversation, 0);
    } finally {
      this.invalidateConversationDetail(id, authenticationGeneration);
      if (createdConversationId !== undefined) {
        this.invalidateConversationDetail(createdConversationId, authenticationGeneration);
      }
    }
  }

  public createSnapshot(id: string): Promise<Snapshot> {
    return this.request<ApiSnapshot>(`/api/v1/conversations/${encodeURIComponent(id)}/snapshots`, {
      method: 'POST',
    });
  }

  public listSnapshots(id: string): Promise<Snapshot[]> {
    return this.request<ApiSnapshot[]>(`/api/v1/conversations/${encodeURIComponent(id)}/snapshots`);
  }

  public async restoreSnapshot(id: string, snapshotId: string): Promise<Conversation> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(id, authenticationGeneration);
    try {
      const conversation = await this.request<ApiConversation>(
        `/api/v1/conversations/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        { method: 'POST' },
      );
      return mapConversation(conversation, this.branchCounts.get(conversation.id) ?? 0);
    } finally {
      this.invalidateConversationDetail(id, authenticationGeneration);
    }
  }

  public async listMessages(conversationId: string): Promise<Message[]> {
    return (await this.getMessageSnapshot(conversationId)).messages;
  }

  public async getMessageSnapshot(conversationId: string): Promise<MessageSnapshot> {
    const detail = await this.loadConversationDetail(conversationId);
    return {
      messages: detail.messages.map(mapMessage),
      messageCount: detail.messages.length,
      tailMessageId: detail.messages.at(-1)?.id ?? null,
    };
  }

  public async deleteMessage(
    conversationId: string,
    messageId: string,
    precondition: DeleteMessagePrecondition,
  ): Promise<DeleteMessageResult> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(conversationId, authenticationGeneration);
    try {
      const actionKey = JSON.stringify({
        action: 'message.delete_tail',
        conversationId,
        messageId,
        messageCount: precondition.messageCount,
        tailMessageId: precondition.tailMessageId,
      });
      const operationId = this.mutationOperationId(actionKey, precondition.operationId);
      const query = new URLSearchParams({
        operationId,
        expectedMessageCount: String(precondition.messageCount),
        expectedTailMessageId: precondition.tailMessageId,
      });
      let response: {
        conversation: ApiConversation;
        snapshot: ApiSnapshot;
        removedCount: number;
      };
      try {
        response = await this.requestMutation(
          `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}?${query.toString()}`,
          { method: 'DELETE' },
        );
        this.settleMutation(actionKey, operationId);
      } catch (error) {
        if (
          error instanceof TransportError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          this.settleMutation(actionKey, operationId);
        }
        throw error;
      }
      return {
        conversation: mapConversation(
          response.conversation,
          this.branchCounts.get(response.conversation.id) ?? 0,
        ),
        snapshot: response.snapshot,
        removedCount: response.removedCount,
      };
    } finally {
      this.invalidateConversationDetail(conversationId, authenticationGeneration);
    }
  }

  public async setMessageFeedback(
    conversationId: string,
    messageId: string,
    feedback: Message['feedback'],
  ): Promise<Message> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(conversationId, authenticationGeneration);
    try {
      const message = await this.request<ApiMessage>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
        {
          method: 'PATCH',
          body: JSON.stringify({ feedback: feedback ?? null }),
        },
      );
      return mapMessage(message);
    } finally {
      this.invalidateConversationDetail(conversationId, authenticationGeneration);
    }
  }

  public async getContext(conversationId: string): Promise<ContextOverview> {
    const mapBreakdown = (breakdown: {
      totalTokens: number;
      contextWindow: number;
      compressed: boolean;
      sources: Array<{ source: ContextOverview['sources'][number]['type']; tokens: number }>;
    }): ContextOverview => ({
      usedTokens: breakdown.totalTokens,
      contextWindow: breakdown.contextWindow,
      compressed: breakdown.compressed,
      sources: breakdown.sources.map((source) => ({
        id: source.source,
        label:
          source.source === 'system'
            ? '系统提示'
            : source.source === 'history'
              ? '历史消息'
              : source.source === 'memory'
                ? '项目记忆'
                : source.source === 'file'
                  ? '文件'
                  : source.source === 'folder'
                    ? '目录'
                    : '网页',
        type: source.source,
        tokens: source.tokens,
        removable: !['system', 'history'].includes(source.source),
      })),
    });
    try {
      const response = await this.request<
        { breakdown?: Parameters<typeof mapBreakdown>[0] } & Parameters<typeof mapBreakdown>[0]
      >(`/api/v1/conversations/${encodeURIComponent(conversationId)}/context`);
      return mapBreakdown(response.breakdown ?? response);
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 404) {
        throw error;
      }
      const messages = await this.listMessages(conversationId);
      const response = await this.request<{ breakdown: Parameters<typeof mapBreakdown>[0] }>(
        '/api/v1/context/estimate',
        {
          method: 'POST',
          body: JSON.stringify({
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            contextWindow: 64_000,
            sources: [],
          }),
        },
      );
      return mapBreakdown(response.breakdown);
    }
  }

  public async *streamChat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const authenticationGeneration = this.authenticationGeneration;
    this.invalidateConversationDetail(request.conversationId, authenticationGeneration);
    try {
      if (signal?.aborted) throw chatAbortReason(signal);

      const cancellationId = crypto.randomUUID();
      let reachedEndOfStream = false;
      const mainRequestController = new AbortController();
      const stopCancellationRequests = new AbortController();
      let cancellationAcknowledgement: Promise<void> | undefined;
      const requestCancellation = (): void => {
        cancellationAcknowledgement ??= (async () => {
          let retryDelayMs = 50;
          while (!reachedEndOfStream) {
            try {
              const acknowledgement = await this.request<{
                cancellationId: string;
                settled: boolean;
              }>(`/api/v1/chat/completions/${encodeURIComponent(cancellationId)}/cancel`, {
                method: 'POST',
                signal: stopCancellationRequests.signal,
              });
              if (
                acknowledgement.cancellationId !== cancellationId ||
                acknowledgement.settled !== true
              ) {
                throw new TransportError('服务端返回了无效的流式取消确认。', {
                  code: 'INVALID_CANCELLATION_ACK',
                });
              }
              mainRequestController.abort(
                signal === undefined ? undefined : chatAbortReason(signal),
              );
              return;
            } catch {
              if (reachedEndOfStream) return;
              await waitForCancellationRetry(retryDelayMs, stopCancellationRequests.signal);
              retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
            }
          }
        })();
      };
      signal?.addEventListener('abort', requestCancellation, { once: true });
      if (signal?.aborted) requestCancellation();
      const throwSettledCancellation = async (): Promise<never> => {
        await cancellationAcknowledgement;
        signal?.removeEventListener('abort', requestCancellation);
        stopCancellationRequests.abort();
        throw chatAbortReason(signal!);
      };
      const disposeCancellationTracking = (): void => {
        reachedEndOfStream = true;
        signal?.removeEventListener('abort', requestCancellation);
        stopCancellationRequests.abort();
      };

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
          method: 'POST',
          signal: mainRequestController.signal,
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify({
            conversationId: request.conversationId,
            ...(request.userMessageId === undefined
              ? {}
              : { userMessageId: request.userMessageId }),
            modelId: request.model,
            messages: [{ role: 'user', content: request.content }],
            ...(request.skill ? { skill: request.skill } : {}),
            ...(request.contextMentions.length > 0
              ? { contextMentions: request.contextMentions }
              : {}),
            stream: true,
            idempotencyKey: crypto.randomUUID(),
            cancellationId,
          }),
        });
      } catch (error) {
        if (signal?.aborted) return await throwSettledCancellation();
        disposeCancellationTracking();
        throw new TransportError(error instanceof Error ? error.message : '无法开始流式请求。', {
          code: 'NETWORK_ERROR',
        });
      }

      if (!response.ok) {
        if (signal?.aborted) return await throwSettledCancellation();
        let message = `请求失败（${response.status}）`;
        try {
          const payload = (await response.json()) as ApiEnvelope<never>;
          message = payload.error?.message ?? message;
        } catch {
          // 非 JSON 错误由通用消息处理，避免把服务端原文泄露到界面。
        }
        if (signal?.aborted) return await throwSettledCancellation();
        disposeCancellationTracking();
        throw new TransportError(message, {
          code: 'CHAT_REQUEST_FAILED',
          status: response.status,
          correlationId: response.headers.get('x-request-id') ?? undefined,
        });
      }

      let requestId: string = crypto.randomUUID();
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let streamFailure: unknown;
      let streamFailed = false;
      try {
        for await (const rawEvent of parseSseResponse(response)) {
          const raw = rawEvent as unknown as Record<string, unknown>;
          const type = typeof raw.type === 'string' ? raw.type : '';
          if (type === 'queue') {
            yield {
              type: 'queue',
              requestId,
              queue: {
                position:
                  typeof raw.position === 'number' && Number.isInteger(raw.position)
                    ? raw.position
                    : null,
                active: typeof raw.active === 'number' ? raw.active : 0,
                pending: typeof raw.pending === 'number' ? raw.pending : 0,
              },
            };
          } else if (type === 'start') {
            requestId = typeof raw.requestId === 'string' ? raw.requestId : requestId;
            yield {
              type: 'start',
              requestId,
              messageId: typeof raw.messageId === 'string' ? raw.messageId : undefined,
            };
          } else if (type === 'delta') {
            yield {
              type: 'delta',
              requestId,
              delta: typeof raw.content === 'string' ? raw.content : '',
            };
          } else if (type === 'reasoning_delta') {
            yield {
              type: 'reasoning',
              requestId,
              delta: typeof raw.content === 'string' ? raw.content : '',
            };
          } else if (type === 'tool_call_delta') {
            const index =
              typeof raw.index === 'number' && Number.isInteger(raw.index) ? raw.index : 0;
            const current = toolCalls.get(index) ?? {
              id: typeof raw.id === 'string' ? raw.id : `${requestId}-${String(index)}`,
              name: '',
              arguments: '',
            };
            if (typeof raw.id === 'string') current.id = raw.id;
            if (typeof raw.name === 'string') current.name += raw.name;
            if (typeof raw.arguments === 'string') {
              current.arguments += raw.arguments;
            }
            toolCalls.set(index, current);
            yield {
              type: 'tool_call',
              requestId,
              toolCall: {
                ...current,
                status: 'running',
              },
            };
          } else if (type === 'usage') {
            const usage = (raw.usage ?? {}) as Record<string, unknown>;
            yield {
              type: 'usage',
              requestId,
              usage: {
                inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
                outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
                cost: typeof usage.estimatedCostUsd === 'number' ? usage.estimatedCostUsd : 0,
                latencyMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
                reasoningDurationMs:
                  typeof raw.reasoningDurationMs === 'number' ? raw.reasoningDurationMs : undefined,
              },
            };
          } else if (type === 'error') {
            yield {
              type: 'error',
              requestId,
              message: typeof raw.message === 'string' ? raw.message : '流式响应失败。',
            };
          } else if (type === 'done') {
            yield { type: 'done', requestId };
          }
        }
        reachedEndOfStream = true;
      } catch (error) {
        streamFailed = true;
        streamFailure = error;
      } finally {
        signal?.removeEventListener('abort', requestCancellation);
        if (reachedEndOfStream) {
          stopCancellationRequests.abort();
        } else {
          requestCancellation();
        }
        await cancellationAcknowledgement;
      }
      if (signal?.aborted) throw chatAbortReason(signal);
      if (streamFailed) throw streamFailure;
    } finally {
      this.invalidateConversationDetail(request.conversationId, authenticationGeneration);
    }
  }

  public async decideFileChange(
    conversationId: string,
    changeId: string,
    decision: 'accept' | 'reject',
    acceptedLines?: number[],
  ): Promise<void> {
    await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/file-changes/${encodeURIComponent(changeId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, acceptedLines }),
      },
    );
  }

  public executeToolCall(
    _conversationId: string,
    _toolCallId: string,
    _decision: 'approve' | 'reject',
  ): Promise<ToolCall> {
    return Promise.reject(
      new TransportError('Web 模式尚未配置隔离的工作区执行器，请使用桌面端运行工具。', {
        code: 'WORKSPACE_RUNNER_UNAVAILABLE',
      }),
    );
  }

  public async getUsageSummary(range: UsageSummary['range']): Promise<UsageSummary> {
    const dates = dateRange(range);
    const common = `from=${encodeURIComponent(dates.from)}&to=${encodeURIComponent(dates.to)}&limit=100`;
    type ApiBucket = {
      key: string;
      totalTokens: number;
      estimatedCostUsd: number;
      requestCount: number;
      cachedTokens: number;
    };
    type ApiSummary = {
      totals: {
        totalTokens: number;
        estimatedCostUsd: number;
        requestCount: number;
        cachedTokens: number;
      };
      buckets: ApiBucket[];
      costAlert: { thresholdUsd: number; currentUsd: number };
    };
    const [trend, models] = await Promise.all([
      this.request<ApiSummary>(`/api/v1/usage/summary?${common}&groupBy=day`),
      this.request<ApiSummary>(`/api/v1/usage/summary?${common}&groupBy=model`),
    ]);
    return {
      range,
      totalCost: trend.totals.estimatedCostUsd,
      totalTokens: trend.totals.totalTokens,
      requests: trend.totals.requestCount,
      cacheHitRate:
        trend.totals.totalTokens > 0 ? trend.totals.cachedTokens / trend.totals.totalTokens : 0,
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

  public async listUsageRecords(range: UsageSummary['range']): Promise<UsageRecord[]> {
    const dates = dateRange(range);
    const response = await this.request<{
      records: Array<{
        id: string;
        occurredAt: string;
        model: string;
        projectId: string | null;
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
        durationMs: number;
        cacheHit: boolean;
      }>;
    }>(
      `/api/v1/usage/records?from=${encodeURIComponent(dates.from)}&to=${encodeURIComponent(dates.to)}&limit=100&groupBy=day`,
    );
    return response.records.map((record) => ({
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
  }

  public async exportUsage(
    range: UsageSummary['range'],
    format: 'csv' | 'json' | 'pdf',
  ): Promise<Blob> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/usage/export?from=${encodeURIComponent(dateRange(range).from)}&to=${encodeURIComponent(dateRange(range).to)}&groupBy=day&format=${format}`,
      {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
      },
    );
    if (!response.ok) {
      throw new TransportError('报表导出失败。', { status: response.status });
    }
    return response.blob();
  }

  public listSkills(): Promise<Skill[]> {
    return this.request<{ skills: ApiSkill[] }>('/api/v1/skills').then((response) =>
      response.skills.map(mapSkill),
    );
  }

  public async setSkillEnabled(id: string, enabled: boolean): Promise<Skill> {
    await this.request(`/api/v1/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    const updated = (await this.listSkills()).find((skill) => skill.id === id);
    if (!updated) {
      throw new TransportError('Skill 状态已更新，但无法重新读取其定义。', {
        code: 'SKILL_NOT_FOUND',
      });
    }
    return updated;
  }

  public async installSkill(source: string): Promise<Skill> {
    const response = await this.request<{ skill: ApiSkill; enabled: boolean }>(
      '/api/v1/skills/install',
      {
        method: 'POST',
        body: JSON.stringify(
          /^https:\/\//i.test(source)
            ? { type: 'git', url: source }
            : { type: 'directory', path: source },
        ),
      },
    );
    return mapSkill({ ...response.skill, enabled: response.enabled });
  }

  public listWorkflows(): Promise<WorkflowDefinition[]> {
    return this.request<{ workflows: WorkflowDefinition[] }>('/api/v1/workflows').then(
      (response) => response.workflows,
    );
  }

  public saveWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    return this.request<{ workflow: WorkflowDefinition }>('/api/v1/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }).then((response) => response.workflow);
  }

  public async deleteWorkflow(id: string): Promise<void> {
    await this.request(`/api/v1/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  public runWorkflow(
    id: string,
    variables: Record<string, string>,
    locale: 'zh-CN' | 'en-US' = 'zh-CN',
  ): Promise<WorkflowResult> {
    return this.request(`/api/v1/workflows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify({ variables, locale }),
    });
  }

  public listPlugins(): Promise<Plugin[]> {
    return this.request<{ plugins: ApiPluginStatus[] }>('/api/v1/plugins').then((response) =>
      response.plugins.map(mapPlugin),
    );
  }

  public async setPluginApproved(id: string, approved: boolean): Promise<Plugin> {
    await this.request(`/api/v1/plugins/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: approved ? 'approve' : 'revoke' }),
    });
    if (!approved) {
      await this.request(`/api/v1/plugins/${encodeURIComponent(id)}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'disable' }),
      });
    }
    const updated = (await this.listPlugins()).find((plugin) => plugin.id === id);
    if (!updated) {
      throw new TransportError('插件权限已更新，但无法重新读取插件。', {
        code: 'PLUGIN_NOT_FOUND',
      });
    }
    return updated;
  }

  public async setPluginEnabled(id: string, enabled: boolean): Promise<Plugin> {
    await this.request(`/api/v1/plugins/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: enabled ? 'enable' : 'disable' }),
    });
    const updated = (await this.listPlugins()).find((plugin) => plugin.id === id);
    if (!updated) {
      throw new TransportError('插件状态已更新，但无法重新读取插件。', {
        code: 'PLUGIN_NOT_FOUND',
      });
    }
    return updated;
  }

  public async installPlugin(source: string): Promise<Plugin> {
    const installed = await this.request<{ manifest: ApiPluginStatus['manifest'] }>(
      '/api/v1/plugins/install',
      {
        method: 'POST',
        body: JSON.stringify(
          /^https:\/\//i.test(source)
            ? { type: 'git', url: source }
            : { type: 'directory', path: source },
        ),
      },
    );
    const plugin = (await this.listPlugins()).find(
      (candidate) => candidate.id === installed.manifest.id,
    );
    if (!plugin) {
      throw new TransportError('插件已安装，但无法读取安装结果。', {
        code: 'PLUGIN_NOT_FOUND',
      });
    }
    return plugin;
  }

  public async uninstallPlugin(id: string): Promise<void> {
    await this.request(`/api/v1/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  public listMcpServers(): Promise<McpServerSummary[]> {
    return Promise.resolve([]);
  }

  public saveMcpServer(_input: McpServerInput): Promise<McpServerSummary> {
    return Promise.reject(this.mcpDesktopOnlyError());
  }

  public setMcpServerEnabled(_id: string, _enabled: boolean): Promise<McpServerSummary> {
    return Promise.reject(this.mcpDesktopOnlyError());
  }

  public refreshMcpServer(_id: string): Promise<McpServerSummary> {
    return Promise.reject(this.mcpDesktopOnlyError());
  }

  public removeMcpServer(_id: string): Promise<void> {
    return Promise.reject(this.mcpDesktopOnlyError());
  }

  private mcpDesktopOnlyError(): TransportError {
    return new TransportError('MCP Server 当前仅支持在桌面端配置和运行。', {
      code: 'MCP_DESKTOP_ONLY',
    });
  }

  public async getSettings(): Promise<AppSettings> {
    return mapSettings(await this.request<ApiSettings>('/api/v1/settings'));
  }

  public async updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    const previousLocal = readLocalSettingExtras();
    const nextLocal: LocalSettingExtras = {
      ...previousLocal,
      ...(input.autoCompressContext === undefined
        ? {}
        : { autoCompressContext: input.autoCompressContext }),
      ...(input.autoUpdate === undefined ? {} : { autoUpdate: input.autoUpdate }),
      ...(input.telemetryEnabled === undefined ? {} : { telemetryEnabled: input.telemetryEnabled }),
      ...(input.ollamaFallback === undefined ? {} : { ollamaFallback: input.ollamaFallback }),
      ...(input.reasoningDisplay === undefined ? {} : { reasoningDisplay: input.reasoningDisplay }),
      ...(input.tutorialCompletedVersion === undefined
        ? {}
        : { tutorialCompletedVersion: input.tutorialCompletedVersion }),
      ...(input.autoExpandRunningTools === undefined
        ? {}
        : { autoExpandRunningTools: input.autoExpandRunningTools }),
    };
    writeLocalSettingExtras(nextLocal);
    const defaultModels = input.defaultModels;
    const serverUpdate = {
      ...(input.locale === undefined ? {} : { language: input.locale }),
      ...(input.theme === undefined ? {} : { theme: input.theme }),
      ...(input.maxConcurrency === undefined
        ? {}
        : { maxConcurrentRequests: input.maxConcurrency }),
      ...(input.costAlertThreshold === undefined
        ? {}
        : { dailyCostAlertUsd: input.costAlertThreshold }),
      ...(input.autoCompressContext === undefined
        ? {}
        : { contextCompressionThreshold: input.autoCompressContext ? 0.7 : 0.9 }),
      ...(input.toolExecutionPolicy === undefined
        ? {}
        : { toolExecutionPolicy: input.toolExecutionPolicy }),
      ...(input.toolCommandTimeoutMs === undefined
        ? {}
        : { toolCommandTimeoutMs: input.toolCommandTimeoutMs }),
      ...(input.toolOutputLimitBytes === undefined
        ? {}
        : { toolOutputLimitBytes: input.toolOutputLimitBytes }),
      ...(defaultModels === undefined
        ? {}
        : {
            defaultModels: {
              ...('code' in defaultModels ? { code: defaultModels.code || null } : {}),
              ...('chat' in defaultModels ? { chat: defaultModels.chat || null } : {}),
              ...('embedding' in defaultModels
                ? { embedding: defaultModels.embedding || null }
                : {}),
              ...('vision' in defaultModels ? { vision: defaultModels.vision || null } : {}),
            },
            ...('summarize' in defaultModels
              ? { contextCompressionModelId: defaultModels.summarize || null }
              : {}),
          }),
    };
    try {
      const response =
        Object.keys(serverUpdate).length === 0
          ? await this.request<ApiSettings>('/api/v1/settings')
          : await this.request<ApiSettings>('/api/v1/settings', {
              method: 'PATCH',
              body: JSON.stringify(serverUpdate),
            });
      return mapSettings(response);
    } catch (error) {
      writeLocalSettingExtras(previousLocal);
      throw error;
    }
  }

  public async listAuditEntries(): Promise<AuditEntry[]> {
    const response = await this.request<{
      logs: Array<{
        id: string;
        actorId: string | null;
        action: string;
        targetType: string;
        targetId: string | null;
        metadata: Record<string, unknown>;
        createdAt: string;
      }>;
    }>('/api/v1/audit?limit=100');
    return response.logs.map((entry) => ({
      id: entry.id,
      actorName: entry.actorId ?? '系统',
      action: entry.action,
      target: `${entry.targetType}${entry.targetId ? `:${entry.targetId}` : ''}`,
      result:
        entry.metadata.result === 'failure' || entry.metadata.success === false
          ? 'failure'
          : 'success',
      createdAt: entry.createdAt,
      correlationId: entry.id,
    }));
  }

  public async getQueueStatus(): Promise<{
    running: number;
    queued: number;
    position?: number;
  }> {
    const response = await this.request<{ active: number; pending: number }>(
      '/api/v1/queue/status',
    );
    return { running: response.active, queued: response.pending };
  }

  public async runStartupCheck(): Promise<Array<{ name: string; ok: boolean; message: string }>> {
    const response = await this.request<{
      status: string;
      version: string;
      node: string;
      databaseSchemaVersion: number;
      extensionsReady: boolean;
      runtime?: { memoryRssBytes?: number };
    }>('/api/v1/system/status');
    const nodeMajor = Number(/^v?(\d+)/.exec(response.node)?.[1] ?? 0);
    const memoryMb = Math.round((response.runtime?.memoryRssBytes ?? 0) / 1024 / 1024);
    return [
      {
        name: 'E Agent 服务',
        ok: response.status === 'ok',
        message: `版本 ${response.version}`,
      },
      {
        name: 'Node.js 运行时',
        ok: nodeMajor >= 20,
        message: response.node,
      },
      {
        name: '数据库',
        ok: response.databaseSchemaVersion >= 1,
        message: `Schema v${response.databaseSchemaVersion}`,
      },
      {
        name: '扩展运行时',
        ok: response.extensionsReady,
        message: response.extensionsReady ? '已就绪' : '尚未就绪',
      },
      {
        name: '内存占用',
        ok: memoryMb === 0 || memoryMb < 500,
        message: memoryMb === 0 ? '暂无采样' : `${memoryMb} MB`,
      },
    ];
  }
}

export function createHttpTransport(baseUrl: string): EAgentTransport {
  return new HttpTransport(baseUrl);
}
