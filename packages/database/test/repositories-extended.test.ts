import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  openDatabase,
  projects,
  type ApiKeyRow,
  type DatabaseContext,
  type ProviderRow,
  type Repositories,
} from '../src/index.js';
import * as schema from '../src/schema.js';

describe('database repositories', () => {
  let context: DatabaseContext;
  let repositories: Repositories;

  beforeEach(() => {
    context = openDatabase({ url: ':memory:' });
    repositories = createRepositories(context.db);
  });

  afterEach(() => {
    if (context.sqlite.open) context.close();
  });

  function createUser(email = 'user@example.com') {
    return repositories.users.create({
      email,
      displayName: ' User ',
      passwordHash: 'hash',
      role: 'member',
    });
  }

  function createProvider(name = 'Provider'): ProviderRow {
    return repositories.providers.create({
      type: 'custom',
      name,
      baseUrl: 'https://provider.example/v1',
      keyStrategy: 'round-robin',
    });
  }

  function createApiKey(providerId: string, quotaUnit: 'tokens' | 'usd' = 'usd'): ApiKeyRow {
    return repositories.apiKeys.create({
      providerId,
      label: `${quotaUnit} key`,
      encryptedSecret: 'encrypted',
      maskedKey: 'masked',
      encryptedProxyUrl: null,
      priority: quotaUnit === 'usd' ? 10 : 20,
      dailyLimit: 100,
      monthlyLimit: 1_000,
      quotaUnit,
    });
  }

  function createProject(ownerId: string | null = null): string {
    const timestamp = new Date();
    const id = crypto.randomUUID();
    context.db
      .insert(projects)
      .values({
        id,
        ownerId,
        name: 'Project',
        workspacePath: '/workspace',
        memoryEnabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return id;
  }

  it('supports complete user and provider CRUD with uniqueness errors', () => {
    expect(repositories.users.count()).toBe(0);
    const user = createUser(' Trimmed@Example.com ');
    expect(user).toMatchObject({
      email: 'trimmed@example.com',
      displayName: 'User',
      active: true,
    });
    expect(repositories.users.count()).toBe(1);
    expect(repositories.users.findById(user.id)?.id).toBe(user.id);
    expect(repositories.users.findByEmail(' TRIMMED@example.com ')?.id).toBe(user.id);
    expect(repositories.users.update(user.id, { role: 'admin', active: false })).toMatchObject({
      role: 'admin',
      active: false,
    });
    expect(repositories.users.update('missing', { role: 'viewer' })).toBeUndefined();
    expect(() => createUser('trimmed@example.com')).toThrow();

    const first = createProvider('Zulu');
    const second = createProvider('Alpha');
    expect(repositories.providers.list().map((provider) => provider.name)).toEqual([
      'Alpha',
      'Zulu',
    ]);
    expect(repositories.providers.get(first.id)?.id).toBe(first.id);
    expect(repositories.providers.get('missing')).toBeUndefined();
    expect(
      repositories.providers.update(first.id, {
        enabled: false,
        keyStrategy: 'priority',
        name: 'Disabled',
      }),
    ).toMatchObject({ enabled: false, keyStrategy: 'priority' });
    expect(repositories.providers.update('missing', { enabled: false })).toBeUndefined();
    expect(repositories.providers.list(true).map((provider) => provider.id)).toEqual([second.id]);

    expect(repositories.users.delete(user.id)).toBe(true);
    expect(repositories.users.delete(user.id)).toBe(false);
  });

  it('rolls back a failed explicit transaction', () => {
    expect(() =>
      context.sqlite.transaction(() => {
        createUser('rolled-back@example.com');
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(repositories.users.findByEmail('rolled-back@example.com')).toBeUndefined();
  });

  it('manages API keys, updates and period-aware usage in dollars and tokens', () => {
    const provider = createProvider();
    const usdKey = createApiKey(provider.id);
    const tokenKey = createApiKey(provider.id, 'tokens');
    expect(repositories.apiKeys.list().map((key) => key.id)).toEqual([usdKey.id, tokenKey.id]);
    expect(repositories.apiKeys.list(provider.id)).toHaveLength(2);
    expect(repositories.apiKeys.get(usdKey.id)?.id).toBe(usdKey.id);
    expect(repositories.apiKeys.get('missing')).toBeUndefined();

    expect(
      repositories.apiKeys.update(usdKey.id, {
        health: 'healthy',
        label: 'updated',
        pausedReason: null,
      }),
    ).toMatchObject({ health: 'healthy', label: 'updated' });
    expect(repositories.apiKeys.update('missing', { enabled: false })).toBeUndefined();
    expect(repositories.apiKeys.addUsage('missing', 1, 1)).toBeUndefined();

    expect(
      repositories.apiKeys.addUsage(usdKey.id, 1.5, 100, new Date('2026-01-01T12:00:00Z')),
    ).toMatchObject({ todayUsed: 1.5, monthUsed: 1.5 });
    expect(
      repositories.apiKeys.addUsage(usdKey.id, 2, 200, new Date('2026-01-01T13:00:00Z')),
    ).toMatchObject({ todayUsed: 3.5, monthUsed: 3.5 });
    expect(
      repositories.apiKeys.addUsage(usdKey.id, 4, 400, new Date('2026-01-02T12:00:00Z')),
    ).toMatchObject({ todayUsed: 4, monthUsed: 7.5 });
    expect(
      repositories.apiKeys.addUsage(usdKey.id, 5, 500, new Date('2026-02-01T12:00:00Z')),
    ).toMatchObject({ todayUsed: 5, monthUsed: 5 });
    expect(
      repositories.apiKeys.addUsage(tokenKey.id, 99, 250, new Date('2026-01-01T12:00:00Z')),
    ).toMatchObject({ todayUsed: 250, monthUsed: 250 });

    expect(repositories.apiKeys.delete(usdKey.id)).toBe(true);
    expect(repositories.apiKeys.delete(usdKey.id)).toBe(false);
  });

  it('upserts, locates and filters discovered models', () => {
    const provider = createProvider();
    const discoveredAt = new Date('2026-01-01T00:00:00Z');
    const model = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'remote-model',
      displayName: 'Zulu model',
      capabilitiesJson: '["chat"]',
      contextWindow: 8_192,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
      discoveredAt,
    });
    const second = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'second',
      displayName: 'Alpha model',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: 1,
      outputPricePerMillion: 2,
      metadataJson: '{"source":"test"}',
    });
    const updated = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'remote-model',
      displayName: 'Updated model',
      capabilitiesJson: '["chat","code"]',
      contextWindow: 16_384,
      inputPricePerMillion: 3,
      outputPricePerMillion: 4,
      metadataJson: '{"updated":true}',
    });

    expect(updated.id).toBe(model.id);
    expect(repositories.models.get(model.id)?.displayName).toBe('Updated model');
    expect(repositories.models.get('missing')).toBeUndefined();
    expect(repositories.models.findByRemoteId(provider.id, 'remote-model')?.id).toBe(model.id);
    expect(repositories.models.findByRemoteId(provider.id, 'missing')).toBeUndefined();
    expect(repositories.models.list().map((entry) => entry.id)).toEqual([second.id, model.id]);
    expect(repositories.models.list(provider.id)).toHaveLength(2);

    context.db
      .update(schema.models)
      .set({ enabled: false })
      .where(eq(schema.models.id, second.id))
      .run();
    expect(repositories.models.list(provider.id, true).map((entry) => entry.id)).toEqual([
      model.id,
    ]);
  });

  it('原子保存服务商启用模型集合，并在发现变化时保留用户偏好', () => {
    const provider = createProvider();
    const selected = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'selected',
      displayName: 'Selected',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });
    const disabled = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'disabled',
      displayName: 'Disabled',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });

    expect(repositories.models.setEnabledSelection(provider.id, [selected.id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: selected.id, enabled: true }),
        expect.objectContaining({ id: disabled.id, enabled: false }),
      ]),
    );
    expect(repositories.providers.get(provider.id)?.enabledModelIdsJson).toBe(
      JSON.stringify([selected.id]),
    );

    const newlyDiscovered = repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'new',
      displayName: 'New',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });
    expect(newlyDiscovered.enabled).toBe(false);

    repositories.models.reconcileDiscovery(provider.id, ['disabled', 'new']);
    expect(repositories.models.get(selected.id)).toMatchObject({ enabled: true, stale: true });
    expect(repositories.models.get(disabled.id)).toMatchObject({ enabled: false, stale: false });
    repositories.models.upsert({
      providerId: provider.id,
      remoteId: 'selected',
      displayName: 'Selected again',
      capabilitiesJson: '["chat"]',
      contextWindow: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      metadataJson: '{}',
    });
    expect(repositories.models.get(selected.id)).toMatchObject({ enabled: true, stale: false });

    repositories.models.markProviderStale(provider.id);
    expect(repositories.models.list(provider.id).every((model) => model.stale)).toBe(true);
  });

  it('filters and paginates conversations and handles missing message boundaries', () => {
    const user = createUser();
    const projectId = createProject(user.id);
    const first = repositories.conversations.create({
      projectId,
      userId: user.id,
      title: 'Searchable first',
    });
    const second = repositories.conversations.create({
      projectId,
      userId: user.id,
      title: 'Searchable second',
    });
    repositories.conversations.update(first.id, { pinned: true });
    repositories.conversations.update(second.id, { archived: true });

    expect(repositories.conversations.get(first.id)?.id).toBe(first.id);
    expect(repositories.conversations.get('missing')).toBeUndefined();
    expect(repositories.conversations.list({ projectId })).toHaveLength(2);
    expect(repositories.conversations.list({ userId: user.id })).toHaveLength(2);
    expect(repositories.conversations.list({ archived: true }).map((row) => row.id)).toEqual([
      second.id,
    ]);
    expect(repositories.conversations.list({ search: ' first ' }).map((row) => row.id)).toEqual([
      first.id,
    ]);
    expect(repositories.conversations.list({ search: '   ' })).toHaveLength(2);
    expect(repositories.conversations.list({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(repositories.conversations.update('missing', { title: 'none' })).toBeUndefined();

    const message = repositories.conversations.addMessage({
      id: 'message-1',
      conversationId: first.id,
      parentMessageId: null,
      role: 'assistant',
      content: 'answer',
      reasoning: 'reason',
      reasoningDurationMs: 1_250,
      toolCallsJson: '[{"id":"tool"}]',
      model: 'model',
      inputTokens: 2,
      outputTokens: 3,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    repositories.conversations.addMessage({
      conversationId: first.id,
      parentMessageId: message.id,
      role: 'user',
      content: 'follow-up',
    });
    expect(repositories.conversations.listMessages(first.id)).toHaveLength(2);
    expect(repositories.conversations.listMessages(first.id)[0]?.reasoningDurationMs).toBe(1_250);
    expect(repositories.conversations.listMessages(first.id, message.id)).toHaveLength(1);
    expect(repositories.conversations.listMessages(first.id, 'missing')).toEqual([]);
    expect(() =>
      repositories.conversations.addMessage({
        conversationId: 'missing',
        role: 'user',
        content: 'no conversation',
      }),
    ).toThrow();

    expect(repositories.conversations.delete(second.id)).toBe(true);
    expect(repositories.conversations.delete(second.id)).toBe(false);
  });

  it('branches conversations, restores snapshots and transitions file changes once', () => {
    const conversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Original',
    });
    const firstMessage = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'first',
    });
    repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'second',
      reasoning: 'thinking',
      reasoningDurationMs: 900,
    });
    expect(() =>
      repositories.conversations.branch({
        conversationId: 'missing',
        fromMessageId: firstMessage.id,
        userId: null,
        title: 'Missing source',
      }),
    ).toThrow();
    expect(() =>
      repositories.conversations.branch({
        conversationId: conversation.id,
        fromMessageId: 'missing',
        userId: null,
        title: 'Missing message',
      }),
    ).toThrow();

    const branch = repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: firstMessage.id,
      userId: null,
      title: 'Branch',
    });
    expect(branch).toMatchObject({
      parentConversationId: conversation.id,
      branchedFromMessageId: firstMessage.id,
      messageCount: 1,
    });
    const otherBranchOwner = createUser('other-branch-owner@example.com');
    repositories.conversations.create({
      projectId: null,
      userId: otherBranchOwner.id,
      parentConversationId: conversation.id,
      title: 'Other owner branch',
    });
    expect(repositories.conversations.countDirectBranches(conversation.id)).toBe(2);
    expect(
      repositories.conversations.countDirectBranches(conversation.id, otherBranchOwner.id),
    ).toBe(1);
    expect(repositories.conversations.countDirectBranches(conversation.id, 'missing-user')).toBe(0);
    expect(repositories.conversations.countDirectBranches(branch.id)).toBe(0);
    expect(repositories.conversations.countDirectBranches('missing')).toBe(0);

    const snapshot = repositories.conversations.createSnapshot(branch.id);
    expect(repositories.conversations.listSnapshots(branch.id).map((row) => row.id)).toEqual([
      snapshot.id,
    ]);
    repositories.conversations.update(branch.id, { title: 'Changed', archived: true });
    repositories.conversations.addMessage({
      conversationId: branch.id,
      role: 'assistant',
      content: 'post-snapshot',
    });
    expect(repositories.conversations.restoreSnapshot(snapshot.id)).toMatchObject({
      title: 'Branch',
      archived: false,
      messageCount: 1,
    });
    expect(repositories.conversations.listMessages(branch.id)).toHaveLength(1);
    expect(() => repositories.conversations.createSnapshot('missing')).toThrow();
    expect(() => repositories.conversations.restoreSnapshot('missing')).toThrow();

    const accepted = repositories.conversations.createFileChange({
      conversationId: branch.id,
      path: 'accepted.ts',
      diff: 'diff',
    });
    const rejected = repositories.conversations.createFileChange({
      conversationId: branch.id,
      path: 'rejected.ts',
      diff: 'diff',
    });
    expect(repositories.conversations.listFileChanges(branch.id)).toHaveLength(2);
    expect(
      repositories.conversations.updateFileChange(accepted.id, branch.id, 'accepted', [1, 3]),
    ).toMatchObject({ status: 'accepted', acceptedLinesJson: '[1,3]' });
    expect(
      repositories.conversations.updateFileChange(rejected.id, branch.id, 'rejected'),
    ).toMatchObject({ status: 'rejected', acceptedLinesJson: null });
    expect(
      repositories.conversations.updateFileChange(accepted.id, branch.id, 'rejected'),
    ).toBeUndefined();
    expect(
      repositories.conversations.updateFileChange(rejected.id, 'wrong-conversation', 'accepted'),
    ).toBeUndefined();
  });

  it('persists and replays idempotent branch and message deletion results', () => {
    const actor = createUser('idempotency@example.com');
    const conversation = repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Idempotent source',
    });
    const message = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'delete after branching',
    });
    const branchMutation = {
      actorId: actor.id,
      operationId: 'repository-branch-operation',
      operationType: 'conversation.branch' as const,
      requestFingerprint: 'branch-fingerprint',
    };
    const branchInput = {
      conversationId: conversation.id,
      fromMessageId: message.id,
      userId: actor.id,
      title: 'Idempotent branch',
    };

    const firstBranch = repositories.conversations.branchIdempotent(branchInput, branchMutation);
    const replayedBranch = repositories.conversations.branchIdempotent(branchInput, branchMutation);
    expect(firstBranch.replayed).toBe(false);
    expect(replayedBranch).toMatchObject({
      replayed: true,
      conversation: { id: firstBranch.conversation.id },
    });
    expect(repositories.conversations.getBranchMutationResult(branchMutation)).toMatchObject({
      id: firstBranch.conversation.id,
    });

    const deleteMutation = {
      actorId: actor.id,
      operationId: 'repository-delete-operation',
      operationType: 'message.delete_tail' as const,
      requestFingerprint: 'delete-fingerprint',
    };
    const deleteInput = {
      conversationId: conversation.id,
      messageId: message.id,
      expectedMessageCount: 1,
      expectedTailMessageId: message.id,
    };
    const firstDelete = repositories.conversations.truncateFromMessageIdempotent(
      deleteInput,
      deleteMutation,
    );
    const replayedDelete = repositories.conversations.truncateFromMessageIdempotent(
      deleteInput,
      deleteMutation,
    );
    expect(firstDelete).toMatchObject({ replayed: false, removedCount: 1 });
    expect(replayedDelete).toMatchObject({
      replayed: true,
      removedCount: 1,
      snapshot: { id: firstDelete.snapshot.id },
    });
    expect(repositories.conversations.getDeleteMessageMutationResult(deleteMutation)).toMatchObject(
      {
        removedCount: 1,
        snapshot: { id: firstDelete.snapshot.id },
      },
    );
  });

  it('creates empty-prefix forks and preserves retry and edit metadata', () => {
    const conversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Fork source',
    });
    const prompt = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'original prompt',
    });
    const answer = repositories.conversations.addMessage({
      conversationId: conversation.id,
      parentMessageId: prompt.id,
      role: 'assistant',
      content: 'original answer',
      feedback: 'helpful',
    });

    const edit = repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: prompt.id,
      includeFromMessage: false,
      userId: null,
      title: 'Edited prompt',
      forkKind: 'edit',
      originMessageId: prompt.id,
    });
    expect(edit).toMatchObject({
      parentConversationId: conversation.id,
      branchedFromMessageId: prompt.id,
      forkKind: 'edit',
      originMessageId: prompt.id,
      messageCount: 0,
    });
    expect(repositories.conversations.listMessages(edit.id)).toEqual([]);

    const retry = repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: answer.id,
      userId: null,
      title: 'Retry answer',
      forkKind: 'retry',
      originMessageId: answer.id,
    });
    expect(retry).toMatchObject({
      parentConversationId: conversation.id,
      branchedFromMessageId: answer.id,
      forkKind: 'retry',
      originMessageId: answer.id,
      messageCount: 2,
    });
    const retryMessages = repositories.conversations.listMessages(retry.id);
    expect(retryMessages.map((message) => message.content)).toEqual([
      'original prompt',
      'original answer',
    ]);
    expect(retryMessages[0]?.id).not.toBe(prompt.id);
    expect(retryMessages[1]).toMatchObject({
      parentMessageId: retryMessages[0]?.id,
      feedback: 'helpful',
    });
  });

  it('updates, clears and validates message feedback', () => {
    const firstConversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Feedback',
    });
    const secondConversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Other feedback',
    });
    const message = repositories.conversations.addMessage({
      conversationId: firstConversation.id,
      role: 'assistant',
      content: 'answer',
    });

    expect(
      repositories.conversations.updateMessageFeedback(firstConversation.id, message.id, 'helpful'),
    ).toMatchObject({ feedback: 'helpful' });
    expect(
      repositories.conversations.updateMessageFeedback(
        firstConversation.id,
        message.id,
        'unhelpful',
      ),
    ).toMatchObject({ feedback: 'unhelpful' });
    expect(
      repositories.conversations.updateMessageFeedback(firstConversation.id, message.id, null),
    ).toMatchObject({ feedback: null });
    expect(
      repositories.conversations.updateMessageFeedback(
        secondConversation.id,
        message.id,
        'helpful',
      ),
    ).toBeUndefined();
    expect(
      repositories.conversations.updateMessageFeedback(firstConversation.id, 'missing', 'helpful'),
    ).toBeUndefined();
    expect(() =>
      context.sqlite
        .prepare("UPDATE messages SET feedback = 'invalid' WHERE id = ?")
        .run(message.id),
    ).toThrow();
  });

  it('snapshots before truncating a message tail and rejects stale message counts', () => {
    const conversation = repositories.conversations.create({
      projectId: null,
      userId: null,
      title: 'Truncate source',
    });
    const first = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'keep',
    });
    const second = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'remove',
      feedback: 'unhelpful',
    });
    const tail = repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'remove too',
    });

    expect(() =>
      repositories.conversations.truncateFromMessage({
        conversationId: conversation.id,
        messageId: second.id,
        expectedMessageCount: 2,
        expectedTailMessageId: tail.id,
      }),
    ).toThrow('会话已发生变化');
    expect(repositories.conversations.listSnapshots(conversation.id)).toEqual([]);
    expect(repositories.conversations.listMessages(conversation.id)).toHaveLength(3);

    expect(() =>
      repositories.conversations.truncateFromMessage({
        conversationId: conversation.id,
        messageId: second.id,
        expectedMessageCount: 3,
        expectedTailMessageId: second.id,
      }),
    ).toThrow('会话已发生变化');
    expect(repositories.conversations.listSnapshots(conversation.id)).toEqual([]);
    expect(repositories.conversations.listMessages(conversation.id)).toHaveLength(3);

    const result = repositories.conversations.truncateFromMessage({
      conversationId: conversation.id,
      messageId: second.id,
      expectedMessageCount: 3,
      expectedTailMessageId: tail.id,
    });
    expect(result).toMatchObject({
      conversation: { id: conversation.id, messageCount: 1 },
      snapshot: { conversationId: conversation.id, messageCount: 3 },
      removedCount: 2,
    });
    expect(repositories.conversations.listMessages(conversation.id)).toEqual([
      expect.objectContaining({ id: first.id, sequence: 1, content: 'keep' }),
    ]);
    expect(repositories.conversations.listSnapshots(conversation.id).map((row) => row.id)).toEqual([
      result.snapshot.id,
    ]);
    const snapshotState = JSON.parse(result.snapshot.stateJson) as {
      messages: Array<{ id: string; feedback: string | null }>;
    };
    expect(snapshotState.messages).toHaveLength(3);
    expect(snapshotState.messages.find((message) => message.id === second.id)?.feedback).toBe(
      'unhelpful',
    );

    expect(repositories.conversations.restoreSnapshot(result.snapshot.id)).toMatchObject({
      id: conversation.id,
      messageCount: 3,
    });
    expect(repositories.conversations.getMessage(conversation.id, second.id)).toMatchObject({
      feedback: 'unhelpful',
    });
  });

  it('records usage and applies every supported filter', () => {
    const user = createUser();
    const projectId = createProject(user.id);
    const provider = createProvider();
    const apiKey = createApiKey(provider.id);
    const conversation = repositories.conversations.create({
      projectId,
      userId: user.id,
      title: 'Usage conversation',
    });
    const first = repositories.usage.record({
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      userId: user.id,
      projectId,
      conversationId: conversation.id,
      providerId: provider.id,
      apiKeyId: apiKey.id,
      model: 'model-a',
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cachedTokens: 0,
      estimatedCostMicros: 100,
      durationMs: 10,
      cacheHit: false,
      successful: true,
      errorCode: null,
    });
    repositories.usage.record({
      id: 'usage-second',
      occurredAt: new Date('2026-02-01T00:00:00Z'),
      userId: null,
      projectId: null,
      conversationId: null,
      providerId: provider.id,
      apiKeyId: null,
      model: 'model-b',
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
      cachedTokens: 1,
      estimatedCostMicros: 200,
      durationMs: 20,
      cacheHit: true,
      successful: false,
      errorCode: 'failed',
    });

    expect(repositories.usage.list()).toHaveLength(2);
    expect(repositories.usage.list({ from: new Date('2026-01-15T00:00:00Z') })).toHaveLength(1);
    expect(repositories.usage.list({ to: new Date('2026-01-15T00:00:00Z') })[0]?.id).toBe(first.id);
    expect(repositories.usage.list({ projectId })).toHaveLength(1);
    expect(repositories.usage.list({ userId: user.id })).toHaveLength(1);
    expect(repositories.usage.list({ model: 'model-a' })).toHaveLength(1);
    expect(repositories.usage.list({ apiKeyId: apiKey.id })).toHaveLength(1);
    expect(repositories.usage.list({}, 1)).toHaveLength(1);
  });

  it('upserts project memories and hides inactive rows', () => {
    const projectId = createProject();
    const memory = repositories.memories.upsert({
      projectId,
      category: 'stack',
      content: 'TypeScript',
      tokenEstimate: 2,
    });
    expect(
      repositories.memories.upsert({
        id: memory.id,
        projectId,
        category: 'stack',
        content: 'TypeScript and SQLite',
        tokenEstimate: 4,
      }),
    ).toMatchObject({ id: memory.id, content: 'TypeScript and SQLite' });
    const specified = repositories.memories.upsert({
      id: 'specified-memory',
      projectId,
      category: 'style',
      content: 'Strict',
      tokenEstimate: 1,
    });
    expect(specified.id).toBe('specified-memory');
    expect(repositories.memories.list(projectId)).toHaveLength(2);

    context.db
      .update(schema.memories)
      .set({ active: false })
      .where(eq(schema.memories.id, memory.id))
      .run();
    expect(repositories.memories.list(projectId).map((row) => row.id)).toEqual([
      'specified-memory',
    ]);
  });

  it('upserts settings, records filtered audits and expires cache entries', () => {
    expect(repositories.settings.get('ui')).toBeUndefined();
    expect(repositories.settings.set('ui', { theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(repositories.settings.set('ui', { theme: 'light' })).toEqual({ theme: 'light' });
    expect(repositories.settings.get<{ theme: string }>('ui')).toEqual({ theme: 'light' });

    repositories.audit.record({
      actorId: null,
      action: 'create',
      targetType: 'conversation',
    });
    repositories.audit.record({
      actorId: null,
      action: 'delete',
      targetType: 'message',
      targetId: 'message-id',
      metadata: { reason: 'test' },
      ipAddress: '127.0.0.1',
    });
    expect(repositories.audit.list()).toHaveLength(2);
    expect(repositories.audit.list({ action: 'delete' })[0]).toMatchObject({
      metadata: { reason: 'test' },
    });
    expect(repositories.audit.list({ targetType: 'conversation' })).toHaveLength(1);
    expect(repositories.audit.list({ limit: 1, offset: 1 })).toHaveLength(1);

    const now = new Date('2026-01-01T00:00:00Z');
    expect(repositories.cache.get('missing', now)).toBeUndefined();
    repositories.cache.set('key', { value: 1 }, 1_000, now);
    expect(repositories.cache.get('key', now)).toEqual({ value: 1 });
    repositories.cache.set('key', { value: 2 }, 2_000, now);
    expect(repositories.cache.get('key', new Date(now.getTime() + 1_500))).toEqual({ value: 2 });
    expect(repositories.cache.get('key', new Date(now.getTime() + 2_001))).toBeUndefined();
    expect(repositories.cache.purgeExpired(new Date(now.getTime() + 2_000))).toBe(1);
    expect(repositories.cache.purgeExpired(new Date(now.getTime() + 2_000))).toBe(0);
  });
});
