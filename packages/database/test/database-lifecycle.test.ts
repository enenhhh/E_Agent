import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATABASE_SCHEMA_VERSION, migrateDatabase, openDatabase } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'e-agent-database-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'e-agent.db');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('database lifecycle and migrations', () => {
  it('creates parent directories and configures a writable file database', async () => {
    const databasePath = await temporaryDatabasePath();
    const context = openDatabase({ url: `file:${databasePath}` });
    try {
      expect(context.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(context.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(
        context.sqlite.prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations').get(),
      ).toEqual({ count: DATABASE_SCHEMA_VERSION });
      expect(
        context.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='revoked_tokens'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        context.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('providers') WHERE name = 'enabled_model_ids_json'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        context.sqlite
          .prepare("SELECT COUNT(*) AS count FROM pragma_table_info('models') WHERE name = 'stale'")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      context.close();
    }
  });

  it('opens an existing database in read-only mode without mutating it', async () => {
    const databasePath = await temporaryDatabasePath();
    const writable = openDatabase({ url: databasePath });
    writable.close();

    const readonly = openDatabase({ url: databasePath, readonly: true });
    try {
      expect(
        readonly.sqlite.prepare('SELECT MAX(version) AS version FROM _e_agent_migrations').get(),
      ).toEqual({ version: DATABASE_SCHEMA_VERSION });
      expect(() =>
        readonly.sqlite
          .prepare('INSERT INTO settings(scope,value_json,updated_at) VALUES(?,?,?)')
          .run('scope', '{}', Date.now()),
      ).toThrow();
    } finally {
      readonly.close();
    }
  });

  it('can explicitly skip migrations', () => {
    const context = openDatabase({ url: ':memory:', migrate: false });
    try {
      expect(() => context.sqlite.prepare('SELECT * FROM users').all()).toThrow();
    } finally {
      context.close();
    }
  });

  it('applies migrations idempotently and handles an already-present active column', () => {
    const sqlite = new Database(':memory:');
    try {
      migrateDatabase(sqlite);
      migrateDatabase(sqlite);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations').get()).toEqual({
        count: DATABASE_SCHEMA_VERSION,
      });

      sqlite.prepare('DELETE FROM _e_agent_migrations WHERE version = 4').run();
      migrateDatabase(sqlite);
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM pragma_table_info('users') WHERE name = 'active'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations WHERE version = 4').get(),
      ).toEqual({ count: 1 });
      sqlite.prepare('DELETE FROM _e_agent_migrations WHERE version = 6').run();
      migrateDatabase(sqlite);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('messages') WHERE name = 'reasoning_duration_ms'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations WHERE version = 6').get(),
      ).toEqual({ count: 1 });
      sqlite.prepare('DELETE FROM _e_agent_migrations WHERE version = 10').run();
      migrateDatabase(sqlite);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('conversations') WHERE name = 'auto_title_pending'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations WHERE version = 10')
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('migrates a populated v6 database to the latest schema without losing data', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE _e_agent_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          user_id TEXT,
          parent_conversation_id TEXT,
          branched_from_message_id TEXT,
          title TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          parent_message_id TEXT,
          sequence INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          reasoning TEXT,
          reasoning_duration_ms INTEGER,
          tool_calls_json TEXT NOT NULL DEFAULT '[]',
          model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      const insertMigration = sqlite.prepare(
        'INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)',
      );
      for (let version = 1; version <= 6; version += 1) {
        insertMigration.run(version, Date.now());
      }
      sqlite
        .prepare(
          `INSERT INTO conversations(
            id, title, pinned, archived, message_count, created_at, updated_at
          ) VALUES (?, ?, 0, 0, 1, ?, ?)`,
        )
        .run('conversation-v6', 'Legacy conversation', 1, 1);
      sqlite
        .prepare(
          `INSERT INTO messages(
            id, conversation_id, sequence, role, content, reasoning_duration_ms, created_at
          ) VALUES (?, ?, 1, 'assistant', ?, ?, ?)`,
        )
        .run('message-v6', 'conversation-v6', 'Legacy answer', 750, 1);

      migrateDatabase(sqlite);
      migrateDatabase(sqlite);

      expect(
        sqlite.prepare('SELECT MAX(version) AS version FROM _e_agent_migrations').get(),
      ).toEqual({ version: DATABASE_SCHEMA_VERSION });
      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_operations'",
          )
          .get(),
      ).toEqual({ name: 'mutation_operations' });
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('conversations') WHERE name IN (?, ?)")
          .all('fork_kind', 'origin_message_id'),
      ).toEqual([{ name: 'fork_kind' }, { name: 'origin_message_id' }]);
      expect(
        sqlite
          .prepare("SELECT name FROM pragma_table_info('messages') WHERE name = 'feedback'")
          .get(),
      ).toEqual({ name: 'feedback' });
      expect(
        sqlite
          .prepare(
            'SELECT title, fork_kind, origin_message_id, auto_title_pending FROM conversations WHERE id = ?',
          )
          .get('conversation-v6'),
      ).toEqual({
        title: 'Legacy conversation',
        fork_kind: null,
        origin_message_id: null,
        auto_title_pending: 0,
      });
      expect(
        sqlite
          .prepare('SELECT content, reasoning_duration_ms, feedback FROM messages WHERE id = ?')
          .get('message-v6'),
      ).toEqual({
        content: 'Legacy answer',
        reasoning_duration_ms: 750,
        feedback: null,
      });

      sqlite
        .prepare('UPDATE conversations SET fork_kind = ?, origin_message_id = ? WHERE id = ?')
        .run('retry', 'message-v6', 'conversation-v6');
      sqlite.prepare('UPDATE messages SET feedback = ? WHERE id = ?').run('helpful', 'message-v6');
      expect(() =>
        sqlite
          .prepare("UPDATE conversations SET fork_kind = 'invalid' WHERE id = ?")
          .run('conversation-v6'),
      ).toThrow();
      expect(() =>
        sqlite.prepare("UPDATE messages SET feedback = 'invalid' WHERE id = ?").run('message-v6'),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it('将 v8 服务商和模型缓存迁移为可配置选择与 stale 状态', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE _e_agent_migrations(
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE providers(
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          key_strategy TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE models(
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          remote_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          context_window INTEGER,
          input_price_per_million REAL,
          output_price_per_million REAL,
          enabled INTEGER NOT NULL,
          discovered_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const insertMigration = sqlite.prepare(
        'INSERT INTO _e_agent_migrations(version, applied_at) VALUES (?, ?)',
      );
      for (let version = 1; version <= 8; version += 1) {
        insertMigration.run(version, Date.now());
      }
      sqlite
        .prepare(
          `INSERT INTO providers(
            id,type,name,base_url,key_strategy,enabled,created_at,updated_at
          ) VALUES('provider','custom','Legacy','https://example.test/v1','round-robin',1,1,1)`,
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO models(
            id,provider_id,remote_id,display_name,capabilities_json,enabled,
            discovered_at,metadata_json,created_at,updated_at
          ) VALUES('model','provider','legacy','Legacy','["chat"]',1,1,'{}',1,1)`,
        )
        .run();

      migrateDatabase(sqlite);
      migrateDatabase(sqlite);

      expect(
        sqlite.prepare('SELECT enabled_model_ids_json FROM providers WHERE id = ?').get('provider'),
      ).toEqual({ enabled_model_ids_json: null });
      expect(sqlite.prepare('SELECT enabled, stale FROM models WHERE id = ?').get('model')).toEqual(
        {
          enabled: 1,
          stale: 0,
        },
      );
    } finally {
      sqlite.close();
    }
  });

  it('rolls back a failed migration transaction', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(
        'CREATE TABLE _e_agent_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
      );
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES(1, ?)')
        .run(Date.now());
      sqlite
        .prepare('INSERT INTO _e_agent_migrations(version, applied_at) VALUES(2, ?)')
        .run(Date.now());
      sqlite.exec(
        'CREATE TABLE file_changes(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, path TEXT NOT NULL, diff TEXT NOT NULL, status TEXT NOT NULL, accepted_lines_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);',
      );

      expect(() => migrateDatabase(sqlite)).toThrow();
      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM _e_agent_migrations WHERE version = 3').get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});
