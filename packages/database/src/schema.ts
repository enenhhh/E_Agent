import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
};

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    workspacePath: text('workspace_path'),
    memoryEnabled: integer('memory_enabled', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [index('projects_owner_idx').on(table.ownerId)],
);

export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: ['openai', 'anthropic', 'deepseek', 'groq', 'google', 'ollama', 'custom'],
    }).notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    keyStrategy: text('key_strategy', { enum: ['round-robin', 'priority'] })
      .notNull()
      .default('round-robin'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    enabledModelIdsJson: text('enabled_model_ids_json'),
    ...timestamps,
  },
  (table) => [uniqueIndex('providers_name_unique').on(table.name)],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    maskedKey: text('masked_key').notNull(),
    encryptedProxyUrl: text('encrypted_proxy_url'),
    priority: integer('priority').notNull().default(100),
    health: text('health', {
      enum: ['unknown', 'healthy', 'warning', 'unhealthy', 'paused'],
    })
      .notNull()
      .default('unknown'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    pausedReason: text('paused_reason'),
    dailyLimit: real('daily_limit'),
    monthlyLimit: real('monthly_limit'),
    quotaUnit: text('quota_unit', { enum: ['usd', 'tokens'] })
      .notNull()
      .default('usd'),
    todayUsed: real('today_used').notNull().default(0),
    monthUsed: real('month_used').notNull().default(0),
    usageDay: text('usage_day'),
    usageMonth: text('usage_month'),
    lastCheckedAt: integer('last_checked_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    lastSelectedAt: integer('last_selected_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (table) => [
    index('api_keys_provider_idx').on(table.providerId),
    index('api_keys_selection_idx').on(
      table.providerId,
      table.enabled,
      table.health,
      table.priority,
    ),
  ],
);

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    remoteId: text('remote_id').notNull(),
    displayName: text('display_name').notNull(),
    capabilitiesJson: text('capabilities_json').notNull(),
    contextWindow: integer('context_window'),
    inputPricePerMillion: real('input_price_per_million'),
    outputPricePerMillion: real('output_price_per_million'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
    discoveredAt: integer('discovered_at', { mode: 'timestamp_ms' }).notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('models_provider_remote_unique').on(table.providerId, table.remoteId),
    index('models_provider_idx').on(table.providerId),
  ],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    parentConversationId: text('parent_conversation_id'),
    branchedFromMessageId: text('branched_from_message_id'),
    forkKind: text('fork_kind', { enum: ['branch', 'retry', 'edit'] }),
    originMessageId: text('origin_message_id'),
    title: text('title').notNull(),
    autoTitlePending: integer('auto_title_pending', { mode: 'boolean' }).notNull().default(false),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    messageCount: integer('message_count').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('conversations_project_idx').on(table.projectId, table.updatedAt),
    index('conversations_user_idx').on(table.userId, table.updatedAt),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    parentMessageId: text('parent_message_id'),
    sequence: integer('sequence').notNull(),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    reasoning: text('reasoning'),
    reasoningDurationMs: integer('reasoning_duration_ms'),
    toolCallsJson: text('tool_calls_json').notNull().default('[]'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    feedback: text('feedback', { enum: ['helpful', 'unhelpful'] }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('messages_conversation_sequence_unique').on(table.conversationId, table.sequence),
    index('messages_conversation_idx').on(table.conversationId, table.createdAt),
  ],
);

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'restrict' }),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    cacheHit: integer('cache_hit', { mode: 'boolean' }).notNull().default(false),
    successful: integer('successful', { mode: 'boolean' }).notNull().default(true),
    errorCode: text('error_code'),
  },
  (table) => [
    index('usage_occurred_idx').on(table.occurredAt),
    index('usage_model_idx').on(table.model, table.occurredAt),
    index('usage_key_idx').on(table.apiKeyId, table.occurredAt),
    index('usage_project_idx').on(table.projectId, table.occurredAt),
  ],
);

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    content: text('content').notNull(),
    tokenEstimate: integer('token_estimate').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps,
  },
  (table) => [index('memories_project_idx').on(table.projectId, table.active)],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageCount: integer('message_count').notNull(),
    stateJson: text('state_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('snapshots_conversation_idx').on(table.conversationId, table.createdAt)],
);

export const fileChanges = sqliteTable(
  'file_changes',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    diff: text('diff').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    acceptedLinesJson: text('accepted_lines_json'),
    ...timestamps,
  },
  (table) => [index('file_changes_conversation_idx').on(table.conversationId, table.createdAt)],
);

export const settings = sqliteTable('settings', {
  scope: text('scope').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    ipAddress: text('ip_address'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('audit_created_idx').on(table.createdAt)],
);

export const responseCache = sqliteTable(
  'response_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    responseJson: text('response_json').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('response_cache_expiry_idx').on(table.expiresAt)],
);

/**
 * 已提交业务写操作的持久化结果。
 *
 * actorId + operationId 唯一，确保响应丢失后的重放返回同一结果；
 * requestFingerprint 防止同一个幂等键被误用于不同请求。
 */
export const mutationOperations = sqliteTable(
  'mutation_operations',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    operationId: text('operation_id').notNull(),
    operationType: text('operation_type').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('mutation_operations_actor_operation_unique').on(table.actorId, table.operationId),
    index('mutation_operations_created_idx').on(table.createdAt),
  ],
);

export const revokedTokens = sqliteTable(
  'revoked_tokens',
  {
    jti: text('jti').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('revoked_tokens_expiry_idx').on(table.expiresAt)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProviderRow = typeof providers.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type FileChangeRow = typeof fileChanges.$inferSelect;
export type MutationOperationRow = typeof mutationOperations.$inferSelect;
export type RevokedTokenRow = typeof revokedTokens.$inferSelect;
