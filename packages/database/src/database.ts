import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { migrateDatabase } from './migration.js';
import * as schema from './schema.js';

export interface DatabaseContext {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export interface OpenDatabaseOptions {
  url: string;
  migrate?: boolean;
  readonly?: boolean;
}

/** 打开 SQLite，并启用外键、WAL 与合理的锁等待策略。 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseContext {
  const filename =
    options.url === ':memory:' ? ':memory:' : resolve(options.url.replace(/^file:/, ''));
  if (filename !== ':memory:' && options.readonly !== true)
    mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
    timeout: 5_000,
  });
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (filename !== ':memory:' && options.readonly !== true) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }
  if (options.migrate !== false && options.readonly !== true) migrateDatabase(sqlite);
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}
