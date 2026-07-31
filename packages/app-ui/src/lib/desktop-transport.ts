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

import {
  TransportError,
  type BranchConversationOptions,
  type CredentialInput,
  type DeleteMessagePrecondition,
  type DeleteMessageResult,
  type EAgentTransport,
  type LoginInput,
  type MessageSnapshot,
  type ProviderInput,
  type SetupInput,
  type TeamMemberInput,
} from './transport';

export interface DesktopBridge {
  invoke<T>(channel: string, payload?: unknown): Promise<T>;
  stream(
    channel: string,
    payload: unknown,
    callbacks: {
      onEvent: (event: StreamEvent) => void;
      onError: (error: Error) => void;
      onComplete: () => void;
    },
  ): () => void;
}

class DesktopTransport implements EAgentTransport {
  public readonly kind = 'desktop' as const;
  private readonly pendingMutationIds = new Map<string, string>();

  public constructor(private readonly bridge: DesktopBridge) {}

  private invoke<T>(channel: string, payload?: unknown): Promise<T> {
    return this.bridge.invoke<T>(channel, payload);
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

  public getSession(): Promise<SessionInfo | null> {
    return this.invoke('auth:get-session');
  }
  public setup(input: SetupInput): Promise<SessionInfo> {
    return this.invoke('auth:setup', {
      name: input.name,
      email: input.email,
      password: input.password,
    });
  }
  public login(input: LoginInput): Promise<SessionInfo> {
    return this.invoke('auth:login', input);
  }
  public logout(): Promise<void> {
    return this.invoke('auth:logout');
  }
  public async listUsers(): Promise<User[]> {
    const session = await this.getSession();
    return session ? [session.user] : [];
  }
  public createUser(_input: TeamMemberInput): Promise<User> {
    return Promise.reject(this.teamManagementError());
  }
  public updateUser(
    _id: string,
    _input: Partial<Pick<User, 'name' | 'role' | 'active'>>,
  ): Promise<User> {
    return Promise.reject(this.teamManagementError());
  }
  public deleteUser(_id: string): Promise<void> {
    return Promise.reject(this.teamManagementError());
  }
  public getWorkspaceBinding(): Promise<WorkspaceBinding | null> {
    return this.invoke('workspace:get-binding');
  }
  public chooseWorkspace(): Promise<WorkspaceBinding | null> {
    return this.invoke('workspace:choose');
  }

  private teamManagementError(): TransportError {
    return new TransportError('团队成员管理仅在 Web 协作模式中可用。', {
      code: 'TEAM_MANAGEMENT_WEB_ONLY',
    });
  }
  public listModels(): Promise<Model[]> {
    return this.invoke('models:list');
  }
  public discoverModels(providerId?: string): Promise<Model[]> {
    return this.invoke('models:discover', providerId === undefined ? {} : { providerId });
  }
  public updateProviderModelSelection(
    providerId: string,
    enabledModelIds: string[],
  ): Promise<Model[]> {
    return this.invoke('models:update-provider-selection', { providerId, enabledModelIds });
  }
  public listProviders(): Promise<ProviderConfig[]> {
    return this.invoke('providers:list');
  }
  public createProvider(input: ProviderInput): Promise<ProviderConfig> {
    return this.invoke('providers:create', input);
  }
  public updateProvider(id: string, input: Partial<ProviderInput>): Promise<ProviderConfig> {
    return this.invoke('providers:update', { id, input });
  }
  public listCredentials(): Promise<Credential[]> {
    return this.invoke('credentials:list');
  }
  public createCredential(input: CredentialInput): Promise<Credential> {
    return this.invoke('credentials:create', input);
  }
  public updateCredential(id: string, input: Partial<CredentialInput>): Promise<Credential> {
    const sanitizedInput = Object.fromEntries(
      Object.entries(input).filter(
        ([key, value]) =>
          value !== undefined && !((key === 'apiKey' || key === 'proxyUrl') && value === ''),
      ),
    );
    return this.invoke('credentials:update', { id, input: sanitizedInput });
  }
  public deleteCredential(id: string): Promise<void> {
    return this.invoke('credentials:delete', { id });
  }
  public checkCredential(id: string): Promise<Credential> {
    return this.invoke('credentials:check', { id });
  }
  public checkAllCredentials(): Promise<Credential[]> {
    return this.invoke('credentials:check-all');
  }
  public listConversations(): Promise<Conversation[]> {
    return this.invoke('conversations:list');
  }
  public async getConversation(id: string): Promise<Conversation> {
    try {
      return await this.invoke('conversations:get', { id });
    } catch (error) {
      const code =
        error instanceof Error
          ? ((error as Error & { code?: unknown }).code ?? error.name)
          : undefined;
      if (code === 'NOT_FOUND') {
        throw new TransportError(error instanceof Error ? error.message : '会话不存在。', {
          code: 'NOT_FOUND',
          status: 404,
        });
      }
      throw error;
    }
  }
  public createConversation(title?: string): Promise<Conversation> {
    return this.invoke('conversations:create', { title });
  }
  public updateConversation(
    id: string,
    input: Partial<Pick<Conversation, 'title' | 'pinned' | 'archived'>>,
  ): Promise<Conversation> {
    return this.invoke('conversations:update', { id, input });
  }
  public deleteConversation(id: string): Promise<void> {
    return this.invoke('conversations:delete', { id });
  }
  public branchConversation(
    id: string,
    messageId: string,
    options: BranchConversationOptions = {},
  ): Promise<Conversation> {
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
    return this.invoke<Conversation>('conversations:branch', {
      id,
      messageId,
      ...options,
      operationId,
    }).then((result) => {
      this.settleMutation(actionKey, operationId);
      return result;
    });
  }
  public createSnapshot(id: string): Promise<Snapshot> {
    return this.invoke('conversations:snapshot', { id });
  }
  public listSnapshots(id: string): Promise<Snapshot[]> {
    return this.invoke('conversations:list-snapshots', { id });
  }
  public restoreSnapshot(id: string, snapshotId: string): Promise<Conversation> {
    return this.invoke('conversations:restore-snapshot', { id, snapshotId });
  }
  public listMessages(conversationId: string): Promise<Message[]> {
    return this.invoke('messages:list', { conversationId });
  }
  public getMessageSnapshot(conversationId: string): Promise<MessageSnapshot> {
    return this.invoke('messages:snapshot', { conversationId });
  }
  public deleteMessage(
    conversationId: string,
    messageId: string,
    precondition: DeleteMessagePrecondition,
  ): Promise<DeleteMessageResult> {
    const actionKey = JSON.stringify({
      action: 'message.delete_tail',
      conversationId,
      messageId,
      messageCount: precondition.messageCount,
      tailMessageId: precondition.tailMessageId,
    });
    const operationId = this.mutationOperationId(actionKey, precondition.operationId);
    return this.invoke<DeleteMessageResult>('messages:delete', {
      conversationId,
      messageId,
      operationId,
      expectedMessageCount: precondition.messageCount,
      expectedTailMessageId: precondition.tailMessageId,
    }).then((result) => {
      this.settleMutation(actionKey, operationId);
      return result;
    });
  }
  public setMessageFeedback(
    conversationId: string,
    messageId: string,
    feedback: Message['feedback'],
  ): Promise<Message> {
    return this.invoke('messages:feedback', {
      conversationId,
      messageId,
      feedback: feedback ?? null,
    });
  }
  public getContext(conversationId: string): Promise<ContextOverview> {
    return this.invoke('context:get', { conversationId });
  }

  public async *streamChat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const queue: StreamEvent[] = [];
    let resolver: (() => void) | undefined;
    let finished = false;
    let streamError: Error | undefined;

    const wake = (): void => {
      resolver?.();
      resolver = undefined;
    };

    const unsubscribe = this.bridge.stream('chat:stream', request, {
      onEvent: (event) => {
        queue.push(event);
        wake();
      },
      onError: (error) => {
        streamError = error;
        finished = true;
        wake();
      },
      onComplete: () => {
        finished = true;
        wake();
      },
    });

    const abort = (): void => {
      unsubscribe();
      wake();
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    try {
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolver = resolve;
          });
          continue;
        }

