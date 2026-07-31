import type {
  ApiKeySummary,
  Conversation,
  ConversationMessage,
  Model,
  Provider,
  UsageRecord,
  User,
} from '@e-agent/contracts';
import type {
  ApiKeyRow,
  ConversationRow,
  MessageRow,
  ModelRow,
  ProviderRow,
  UsageRecordRow,
  UserRow,
} from '@e-agent/database';

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    keyStrategy: row.keyStrategy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapApiKey(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    maskedKey: row.maskedKey,
    priority: row.priority,
    health: row.health,
    enabled: row.enabled,
    pausedReason: row.pausedReason,
    dailyLimit: row.dailyLimit,
    monthlyLimit: row.monthlyLimit,
    quotaUnit: row.quotaUnit,
    todayUsed: row.todayUsed,
    monthUsed: row.monthUsed,
    proxyConfigured: row.encryptedProxyUrl !== null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapModel(row: ModelRow, provider: ProviderRow): Model {
  return {
    id: row.id,
    providerId: row.providerId,
    provider: provider.type,
    providerName: provider.name,
    remoteId: row.remoteId,
    displayName: row.displayName,
    capabilities: JSON.parse(row.capabilitiesJson) as Model['capabilities'],
    contextWindow: row.contextWindow,
    inputPricePerMillion: row.inputPricePerMillion,
    outputPricePerMillion: row.outputPricePerMillion,
    configuredEnabled: row.enabled,
    enabled: row.enabled && provider.enabled && !row.stale,
    stale: row.stale,
    discoveredAt: row.discoveredAt.toISOString(),
    metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
  };
}

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    parentConversationId: row.parentConversationId,
    branchedFromMessageId: row.branchedFromMessageId,
    forkKind: row.forkKind,
    originMessageId: row.originMessageId,
    title: row.title,
    pinned: row.pinned,
    archived: row.archived,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    parentMessageId: row.parentMessageId,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    reasoningDurationMs: row.reasoningDurationMs,
    toolCalls: JSON.parse(row.toolCallsJson) as ConversationMessage['toolCalls'],
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    feedback: row.feedback,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapUsage(row: UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    userId: row.userId,
    projectId: row.projectId,
    conversationId: row.conversationId,
    providerId: row.providerId,
    apiKeyId: row.apiKeyId,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    cachedTokens: row.cachedTokens,
    estimatedCostUsd: row.estimatedCostMicros / 1_000_000,
    durationMs: row.durationMs,
    cacheHit: row.cacheHit,
    successful: row.successful,
    errorCode: row.errorCode,
  };
}
