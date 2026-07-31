export type AppMode = 'desktop' | 'web';
export type Locale = 'zh-CN' | 'en-US';
export type HealthLevel = 'healthy' | 'warning' | 'error' | 'unknown';
export type KeyStrategy = 'round-robin' | 'priority' | 'failover';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type StreamEventType =
  | 'queue'
  | 'start'
  | 'delta'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'file_change'
  | 'error'
  | 'done';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  active: boolean;
}

export interface SessionInfo {
  user: User;
  expiresAt: string;
}

export interface WorkspaceBinding {
  bindingId?: string;
  root: string;
  name: string;
}

export interface Model {
  id: string;
  remoteId?: string;
  providerId: string;
  providerName: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  capabilities: Array<'code' | 'chat' | 'embedding' | 'vision' | 'function-calling'>;
  configuredEnabled?: boolean;
  available: boolean;
  stale?: boolean;
  latencyMs?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

export interface Credential {
  id: string;
  name: string;
  providerId?: string;
  providerName?: string;
  providerType?: string;
  provider: string;
  lastFour: string;
  status: HealthLevel;
  strategy: KeyStrategy;
  priority: number;
  dailyUsed: number;
  dailyLimit?: number;
  monthlyUsed: number;
  monthlyLimit?: number;
  quotaUnit: 'usd' | 'tokens';
  proxyMode: 'direct' | 'http' | 'local';
  lastCheckedAt?: string;
  enabled: boolean;
}

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'groq'
  | 'google'
  | 'ollama'
  | 'custom';

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  enabled: boolean;
  keyStrategy: Extract<KeyStrategy, 'round-robin' | 'priority'>;
  modelDiscoveryError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Conversation {
  id: string;
  projectId?: string;
  parentConversationId?: string;
  branchedFromMessageId?: string;
  forkKind?: 'branch' | 'retry' | 'edit';
  originMessageId?: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
  branchCount: number;
  messageCount: number;
}

export interface Snapshot {
  id: string;
  conversationId: string;
  messageCount: number;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status:
    | 'pending'
    | 'approval-required'
    | 'running'
    | 'completed'
    | 'failed'
    | 'rejected'
    | 'timed-out'
    | 'cancelled';
  result?: string;
  summary?: string;
  durationMs?: number;
  errorCode?: string;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FileChange {
  id: string;
  path: string;
  diff: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  createdAt: string;
  model?: string;
  status?: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  feedback?: 'helpful' | 'unhelpful' | null;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolCalls?: ToolCall[];
  fileChanges?: FileChange[];
}

export interface ContextSource {
  id: string;
  label: string;
  type: 'system' | 'history' | 'file' | 'folder' | 'web' | 'memory';
  tokens: number;
  removable: boolean;
}

export interface ContextOverview {
  usedTokens: number;
  contextWindow: number;
  sources: ContextSource[];
  compressed: boolean;
}

export interface UsageSummary {
  range: 'day' | 'week' | 'month';
  totalCost: number;
  totalTokens: number;
  requests: number;
  cacheHitRate: number;
  budget: number;
  alertCost?: number;
  trend: Array<{
    date: string;
    tokens: number;
    cost: number;
  }>;
  byModel: Array<{
    model: string;
    tokens: number;
    cost: number;
  }>;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  cacheHit: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'builtin' | 'local' | 'git';
  enabled: boolean;
  command: string;
  permissions: string[];
  variables: SkillVariable[];
}

export interface SkillVariable {
  name: string;
  description: string;
  required: boolean;
  maximumLength: number;
}

export interface WorkflowStep {
  id: string;
  skillId: string;
  dependsOn: string[];
  input: Record<string, string>;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  steps: WorkflowStep[];
}

export interface WorkflowResult {
  workflowId: string;
  outputs: Record<string, unknown>;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  approved: boolean;
  source: string;
  types: Array<'ui' | 'hook' | 'provider' | 'tool'>;
  permissions: string[];
  updateAvailable?: string;
}

export type McpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export type McpServerInput =
  | {
      id?: string;
      displayName: string;
      enabled?: boolean;
      transport: 'stdio';
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      inheritEnv?: boolean;
    }
  | {
      id?: string;
      displayName: string;
      enabled?: boolean;
      transport: 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      allowInsecureHttp?: boolean;
    };

export interface McpServerSummary {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpServerInput['transport'];
  endpoint: string;
  state: McpServerState;
  toolCount: number;
  tools: string[];
  hasCredentials: boolean;
  lastError?: string;
  updatedAt?: string;
}

export interface AppSettings {
  locale: Locale;
  theme: string;
  defaultModels: Record<string, string>;
  maxConcurrency: number;
  costAlertThreshold: number;
  autoCompressContext: boolean;
  autoUpdate: boolean;
  telemetryEnabled: boolean;
  ollamaFallback: boolean;
  reasoningDisplay: 'collapsed' | 'expanded' | 'hidden';
  toolExecutionPolicy: 'always-ask' | 'allow-safe' | 'disabled';
  toolCommandTimeoutMs: number;
  toolOutputLimitBytes: number;
  tutorialCompletedVersion: number;
  autoExpandRunningTools: boolean;
}

export interface ChatRequest {
  conversationId: string;
  userMessageId?: string;
  content: string;
  model: string;
  continuationToolCallId?: string;
  skill?: string;
  contextMentions: string[];
  compareModels?: string[];
}

export interface StreamEvent {
  type: StreamEventType;
  requestId: string;
  messageId?: string;
  delta?: string;
  message?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    latencyMs: number;
    reasoningDurationMs?: number;
  };
  toolCall?: ToolCall;
  fileChange?: FileChange;
  queue?: {
    position: number | null;
    active: number;
    pending: number;
  };
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  correlationId?: string;
  details?: unknown;
}

export interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  target: string;
  result: 'success' | 'failure';
  createdAt: string;
  correlationId: string;
}