        const event = queue.shift();
        if (event) {
          yield event;
        }
      }

      if (streamError) {
        throw streamError;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      unsubscribe();
    }
  }

  public decideFileChange(
    conversationId: string,
    changeId: string,
    decision: 'accept' | 'reject',
    acceptedLines?: number[],
  ): Promise<ToolCall> {
    return this.invoke('workspace:decide-change', {
      conversationId,
      changeId,
      decision,
      acceptedLines,
    });
  }
  public executeToolCall(
    conversationId: string,
    toolCallId: string,
    decision: 'approve' | 'reject',
  ): Promise<ToolCall> {
    return this.invoke('tools:decide', { conversationId, toolCallId, decision });
  }
  public getUsageSummary(range: UsageSummary['range']): Promise<UsageSummary> {
    return this.invoke('usage:summary', { range });
  }
  public listUsageRecords(range: UsageSummary['range']): Promise<UsageRecord[]> {
    return this.invoke('usage:records', { range });
  }
  public exportUsage(range: UsageSummary['range'], format: 'csv' | 'json' | 'pdf'): Promise<Blob> {
    return this.invoke('usage:export', { range, format });
  }
  public listSkills(): Promise<Skill[]> {
    return this.invoke<Skill[]>('skills:list').then((skills) =>
      skills.map((skill) => ({
        ...skill,
        variables: skill.variables ?? fallbackSkillVariables(skill.command),
      })),
    );
  }
  public setSkillEnabled(id: string, enabled: boolean): Promise<Skill> {
    return this.invoke('skills:set-enabled', { id, enabled });
  }
  public installSkill(source: string): Promise<Skill> {
    return this.invoke('skills:install', { source });
  }
  public listWorkflows(): Promise<WorkflowDefinition[]> {
    return this.invoke('workflows:list');
  }
  public saveWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    return this.invoke('workflows:save', { workflow });
  }
  public deleteWorkflow(id: string): Promise<void> {
    return this.invoke('workflows:delete', { id });
  }
  public runWorkflow(
    id: string,
    variables: Record<string, string>,
    locale: 'zh-CN' | 'en-US' = 'zh-CN',
  ): Promise<WorkflowResult> {
    return this.invoke('workflows:run', { id, variables, locale });
  }
  public listPlugins(): Promise<Plugin[]> {
    return this.invoke('plugins:list');
  }
  public async setPluginApproved(id: string, approved: boolean): Promise<Plugin> {
    await this.invoke(approved ? 'plugins:approve' : 'plugins:revoke', {
      pluginId: id,
    });
    if (!approved) {
      await this.invoke('plugins:disable', { pluginId: id });
    }
    const plugin = (await this.listPlugins()).find((candidate) => candidate.id === id);
    if (!plugin) {
      throw new Error('插件权限已更新，但无法重新读取插件。');
    }
    return plugin;
  }
  public setPluginEnabled(id: string, enabled: boolean): Promise<Plugin> {
    return this.invoke('plugins:set-enabled', { id, enabled });
  }
  public installPlugin(source: string): Promise<Plugin> {
    return this.invoke('plugins:install', { source });
  }
  public uninstallPlugin(id: string): Promise<void> {
    return this.invoke('plugins:uninstall', { id });
  }
  public listMcpServers(): Promise<McpServerSummary[]> {
    return this.invoke('mcp:list');
  }
  public saveMcpServer(input: McpServerInput): Promise<McpServerSummary> {
    return this.invoke('mcp:save', input);
  }
  public setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerSummary> {
    return this.invoke('mcp:set-enabled', { id, enabled });
  }
  public refreshMcpServer(id: string): Promise<McpServerSummary> {
    return this.invoke('mcp:refresh', { id });
  }
  public removeMcpServer(id: string): Promise<void> {
    return this.invoke('mcp:remove', { id });
  }
  public getSettings(): Promise<AppSettings> {
    return this.invoke('settings:get');
  }
  public updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    return this.invoke('settings:update', input);
  }
  public listAuditEntries(): Promise<AuditEntry[]> {
    return this.invoke('audit:list');
  }
  public getQueueStatus(): Promise<{ running: number; queued: number; position?: number }> {
    return this.invoke('queue:status');
  }
  public runStartupCheck(): Promise<Array<{ name: string; ok: boolean; message: string }>> {
    return this.invoke('system:check');
  }
}

export function createDesktopTransport(bridge: DesktopBridge): EAgentTransport {
  return new DesktopTransport(bridge);
}

function fallbackSkillVariables(command: string): Skill['variables'] {
  const name =
    command === '@db-helper' ? 'request' : command === '@deploy' ? 'projectContext' : 'code';
  return [
    {
      name,
      description: 'Workflow 主输入',
      required: command !== '@code-review',
      maximumLength: 1_000_000,
    },
  ];
}
