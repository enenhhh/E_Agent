import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/schema.js';

describe('database schema metadata', () => {
  it('materializes indexes and foreign-key declarations for every table', () => {
    const tables = [
      schema.users,
      schema.projects,
      schema.providers,
      schema.apiKeys,
      schema.models,
      schema.conversations,
      schema.messages,
      schema.usageRecords,
      schema.memories,
      schema.snapshots,
      schema.fileChanges,
      schema.settings,
      schema.auditLogs,
      schema.responseCache,
    ];

    const configs = tables.map((table) => getTableConfig(table));

    expect(configs.map((config) => config.name)).toEqual([
      'users',
      'projects',
      'providers',
      'api_keys',
      'models',
      'conversations',
      'messages',
      'usage_records',
      'memories',
      'snapshots',
      'file_changes',
      'settings',
      'audit_logs',
      'response_cache',
    ]);
    expect(configs.reduce((total, config) => total + config.indexes.length, 0)).toBeGreaterThan(10);
    expect(configs.reduce((total, config) => total + config.foreignKeys.length, 0)).toBeGreaterThan(
      5,
    );
  });
});
