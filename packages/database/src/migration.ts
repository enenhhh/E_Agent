import type Database from 'better-sqlite3';

export const DATABASE_SCHEMA_VERSION = 10;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _e_agent_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL,
  workspace_path TEXT, memory_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
  key_strategy TEXT NOT NULL DEFAULT 'round-robin', enabled INTEGER NOT NULL DEFAULT 1,
  enabled_model_ids_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS providers_name_unique ON providers(name);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL, encrypted_secret TEXT NOT NULL, masked_key TEXT NOT NULL, encrypted_proxy_url TEXT,
  priority INTEGER NOT NULL DEFAULT 100, health TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1, paused_reason TEXT, daily_limit REAL, monthly_limit REAL,
  quota_unit TEXT NOT NULL DEFAULT 'usd', today_used REAL NOT NULL DEFAULT 0,
  month_used REAL NOT NULL DEFAULT 0, usage_day TEXT, usage_month TEXT,
  last_checked_at INTEGER, last_error TEXT, last_selected_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_provider_idx ON api_keys(provider_id);
CREATE INDEX IF NOT EXISTS api_keys_selection_idx ON api_keys(provider_id,enabled,health,priority);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL, display_name TEXT NOT NULL, capabilities_json TEXT NOT NULL,
  context_window INTEGER, input_price_per_million REAL, output_price_per_million REAL,
  enabled INTEGER NOT NULL DEFAULT 1, discovered_at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS models_provider_remote_unique ON models(provider_id,remote_id);
