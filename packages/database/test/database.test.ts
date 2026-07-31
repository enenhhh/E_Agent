import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  openDatabase,
  type DatabaseContext,
  type Repositories,
} from '../src/index.js';

describe('SQLite 仓储', () => {
  let context: DatabaseContext;
  let repositories: Repositories;

  beforeEach(() => {
    context = openDatabase({ url: ':memory:' });
    repositories = createRepositories(context.db);
  });

  afterEach(() => context.close());

  it('持久化用户、提供商和密钥元数据', () => {
    const user = repositories.users.create({
      email: 'Owner@Example.com',
      displayName: 'Owner',
      passwordHash: 'hash',
      role: 'owner',
    });
    expect(repositories.users.findByEmail('owner@example.com')?.id).toBe(user.id);
    expect(user.active).toBe(true);
    expect(repositories.users.list()).toHaveLength(1);
    expect(repositories.users.update(user.id, { displayName: 'Updated' })?.displayName).toBe(
      'Updated',
    );

    const provider = repositories.providers.create({
      type: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      keyStrategy: 'round-robin',
    });
    const key = repositories.apiKeys.create({
      providerId: provider.id,
      label: 'Primary',
      encryptedSecret: 'encrypted',
      maskedKey: 'sk-a••••••••bcde',
      encryptedProxyUrl: null,
      priority: 100,
      dailyLimit: 5,
      monthlyLimit: 50,
      quotaUnit: 'usd',
    });
    expect(repositories.apiKeys.list(provider.id)).toHaveLength(1);
    expect(repositories.apiKeys.addUsage(key.id, 1.5, 20)?.todayUsed).toBe(1.5);
  });

  it('支持停用和删除团队成员', () => {
    const member = repositories.users.create({
      email: 'member@example.com',
      displayName: 'Member',
      passwordHash: 'hash',
      role: 'member',
    });
    expect(repositories.users.update(member.id, { active: false })?.active).toBe(false);
    expect(repositories.users.delete(member.id)).toBe(true);
    expect(repositories.users.findById(member.id)).toBeUndefined();
  });

  it('持久化令牌撤销并清理过期记录', () => {
    const user = repositories.users.create({
      email: 'session-owner@example.com',
      displayName: 'Session Owner',
      passwordHash: 'hash',
      role: 'owner',
    });
    repositories.revokedTokens.revoke({
      jti: 'session-jti',
      userId: user.id,
      expiresAt: new Date('2026-01-01T01:00:00Z'),
      revokedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(repositories.revokedTokens.isRevoked('session-jti')).toBe(true);
    expect(repositories.revokedTokens.isRevoked('other-jti')).toBe(false);
    expect(repositories.revokedTokens.purgeExpired(new Date('2026-01-01T00:30:00Z'))).toBe(0);
    expect(repositories.revokedTokens.purgeExpired(new Date('2026-01-01T01:00:00Z'))).toBe(1);
    expect(repositories.revokedTokens.isRevoked('session-jti')).toBe(false);
  });

  it('创建对话、分支和快照', () => {
    const conversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Test',
    });
    const message = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
    });
    const branch = repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: message.id,
      userId: null,
      title: 'Branch',
    });
    expect(repositories.conversations.listMessages(branch.id)).toHaveLength(1);
    const snapshot = repositories.conversations.createSnapshot(branch.id);
    expect(snapshot.messageCount).toBe(1);
    const change = repositories.conversations.createFileChange({
      conversationId: branch.id,
      path: 'src/example.ts',
      diff: '@@ -1 +1 @@',
    });
    const accepted = repositories.conversations.updateFileChange(change.id, branch.id, 'accepted', [
      1,
    ]);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.acceptedLinesJson).toBe('[1]');
  });
});
