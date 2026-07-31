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
  ProviderType,
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

export interface LoginInput {
  email: string;
  password: string;
}

export interface SetupInput extends LoginInput {
  name: string;
  bootstrapToken?: string;
}

export interface TeamMemberInput extends SetupInput {
  role: Exclude<User['role'], 'owner'>;
}

export interface CredentialInput {
  name: string;
  providerId?: string;
  provider?: string;
  providerName?: string;
  apiKey: string;
  baseUrl?: string;
  strategy: Credential['strategy'];
  priority: number;
  dailyLimit?: number | null;
  monthlyLimit?: number | null;
  quotaUnit?: Credential['quotaUnit'];
  proxyUrl?: string | null;
  enabled?: boolean;
}

export interface ProviderInput {
  type: ProviderType;
  name: string;
  baseUrl: string;
  keyStrategy: ProviderConfig['keyStrategy'];
  enabled?: boolean;
}

interface BranchConversationOptionsBase {
  operationId?: string;
  includeFromMessage?: boolean;
  title?: string;
}

export type BranchConversationOptions =
  | (BranchConversationOptionsBase & {
      kind?: 'branch';
      originMessageId?: never;
    })
  | (BranchConversationOptionsBase & {
      kind: 'retry' | 'edit';
      originMessageId: string;
    });

export interface DeleteMessageResult {
  conversation: Conversation;
  snapshot?: Snapshot;
  removedCount: number;
  transient?: boolean;
}

export interface MessageSnapshot {
  messages: Message[];
  messageCount: number;
  tailMessageId: string | null;
}

export interface DeleteMessagePrecondition {
  operationId?: string;
  messageCount: number;
  tailMessageId: string;
}

export interface EAgentTransport {
  readonly kind: 'http' | 'desktop' | 'mock';
  getSession(): Promise<SessionInfo | null>;
  setup(input: SetupInput): Promise<SessionInfo>;
  login(input: LoginInput): Promise<SessionInfo>;
  logout(): Promise<void>;
  listUsers(): Promise<User[]>;
  createUser(input: TeamMemberInput): Promise<User>;
  updateUser(id: string, input: Partial<Pick<User, 'name' | 'role' | 'active'>>): Promise<User>;
  deleteUser(id: string): Promise<void>;
  getWorkspaceBinding(): Promise<WorkspaceBinding | null>;
  chooseWorkspace(): Promise<WorkspaceBinding | null>;
  listModels(signal?: AbortSignal): Promise<Model[]>;
  discoverModels(providerId?: string): Promise<Model[]>;
  updateProviderModelSelection(providerId: string, enabledModelIds: string[]): Promise<Model[]>;
  listProviders(): Promise<ProviderConfig[]>;
  createProvider(input: ProviderInput): Promise<ProviderConfig>;
  updateProvider(id: string, input: Partial<ProviderInput>): Promise<ProviderConfig>;
  listCredentials(): Promise<Credential[]>;
  createCredential(input: CredentialInput): Promise<Credential>;
  updateCredential(id: string, input: Partial<CredentialInput>): Promise<Credential>;
  deleteCredential(id: string): Promise<void>;
  checkCredential(id: string): Promise<Credential>;
  checkAllCredentials(): Promise<Credential[]>;
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation>;
  createConversation(title?: string): Promise<Conversation>;
  updateConversation(
    id: string,
    input: Partial<Pick<Conversation, 'title' | 'pinned' | 'archived'>>,
  ): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  branchConversation(
    id: string,
    messageId: string,
    options?: BranchConversationOptions,
  ): Promise<Conversation>;
  createSnapshot(id: string): Promise<Snapshot>;
  listSnapshots(id: string): Promise<Snapshot[]>;
  restoreSnapshot(id: string, snapshotId: string): Promise<Conversation>;
  listMessages(conversationId: string): Promise<Message[]>;
  getMessageSnapshot(conversationId: string): Promise<MessageSnapshot>;
  deleteMessage(
    conversationId: string,
    messageId: string,
    precondition: DeleteMessagePrecondition,
  ): Promise<DeleteMessageResult>;
  setMessageFeedback(
    conversationId: string,
    messageId: string,
    feedback: Message['feedback'],
  ): Promise<Message>;
  getContext(conversationId: string): Promise<ContextOverview>;
  streamChat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  decideFileChange(
    conversationId: string,
    changeId: string,
    decision: 'accept' | 'reject',
    acceptedLines?: number[],
  ): Promise<ToolCall | void>;
  executeToolCall(
    conversationId: string,
    toolCallId: string,
    decision: 'approve' | 'reject',
  ): Promise<ToolCall>;
  getUsageSummary(range: UsageSummary['range']): Promise<UsageSummary>;
  listUsageRecords(range: UsageSummary['range']): Promise<UsageRecord[]>;
  exportUsage(range: UsageSummary['range'], format: 'csv' | 'json' | 'pdf'): Promise<Blob>;
  listSkills(): Promise<Skill[]>;
  setSkillEnabled(id: string, enabled: boolean): Promise<Skill>;
  installSkill(source: string): Promise<Skill>;
  listWorkflows(): Promise<WorkflowDefinition[]>;
  saveWorkflow(workflow: WorkflowDefinition): Promise<WorkflowDefinition>;
  deleteWorkflow(id: string): Promise<void>;
  runWorkflow(
    id: string,
    variables: Record<string, string>,
    locale?: 'zh-CN' | 'en-US',
  ): Promise<WorkflowResult>;
  listPlugins(): Promise<Plugin[]>;
  setPluginApproved(id: string, approved: boolean): Promise<Plugin>;
  setPluginEnabled(id: string, enabled: boolean): Promise<Plugin>;
  installPlugin(source: string): Promise<Plugin>;
  uninstallPlugin(id: string): Promise<void>;
  listMcpServers(): Promise<McpServerSummary[]>;
  saveMcpServer(input: McpServerInput): Promise<McpServerSummary>;
  setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerSummary>;
  refreshMcpServer(id: string): Promise<McpServerSummary>;
  removeMcpServer(id: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  listAuditEntries(): Promise<AuditEntry[]>;
  getQueueStatus(): Promise<{ running: number; queued: number; position?: number }>;
  runStartupCheck(): Promise<Array<{ name: string; ok: boolean; message: string }>>;
}

export class TransportError extends Error {
  public readonly code: string;
  public readonly correlationId?: string;
  public readonly status?: number;
  public readonly bootstrapTokenRequired?: boolean;

  public constructor(
    message: string,
    options: {
      code?: string;
      correlationId?: string;
      status?: number;
      bootstrapTokenRequired?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'TransportError';
    this.code = options.code ?? 'TRANSPORT_ERROR';
    this.correlationId = options.correlationId;
    this.status = options.status;
    this.bootstrapTokenRequired = options.bootstrapTokenRequired;
  }
}