CREATE INDEX IF NOT EXISTS models_provider_idx ON models(provider_id);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, parent_conversation_id TEXT,
  branched_from_message_id TEXT,
  fork_kind TEXT CHECK(fork_kind IS NULL OR fork_kind IN ('branch','retry','edit')),
  origin_message_id TEXT,
  title TEXT NOT NULL, auto_title_pending INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id,updated_at);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id,updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_message_id TEXT, sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  reasoning TEXT, reasoning_duration_ms INTEGER, tool_calls_json TEXT NOT NULL DEFAULT '[]', model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  feedback TEXT CHECK(feedback IS NULL OR feedback IN ('helpful','unhelpful')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_sequence_unique ON messages(conversation_id,sequence);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE RESTRICT, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL, cache_hit INTEGER NOT NULL DEFAULT 0,
  successful INTEGER NOT NULL DEFAULT 1, error_code TEXT
);
CREATE INDEX IF NOT EXISTS usage_occurred_idx ON usage_records(occurred_at);
CREATE INDEX IF NOT EXISTS usage_model_idx ON usage_records(model,occurred_at);
CREATE INDEX IF NOT EXISTS usage_key_idx ON usage_records(api_key_id,occurred_at);
CREATE INDEX IF NOT EXISTS usage_project_idx ON usage_records(project_id,occurred_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL, content TEXT NOT NULL, token_estimate INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id,active);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_count INTEGER NOT NULL, state_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_conversation_idx ON snapshots(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS settings (
  scope TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at);
CREATE TABLE IF NOT EXISTS response_cache (
  cache_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS response_cache_expiry_idx ON response_cache(expires_at);
CREATE TABLE IF NOT EXISTS mutation_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mutation_operations_actor_operation_unique
  ON mutation_operations(actor_id,operation_id);
CREATE INDEX IF NOT EXISTS mutation_operations_created_idx ON mutation_operations(created_at);
`;

const FILE_CHANGES_SQL = `
CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS file_changes_conversation_idx ON file_changes(conversation_id,created_at);
`;

const FILE_CHANGE_LINES_SQL = `
ALTER TABLE file_changes ADD COLUMN accepted_lines_json TEXT;
`;

const ACTIVE_USERS_SQL = `
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
`;

const REVOKED_TOKENS_SQL = `
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revoked_tokens_expiry_idx ON revoked_tokens(expires_at);
`;

const MESSAGE_REASONING_DURATION_SQL = `
ALTER TABLE messages ADD COLUMN reasoning_duration_ms INTEGER;
`;

const MUTATION_OPERATIONS_SQL = `
CREATE TABLE IF NOT EXISTS mutation_operations (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mutation_operations_actor_operation_unique
  ON mutation_operations(actor_id,operation_id);
CREATE INDEX IF NOT EXISTS mutation_operations_created_idx ON mutation_operations(created_at);
`;

const PROVIDER_MODEL_SELECTION_SQL = `
ALTER TABLE providers ADD COLUMN enabled_model_ids_json TEXT;
`;

const MODEL_STALE_SQL = `
ALTER TABLE models ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
`;

const AUTO_TITLE_PENDING_SQL = `
ALTER TABLE conversations ADD COLUMN auto_title_pending INTEGER NOT NULL DEFAULT 0;
`;

/** 在一个事务内执行幂等迁移。 */
export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS _e_agent_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const hasVersion = (version: number): boolean =>
    sqlite.prepare('SELECT 1 FROM _e_agent_migrations WHERE version = ?').get(version) !==
    undefined;
  if (!hasVersion(1)) {
    sqlite.transaction(() => {
      sqlite.exec(INITIAL_SCHEMA_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(1, Date.now());
    })();
  }
  if (!hasVersion(2)) {
    sqlite.transaction(() => {
      sqlite.exec(FILE_CHANGES_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(2, Date.now());
    })();
  }
  if (!hasVersion(3)) {
    sqlite.transaction(() => {
      sqlite.exec(FILE_CHANGE_LINES_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(3, Date.now());
    })();
  }
  if (!hasVersion(4)) {
    sqlite.transaction(() => {
      const hasActiveColumn =
        sqlite.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'active'").get() !==
        undefined;
      if (!hasActiveColumn) sqlite.exec(ACTIVE_USERS_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(4, Date.now());
    })();
  }
  if (!hasVersion(5)) {
    sqlite.transaction(() => {
      sqlite.exec(REVOKED_TOKENS_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(5, Date.now());
    })();
  }
  if (!hasVersion(6)) {
    sqlite.transaction(() => {
      const hasReasoningDurationColumn =
        sqlite
          .prepare(
            "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'reasoning_duration_ms'",
          )
          .get() !== undefined;
      if (!hasReasoningDurationColumn) sqlite.exec(MESSAGE_REASONING_DURATION_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(6, Date.now());
    })();
  }
  if (!hasVersion(7)) {
    sqlite.transaction(() => {
      const conversationColumns = sqlite
        .prepare("SELECT name FROM pragma_table_info('conversations')")
        .all() as Array<{ name: string }>;
      const messageColumns = sqlite
        .prepare("SELECT name FROM pragma_table_info('messages')")
        .all() as Array<{ name: string }>;
      const conversationColumnNames = new Set(conversationColumns.map((column) => column.name));
      const messageColumnNames = new Set(messageColumns.map((column) => column.name));
      if (!conversationColumnNames.has('fork_kind')) {
        sqlite.exec(
          "ALTER TABLE conversations ADD COLUMN fork_kind TEXT CHECK(fork_kind IS NULL OR fork_kind IN ('branch','retry','edit'))",
        );
      }
      if (!conversationColumnNames.has('origin_message_id')) {
        sqlite.exec('ALTER TABLE conversations ADD COLUMN origin_message_id TEXT');
      }
      if (!messageColumnNames.has('feedback')) {
        sqlite.exec(
          "ALTER TABLE messages ADD COLUMN feedback TEXT CHECK(feedback IS NULL OR feedback IN ('helpful','unhelpful'))",
        );
      }
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(7, Date.now());
    })();
  }
  if (!hasVersion(8)) {
    sqlite.transaction(() => {
      sqlite.exec(MUTATION_OPERATIONS_SQL);
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(8, Date.now());
    })();
  }
  if (!hasVersion(9)) {
    sqlite.transaction(() => {
      const hasProvidersTable =
        sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'providers'")
          .get() !== undefined;
      const hasModelSelectionColumn =
        hasProvidersTable &&
        sqlite
          .prepare(
            "SELECT 1 FROM pragma_table_info('providers') WHERE name = 'enabled_model_ids_json'",
          )
          .get() !== undefined;
      if (hasProvidersTable && !hasModelSelectionColumn) {
        sqlite.exec(PROVIDER_MODEL_SELECTION_SQL);
      }
      const hasModelsTable =
        sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'models'")
          .get() !== undefined;
      const hasStaleColumn =
        hasModelsTable &&
        sqlite.prepare("SELECT 1 FROM pragma_table_info('models') WHERE name = 'stale'").get() !==
          undefined;
      if (hasModelsTable && !hasStaleColumn) {
        sqlite.exec(MODEL_STALE_SQL);
      }
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(9, Date.now());
    })();
  }
  if (!hasVersion(10)) {
    sqlite.transaction(() => {
      const hasConversationsTable =
        sqlite
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
          .get() !== undefined;
      const hasAutoTitlePendingColumn =
        hasConversationsTable &&
        sqlite
          .prepare(
            "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'auto_title_pending'",
          )
          .get() !== undefined;
      if (hasConversationsTable && !hasAutoTitlePendingColumn) {
        sqlite.exec(AUTO_TITLE_PENDING_SQL);
      }
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)')
        .run(10, Date.now());
    })();
  }
}
