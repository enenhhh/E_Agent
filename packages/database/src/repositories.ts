import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type EAgentDatabase = BetterSQLite3Database<typeof schema>;

function now(): Date {
  return new Date();
}

export class UsersRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public count(): number {
    return (
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(schema.users)
        .get()?.count ?? 0
    );
  }

  public create(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: 'owner' | 'admin' | 'member' | 'viewer';
  }): schema.UserRow {
    const timestamp = now();
    return this.database
      .insert(schema.users)
      .values({
        id: randomUUID(),
        email: input.email.trim().toLowerCase(),
        displayName: input.displayName.trim(),
        passwordHash: input.passwordHash,
        role: input.role,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  /**
   * 以单条 SQLite 条件写入创建首个 Owner。
   *
   * `WHERE NOT EXISTS` 与 INSERT 处于同一写语句，多个并发注册者中只有一个能得到
   * `changes=1`，避免应用层的 count/create 检查竞态。
   */
  public createInitialOwner(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): schema.UserRow | undefined {
    const id = randomUUID();
    const timestamp = now();
    const result = this.database.run(sql`
      INSERT INTO users (
        id,
        email,
        display_name,
        password_hash,
        role,
        active,
        created_at,
        updated_at
      )
      SELECT
        ${id},
        ${input.email.trim().toLowerCase()},
        ${input.displayName.trim()},
        ${input.passwordHash},
        'owner',
        1,
        ${timestamp.getTime()},
        ${timestamp.getTime()}
      WHERE NOT EXISTS (SELECT 1 FROM users)
    `);
    return result.changes === 0 ? undefined : this.findById(id);
  }

  public findByEmail(email: string): schema.UserRow | undefined {
    return this.database
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email.trim().toLowerCase()))
      .get();
  }

  public findById(id: string): schema.UserRow | undefined {
    return this.database.select().from(schema.users).where(eq(schema.users.id, id)).get();
  }

  public list(): schema.UserRow[] {
    return this.database.select().from(schema.users).orderBy(asc(schema.users.createdAt)).all();
  }

  public update(
    id: string,
    input: Partial<Pick<schema.UserRow, 'displayName' | 'role' | 'active'>>,
  ): schema.UserRow | undefined {
    return this.database
      .update(schema.users)
      .set({ ...input, updatedAt: now() })
      .where(eq(schema.users.id, id))
      .returning()
      .get();
  }

  public delete(id: string): boolean {
    return this.database.delete(schema.users).where(eq(schema.users.id, id)).run().changes > 0;
  }
}

export class ProjectsRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public get(id: string): schema.ProjectRow | undefined {
    return this.database.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  }

  public create(input: {
    ownerId: string | null;
    name: string;
    workspacePath?: string | null;
    memoryEnabled?: boolean;
  }): schema.ProjectRow {
    const timestamp = now();
    return this.database
      .insert(schema.projects)
      .values({
        id: randomUUID(),
        ownerId: input.ownerId,
        name: input.name.trim(),
        workspacePath: input.workspacePath ?? null,
        memoryEnabled: input.memoryEnabled ?? true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }
}

export class ProvidersRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public list(enabledOnly = false): schema.ProviderRow[] {
    return this.database
      .select()
      .from(schema.providers)
      .where(enabledOnly ? eq(schema.providers.enabled, true) : undefined)
      .orderBy(asc(schema.providers.name))
      .all();
  }

  public get(id: string): schema.ProviderRow | undefined {
    return this.database.select().from(schema.providers).where(eq(schema.providers.id, id)).get();
  }

  public create(input: {
    type: schema.ProviderRow['type'];
    name: string;
    baseUrl: string;
    keyStrategy: schema.ProviderRow['keyStrategy'];
  }): schema.ProviderRow {
    const timestamp = now();
    return this.database
      .insert(schema.providers)
      .values({
        id: randomUUID(),
        ...input,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  public update(
    id: string,
    input: Partial<
      Pick<
        schema.ProviderRow,
        'type' | 'name' | 'baseUrl' | 'keyStrategy' | 'enabled' | 'enabledModelIdsJson'
      >
    >,
  ): schema.ProviderRow | undefined {
    return this.database
      .update(schema.providers)
      .set({ ...input, updatedAt: now() })
      .where(eq(schema.providers.id, id))
      .returning()
      .get();
  }
}

export class ApiKeysRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public list(providerId?: string): schema.ApiKeyRow[] {
    return this.database
      .select()
      .from(schema.apiKeys)
      .where(providerId === undefined ? undefined : eq(schema.apiKeys.providerId, providerId))
      .orderBy(asc(schema.apiKeys.priority), asc(schema.apiKeys.createdAt))
      .all();
  }

  public get(id: string): schema.ApiKeyRow | undefined {
    return this.database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
  }

  public create(
    input: Pick<
      schema.ApiKeyRow,
      | 'providerId'
      | 'label'
      | 'encryptedSecret'
      | 'maskedKey'
      | 'encryptedProxyUrl'
      | 'priority'
      | 'dailyLimit'
      | 'monthlyLimit'
      | 'quotaUnit'
    >,
  ): schema.ApiKeyRow {
    const timestamp = now();
    return this.database
      .insert(schema.apiKeys)
      .values({
        id: randomUUID(),
        ...input,
        health: 'unknown',
        enabled: true,
        todayUsed: 0,
        monthUsed: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  public update(
    id: string,
    input: Partial<
      Pick<
        schema.ApiKeyRow,
        | 'label'
        | 'encryptedSecret'
        | 'maskedKey'
        | 'encryptedProxyUrl'
        | 'priority'
        | 'health'
        | 'enabled'
        | 'pausedReason'
        | 'dailyLimit'
        | 'monthlyLimit'
        | 'quotaUnit'
        | 'todayUsed'
        | 'monthUsed'
        | 'usageDay'
        | 'usageMonth'
        | 'lastCheckedAt'
        | 'lastError'
        | 'lastSelectedAt'
      >
    >,
  ): schema.ApiKeyRow | undefined {
    return this.database
      .update(schema.apiKeys)
      .set({ ...input, updatedAt: now() })
      .where(eq(schema.apiKeys.id, id))
      .returning()
      .get();
  }

  public delete(id: string): boolean {
    return this.database.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id)).run().changes > 0;
  }

  public addUsage(
    id: string,
    usd: number,
    tokens: number,
    at = new Date(),
  ): schema.ApiKeyRow | undefined {
    const day = at.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const key = this.get(id);
    if (key === undefined) return undefined;
    const currentDaily = key.usageDay === day ? key.todayUsed : 0;
    const currentMonthly = key.usageMonth === month ? key.monthUsed : 0;
    const increment = key.quotaUnit === 'tokens' ? tokens : usd;
    return this.update(id, {
      todayUsed: currentDaily + increment,
      monthUsed: currentMonthly + increment,
      usageDay: day,
      usageMonth: month,
    });
  }
}

export class ModelsRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public list(providerId?: string, enabledOnly = false): schema.ModelRow[] {
    const clauses: SQL[] = [];
    if (providerId !== undefined) clauses.push(eq(schema.models.providerId, providerId));
    if (enabledOnly) clauses.push(eq(schema.models.enabled, true));
    return this.database
      .select()
      .from(schema.models)
      .where(clauses.length === 0 ? undefined : and(...clauses))
      .orderBy(asc(schema.models.displayName))
      .all();
  }

  public get(id: string): schema.ModelRow | undefined {
    return this.database.select().from(schema.models).where(eq(schema.models.id, id)).get();
  }

  public findByRemoteId(providerId: string, remoteId: string): schema.ModelRow | undefined {
    return this.database
      .select()
      .from(schema.models)
      .where(and(eq(schema.models.providerId, providerId), eq(schema.models.remoteId, remoteId)))
      .get();
  }

  public upsert(input: {
    providerId: string;
    remoteId: string;
    displayName: string;
    capabilitiesJson: string;
    contextWindow: number | null;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    metadataJson: string;
    discoveredAt?: Date;
  }): schema.ModelRow {
    const existing = this.findByRemoteId(input.providerId, input.remoteId);
    const timestamp = now();
    if (existing !== undefined) {
      return this.database
        .update(schema.models)
        .set({
          ...input,
          stale: false,
          discoveredAt: input.discoveredAt ?? timestamp,
          updatedAt: timestamp,
        })
        .where(eq(schema.models.id, existing.id))
        .returning()
        .get();
    }
    const provider = this.database
      .select({ enabledModelIdsJson: schema.providers.enabledModelIdsJson })
      .from(schema.providers)
      .where(eq(schema.providers.id, input.providerId))
      .get();
    return this.database
      .insert(schema.models)
      .values({
        id: randomUUID(),
        ...input,
        // 旧服务商尚未保存过模型选择时保持全部启用；保存过后，新发现模型默认关闭。
        enabled: provider?.enabledModelIdsJson === null,
        stale: false,
        discoveredAt: input.discoveredAt ?? timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  /**
   * 将本次发现结果之外的缓存模型标记为已下线，但不覆盖用户的 enabled 偏好。
   * 模型重新出现时 upsert 会清除 stale，从而恢复原有启用选择。
   */
  public reconcileDiscovery(providerId: string, activeRemoteIds: readonly string[]): void {
    const activeRemoteIdSet = new Set(activeRemoteIds);
    const activeModelIds = this.list(providerId)
      .filter((model) => activeRemoteIdSet.has(model.remoteId))
      .map((model) => model.id);
    this.database.transaction((transaction) => {
      transaction
        .update(schema.models)
        .set({ stale: true, updatedAt: now() })
        .where(eq(schema.models.providerId, providerId))
        .run();
      for (let offset = 0; offset < activeModelIds.length; offset += 500) {
        transaction
          .update(schema.models)
          .set({ stale: false, updatedAt: now() })
          .where(
            and(
              eq(schema.models.providerId, providerId),
              inArray(schema.models.id, activeModelIds.slice(offset, offset + 500)),
            ),
          )
          .run();
      }
    });
  }

  /** 在服务商协议或端点变化时立即让旧缓存失效，同时保留用户启用偏好。 */
  public markProviderStale(providerId: string): void {
    this.database
      .update(schema.models)
      .set({ stale: true, updatedAt: now() })
      .where(eq(schema.models.providerId, providerId))
      .run();
  }

  /**
   * 原子保存服务商的启用模型集合，并同步每个模型的 enabled 标志。
   * 空数组是有效配置，表示暂时停用该服务商的全部模型。
   */
  public setEnabledSelection(
    providerId: string,
    enabledModelIds: readonly string[],
  ): schema.ModelRow[] {
    const selectedIds = [...enabledModelIds].sort();
    this.database.transaction((transaction) => {
      transaction
        .update(schema.models)
        .set({ enabled: false, updatedAt: now() })
        .where(eq(schema.models.providerId, providerId))
        .run();
      if (selectedIds.length > 0) {
        transaction
          .update(schema.models)
          .set({ enabled: true, updatedAt: now() })
          .where(
            and(eq(schema.models.providerId, providerId), inArray(schema.models.id, selectedIds)),
          )
          .run();
      }
      transaction
        .update(schema.providers)
        .set({
          enabledModelIdsJson: JSON.stringify(selectedIds),
          updatedAt: now(),
        })
        .where(eq(schema.providers.id, providerId))
        .run();
    });
    return this.list(providerId);
  }
}

export interface ConversationListOptions {
  projectId?: string;
  userId?: string;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

interface AddConversationMessageInput {
  id?: string;
  conversationId: string;
  parentMessageId?: string | null;
  role: schema.MessageRow['role'];
  content: string;
  reasoning?: string | null;
  reasoningDurationMs?: number | null;
  toolCallsJson?: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  feedback?: schema.MessageRow['feedback'];
  createdAt?: Date;
}

type EAgentTransaction = Parameters<Parameters<EAgentDatabase['transaction']>[0]>[0];

export interface MutationIdentity {
  actorId: string;
  operationId: string;
  operationType: 'conversation.branch' | 'message.delete_tail';
  requestFingerprint: string;
}

function assertMutationMatches(row: schema.MutationOperationRow, mutation: MutationIdentity): void {
  if (
    row.operationType !== mutation.operationType ||
    row.requestFingerprint !== mutation.requestFingerprint
  ) {
    throw new Error('幂等键已用于不同操作');
  }
}

export class ConversationsRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public create(input: {
    projectId: string | null;
    userId: string | null;
    title: string;
    parentConversationId?: string | null;
    branchedFromMessageId?: string | null;
    forkKind?: schema.ConversationRow['forkKind'];
    originMessageId?: string | null;
    autoTitlePending?: boolean;
  }): schema.ConversationRow {
    const timestamp = now();
    return this.database
      .insert(schema.conversations)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        userId: input.userId,
        title: input.title,
        parentConversationId: input.parentConversationId ?? null,
        branchedFromMessageId: input.branchedFromMessageId ?? null,
        forkKind: input.forkKind ?? null,
        originMessageId: input.originMessageId ?? null,
        autoTitlePending: input.autoTitlePending ?? false,
        pinned: false,
        archived: false,
        messageCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  public get(id: string): schema.ConversationRow | undefined {
    return this.database
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .get();
  }

  /** 统计指定会话的直接子分支；可按分支所有者过滤，且不加载会话列表或消息。 */
  public countDirectBranches(parentConversationId: string, userId?: string): number {
    return (
      this.database
        .select({ count: sql<number>`count(*)` })
        .from(schema.conversations)
        .where(
          userId === undefined
            ? eq(schema.conversations.parentConversationId, parentConversationId)
            : and(
                eq(schema.conversations.parentConversationId, parentConversationId),
                eq(schema.conversations.userId, userId),
              ),
        )
        .get()?.count ?? 0
    );
  }

  public list(options: ConversationListOptions = {}): schema.ConversationRow[] {
    const clauses: SQL[] = [];
    if (options.projectId !== undefined)
      clauses.push(eq(schema.conversations.projectId, options.projectId));
    if (options.userId !== undefined) clauses.push(eq(schema.conversations.userId, options.userId));
    if (options.archived !== undefined)
      clauses.push(eq(schema.conversations.archived, options.archived));
    if (options.search !== undefined && options.search.trim() !== '') {
      clauses.push(like(schema.conversations.title, `%${options.search.trim()}%`));
    }
    return this.database
      .select()
      .from(schema.conversations)
      .where(clauses.length === 0 ? undefined : and(...clauses))
      .orderBy(desc(schema.conversations.pinned), desc(schema.conversations.updatedAt))
      .limit(options.limit ?? 50)
      .offset(options.offset ?? 0)
      .all();
  }

  public update(
    id: string,
    input: Partial<Pick<schema.ConversationRow, 'title' | 'pinned' | 'archived'>>,
  ): schema.ConversationRow | undefined {
    const values = {
      ...input,
      ...(input.title === undefined ? {} : { autoTitlePending: false }),
      updatedAt: now(),
    };
    return this.database
      .update(schema.conversations)
      .set(values)
      .where(eq(schema.conversations.id, id))
      .returning()
      .get();
  }

  /**
   * 仅在根会话仍保留默认标题、且时间线以 user 开始时更新标题。
   *
   * 检查和写入位于同一 SQLite 事务内；最终 UPDATE 再比较旧标题和消息数，
   * 因此并发的手动重命名始终优先，不会被后台自动标题覆盖。允许只有首条用户消息，
   * 以补偿上下文准备、Key 选择或请求排队在模型调用前失败的会话。
   */
  public updateTitleAfterFirstExchange(
    id: string,
    title: string,
    defaultTitles: readonly string[],
  ): schema.ConversationRow | undefined {
    const normalizedTitle = title.trim();
    if (normalizedTitle === '' || defaultTitles.length === 0) return undefined;
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .get();
      if (
        current === undefined ||
        current.parentConversationId !== null ||
        current.forkKind !== null ||
        current.messageCount < 1 ||
        !current.autoTitlePending ||
        !defaultTitles.includes(current.title.trim())
      ) {
        return undefined;
      }
      const firstExchange = transaction
        .select({ role: schema.messages.role })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, id))
        .orderBy(asc(schema.messages.sequence))
        .limit(2)
        .all();
      if (firstExchange[0]?.role !== 'user') {
        return undefined;
      }
      return transaction
        .update(schema.conversations)
        .set({ title: normalizedTitle, autoTitlePending: false, updatedAt: now() })
        .where(
          and(
            eq(schema.conversations.id, id),
            eq(schema.conversations.title, current.title),
            eq(schema.conversations.messageCount, current.messageCount),
            eq(schema.conversations.autoTitlePending, true),
          ),
        )
        .returning()
        .get();
    });
  }

  public delete(id: string): boolean {
    return (
      this.database.delete(schema.conversations).where(eq(schema.conversations.id, id)).run()
        .changes > 0
    );
  }

  public addMessage(input: AddConversationMessageInput): schema.MessageRow {
    const row = this.addMessageInternal(input);
    if (row === undefined) throw new Error('消息写入失败');
    return row;
  }

  /**
   * 仅当触发本轮生成的输入消息仍存在时写入回复，避免删除与流式收尾并发产生孤立助手消息。
   */
  public addMessageIfMessageExists(
    input: AddConversationMessageInput,
    requiredMessageId: string,
  ): schema.MessageRow | undefined {
    return this.addMessageInternal(input, requiredMessageId);
  }

  private addMessageInternal(
    input: AddConversationMessageInput,
    requiredMessageId?: string,
  ): schema.MessageRow | undefined {
    return this.database.transaction((transaction) => {
      const conversation = transaction
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, input.conversationId))
        .get();
      if (conversation === undefined) throw new Error('对话不存在');
      if (
        requiredMessageId !== undefined &&
        transaction
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, input.conversationId),
              eq(schema.messages.id, requiredMessageId),
            ),
          )
          .get() === undefined
      ) {
        return undefined;
      }
      const createdAt = input.createdAt ?? now();
      const row = transaction
        .insert(schema.messages)
        .values({
          id: input.id ?? randomUUID(),
          conversationId: input.conversationId,
          parentMessageId: input.parentMessageId ?? null,
          sequence: conversation.messageCount + 1,
          role: input.role,
          content: input.content,
          reasoning: input.reasoning ?? null,
          reasoningDurationMs: input.reasoningDurationMs ?? null,
          toolCallsJson: input.toolCallsJson ?? '[]',
          model: input.model ?? null,
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          feedback: input.feedback ?? null,
          createdAt,
        })
        .returning()
        .get();
      transaction
        .update(schema.conversations)
        .set({ messageCount: conversation.messageCount + 1, updatedAt: createdAt })
        .where(eq(schema.conversations.id, input.conversationId))
        .run();
      return row;
    });
  }

  public listMessages(conversationId: string, throughMessageId?: string): schema.MessageRow[] {
    const rows = this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.sequence))
      .all();
    if (throughMessageId === undefined) return rows;
    const endIndex = rows.findIndex((row) => row.id === throughMessageId);
    return endIndex < 0 ? [] : rows.slice(0, endIndex + 1);
  }

  /** 自动标题等轻量场景只读取时间线最前两条消息，避免加载长会话。 */
  public listFirstMessages(conversationId: string): schema.MessageRow[] {
    return this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.sequence))
      .limit(2)
      .all();
  }

  public getMessage(conversationId: string, messageId: string): schema.MessageRow | undefined {
    return this.database
      .select()
      .from(schema.messages)
      .where(
        and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.id, messageId)),
      )
      .get();
  }

  public getMessageById(messageId: string): schema.MessageRow | undefined {
    return this.database
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .get();
  }

  public updateMessageFeedback(
    conversationId: string,
    messageId: string,
    feedback: schema.MessageRow['feedback'],
  ): schema.MessageRow | undefined {
    return this.database
      .update(schema.messages)
      .set({ feedback })
      .where(
        and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.id, messageId)),
      )
      .returning()
      .get();
  }

  /** 查询已提交的分支操作；用于在任何当前状态校验前回放首次结果。 */
  public getBranchMutationResult(mutation: MutationIdentity): schema.ConversationRow | undefined {
    const existing = this.database
      .select()
      .from(schema.mutationOperations)
      .where(
        and(
          eq(schema.mutationOperations.actorId, mutation.actorId),
          eq(schema.mutationOperations.operationId, mutation.operationId),
        ),
      )
      .get();
    if (existing === undefined) return undefined;
    assertMutationMatches(existing, mutation);
    const stored = JSON.parse(existing.responseJson) as {
      conversation: Omit<schema.ConversationRow, 'createdAt' | 'updatedAt'> & {
        createdAt: string;
        updatedAt: string;
      };
    };
    return {
      ...stored.conversation,
      createdAt: new Date(stored.conversation.createdAt),
      updatedAt: new Date(stored.conversation.updatedAt),
    };
  }

  /** 查询已提交的消息删除操作；目标已不存在时仍可回放首次快照和删除计数。 */
  public getDeleteMessageMutationResult(mutation: MutationIdentity):
    | {
        conversation: schema.ConversationRow;
        snapshot: schema.SnapshotRow;
        removedCount: number;
      }
    | undefined {
    const existing = this.database
      .select()
      .from(schema.mutationOperations)
      .where(
        and(
          eq(schema.mutationOperations.actorId, mutation.actorId),
          eq(schema.mutationOperations.operationId, mutation.operationId),
        ),
      )
      .get();
    if (existing === undefined) return undefined;
    assertMutationMatches(existing, mutation);
    const stored = JSON.parse(existing.responseJson) as {
      conversation: Omit<schema.ConversationRow, 'createdAt' | 'updatedAt'> & {
        createdAt: string;
        updatedAt: string;
      };
      snapshotId: string;
      removedCount: number;
    };
    const snapshot = this.database
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, stored.snapshotId))
      .get();
    if (snapshot === undefined) throw new Error('幂等操作快照不存在');
    return {
      conversation: {
        ...stored.conversation,
        createdAt: new Date(stored.conversation.createdAt),
        updatedAt: new Date(stored.conversation.updatedAt),
      },
      snapshot,
      removedCount: stored.removedCount,
    };
  }

  public truncateFromMessage(input: {
    conversationId: string;
    messageId: string;
    expectedMessageCount: number;
    expectedTailMessageId: string;
  }): {
    conversation: schema.ConversationRow;
    snapshot: schema.SnapshotRow;
    removedCount: number;
  } {
    return this.database.transaction((transaction) =>
      this.truncateFromMessageInTransaction(transaction, input),
    );
  }

  /**
   * 删除消息并在同一事务写入幂等结果。重复 operationId 返回首次结果，
   * 即使目标消息已经在首次提交中删除，也不会退化成“消息不存在”。
   */
  public truncateFromMessageIdempotent(
    input: {
      conversationId: string;
      messageId: string;
      expectedMessageCount: number;
      expectedTailMessageId: string;
    },
    mutation: MutationIdentity,
  ): {
    conversation: schema.ConversationRow;
    snapshot: schema.SnapshotRow;
    removedCount: number;
    replayed: boolean;
  } {
    return this.database.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(schema.mutationOperations)
        .where(
          and(
            eq(schema.mutationOperations.actorId, mutation.actorId),
            eq(schema.mutationOperations.operationId, mutation.operationId),
          ),
        )
        .get();
      if (existing !== undefined) {
        assertMutationMatches(existing, mutation);
        const stored = JSON.parse(existing.responseJson) as {
          conversation: Omit<schema.ConversationRow, 'createdAt' | 'updatedAt'> & {
            createdAt: string;
            updatedAt: string;
          };
          snapshotId: string;
          removedCount: number;
        };
        const snapshot = transaction
          .select()
          .from(schema.snapshots)
          .where(eq(schema.snapshots.id, stored.snapshotId))
          .get();
        if (snapshot === undefined) throw new Error('幂等操作快照不存在');
        return {
          conversation: {
            ...stored.conversation,
            createdAt: new Date(stored.conversation.createdAt),
            updatedAt: new Date(stored.conversation.updatedAt),
          },
          snapshot,
          removedCount: stored.removedCount,
          replayed: true,
        };
      }

      const result = this.truncateFromMessageInTransaction(transaction, input);
      transaction
        .insert(schema.mutationOperations)
        .values({
          id: randomUUID(),
          actorId: mutation.actorId,
          operationId: mutation.operationId,
          operationType: mutation.operationType,
          requestFingerprint: mutation.requestFingerprint,
          responseJson: JSON.stringify({
            conversation: result.conversation,
            snapshotId: result.snapshot.id,
            removedCount: result.removedCount,
          }),
          createdAt: now(),
        })
        .run();
      transaction
        .insert(schema.auditLogs)
        .values({
          id: randomUUID(),
          actorId: mutation.actorId,
          action: 'message.delete_tail',
          targetType: 'message',
          targetId: input.messageId,
          metadataJson: JSON.stringify({
            conversationId: input.conversationId,
            removedCount: result.removedCount,
            snapshotId: result.snapshot.id,
            previousMessageCount: input.expectedMessageCount,
            messageCount: result.conversation.messageCount,
            operationId: mutation.operationId,
          }),
          createdAt: now(),
        })
        .run();
      return { ...result, replayed: false };
    });
  }

  public branch(input: {
    conversationId: string;
    fromMessageId: string;
    userId: string | null;
    title: string;
    includeFromMessage?: boolean;
    parentConversationId?: string | null;
    forkKind?: schema.ConversationRow['forkKind'];
    originMessageId?: string | null;
  }): schema.ConversationRow {
    return this.database.transaction((transaction) => this.branchInTransaction(transaction, input));
  }

  /** 创建分支并原子保存幂等结果；重放时返回首次创建的同一分支。 */
  public branchIdempotent(
    input: {
      conversationId: string;
      fromMessageId: string;
      userId: string | null;
      title: string;
      includeFromMessage?: boolean;
      parentConversationId?: string | null;
      forkKind?: schema.ConversationRow['forkKind'];
      originMessageId?: string | null;
    },
    mutation: MutationIdentity,
  ): { conversation: schema.ConversationRow; replayed: boolean } {
    return this.database.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(schema.mutationOperations)
        .where(
          and(
            eq(schema.mutationOperations.actorId, mutation.actorId),
            eq(schema.mutationOperations.operationId, mutation.operationId),
          ),
        )
        .get();
      if (existing !== undefined) {
        assertMutationMatches(existing, mutation);
        const stored = JSON.parse(existing.responseJson) as {
          conversation: Omit<schema.ConversationRow, 'createdAt' | 'updatedAt'> & {
            createdAt: string;
            updatedAt: string;
          };
        };
        return {
          conversation: {
            ...stored.conversation,
            createdAt: new Date(stored.conversation.createdAt),
            updatedAt: new Date(stored.conversation.updatedAt),
          },
          replayed: true,
        };
      }

      const conversation = this.branchInTransaction(transaction, input);
      transaction
        .insert(schema.mutationOperations)
        .values({
          id: randomUUID(),
          actorId: mutation.actorId,
          operationId: mutation.operationId,
          operationType: mutation.operationType,
          requestFingerprint: mutation.requestFingerprint,
          responseJson: JSON.stringify({ conversation }),
          createdAt: now(),
        })
        .run();
      transaction
        .insert(schema.auditLogs)
        .values({
          id: randomUUID(),
          actorId: mutation.actorId,
          action: 'conversation.branch',
          targetType: 'conversation',
          targetId: conversation.id,
          metadataJson: JSON.stringify({
            sourceConversationId: input.conversationId,
            fromMessageId: input.fromMessageId,
            includeFromMessage: input.includeFromMessage ?? true,
            kind: input.forkKind ?? 'branch',
            originMessageId: input.originMessageId ?? input.fromMessageId,
            operationId: mutation.operationId,
          }),
          createdAt: now(),
        })
        .run();
      return { conversation, replayed: false };
    });
  }

  private truncateFromMessageInTransaction(
    transaction: EAgentTransaction,
    input: {
      conversationId: string;
      messageId: string;
      expectedMessageCount: number;
      expectedTailMessageId: string;
    },
  ): {
    conversation: schema.ConversationRow;
    snapshot: schema.SnapshotRow;
    removedCount: number;
  } {
    const conversation = transaction
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, input.conversationId))
      .get();
    if (conversation === undefined) throw new Error('对话不存在');
    if (conversation.messageCount !== input.expectedMessageCount) {
      throw new Error('会话已发生变化，请刷新后重试');
    }
    const target = transaction
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.id, input.messageId),
        ),
      )
      .get();
    if (target === undefined) throw new Error('消息不存在');
    if (target.role === 'system') throw new Error('系统消息不能删除');

    const currentMessages = transaction
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, input.conversationId))
      .orderBy(asc(schema.messages.sequence))
      .all();
    if (
      currentMessages.length !== input.expectedMessageCount ||
      currentMessages.at(-1)?.id !== input.expectedTailMessageId
    ) {
      throw new Error('会话已发生变化，请刷新后重试');
    }
    const remainingCount = currentMessages.filter(
      (message) => message.sequence < target.sequence,
    ).length;
    const timestamp = now();
    const snapshot = transaction
      .insert(schema.snapshots)
      .values({
        id: randomUUID(),
        conversationId: input.conversationId,
        messageCount: conversation.messageCount,
        stateJson: JSON.stringify({ conversation, messages: currentMessages }),
        createdAt: timestamp,
      })
      .returning()
      .get();
    const removedCount = transaction
      .delete(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, input.conversationId),
          gte(schema.messages.sequence, target.sequence),
        ),
      )
      .run().changes;
    if (removedCount < 1) throw new Error('消息不存在');
    const updated = transaction
      .update(schema.conversations)
      .set({
        messageCount: remainingCount,
        updatedAt: timestamp,
      })
      .where(eq(schema.conversations.id, input.conversationId))
      .returning()
      .get();
    if (updated === undefined) throw new Error('对话不存在');
    return { conversation: updated, snapshot, removedCount };
  }

  private branchInTransaction(
    transaction: EAgentTransaction,
    input: {
      conversationId: string;
      fromMessageId: string;
      userId: string | null;
      title: string;
      includeFromMessage?: boolean;
      parentConversationId?: string | null;
      forkKind?: schema.ConversationRow['forkKind'];
      originMessageId?: string | null;
    },
  ): schema.ConversationRow {
    const source = transaction
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, input.conversationId))
      .get();
    if (source === undefined) throw new Error('源对话不存在');
    const allMessages = transaction
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, source.id))
      .orderBy(asc(schema.messages.sequence))
      .all();
    const branchPointIndex = allMessages.findIndex((message) => message.id === input.fromMessageId);
    if (branchPointIndex < 0) throw new Error('分支消息不存在');
    const sourceMessages = allMessages.slice(
      0,
      branchPointIndex + (input.includeFromMessage === false ? 0 : 1),
    );
    const timestamp = now();
    const branchId = randomUUID();
    const branch = transaction
      .insert(schema.conversations)
      .values({
        id: branchId,
        projectId: source.projectId,
        userId: input.userId,
        title: input.title,
        parentConversationId:
          input.parentConversationId === undefined ? source.id : input.parentConversationId,
        branchedFromMessageId: input.fromMessageId,
        forkKind: input.forkKind ?? 'branch',
        originMessageId:
          input.originMessageId === undefined ? input.fromMessageId : input.originMessageId,
        autoTitlePending: false,
        pinned: false,
        archived: false,
        messageCount: sourceMessages.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    const clonedMessageIds = new Map(
      sourceMessages.map((message) => [message.id, randomUUID()] as const),
    );
    if (sourceMessages.length > 0) {
      transaction
        .insert(schema.messages)
        .values(
          sourceMessages.map((message, index) => ({
            id: clonedMessageIds.get(message.id) ?? randomUUID(),
            conversationId: branchId,
            parentMessageId:
              message.parentMessageId === null
                ? null
                : (clonedMessageIds.get(message.parentMessageId) ?? message.parentMessageId),
            sequence: index + 1,
            role: message.role,
            content: message.content,
            reasoning: message.reasoning,
            reasoningDurationMs: message.reasoningDurationMs,
            toolCallsJson: message.toolCallsJson,
            model: message.model,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            feedback: message.feedback,
            createdAt: message.createdAt,
          })),
        )
        .run();
    }
    return branch;
  }

  public createSnapshot(conversationId: string): schema.SnapshotRow {
    const conversation = this.get(conversationId);
    if (conversation === undefined) throw new Error('对话不存在');
    const state = { conversation, messages: this.listMessages(conversationId) };
    return this.database
      .insert(schema.snapshots)
      .values({
        id: randomUUID(),
        conversationId,
        messageCount: conversation.messageCount,
        stateJson: JSON.stringify(state),
        createdAt: now(),
      })
      .returning()
      .get();
  }

  public listSnapshots(conversationId: string): schema.SnapshotRow[] {
    return this.database
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.conversationId, conversationId))
      .orderBy(desc(schema.snapshots.createdAt))
      .all();
  }

  public restoreSnapshot(snapshotId: string): schema.ConversationRow {
    const snapshot = this.database
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, snapshotId))
      .get();
    if (snapshot === undefined) throw new Error('快照不存在');
    const state = JSON.parse(snapshot.stateJson) as {
      conversation: schema.ConversationRow;
      messages: schema.MessageRow[];
    };
    return this.database.transaction((transaction) => {
      transaction
        .delete(schema.messages)
        .where(eq(schema.messages.conversationId, snapshot.conversationId))
        .run();
      for (const message of state.messages) {
        transaction
          .insert(schema.messages)
          .values({
            ...message,
            reasoningDurationMs: message.reasoningDurationMs ?? null,
            feedback: message.feedback ?? null,
            createdAt: new Date(message.createdAt),
          })
          .run();
      }
      return transaction
        .update(schema.conversations)
        .set({
          title: state.conversation.title,
          autoTitlePending: false,
          pinned: state.conversation.pinned,
          archived: state.conversation.archived,
          messageCount: state.messages.length,
          updatedAt: now(),
        })
        .where(eq(schema.conversations.id, snapshot.conversationId))
        .returning()
        .get();
    });
  }

  public listFileChanges(conversationId: string): schema.FileChangeRow[] {
    return this.database
      .select()
      .from(schema.fileChanges)
      .where(eq(schema.fileChanges.conversationId, conversationId))
      .orderBy(desc(schema.fileChanges.createdAt))
      .all();
  }

  public createFileChange(input: {
    conversationId: string;
    path: string;
    diff: string;
  }): schema.FileChangeRow {
    const timestamp = now();
    return this.database
      .insert(schema.fileChanges)
      .values({
        id: randomUUID(),
        conversationId: input.conversationId,
        path: input.path,
        diff: input.diff,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }

  public updateFileChange(
    id: string,
    conversationId: string,
    status: 'accepted' | 'rejected',
    acceptedLines?: readonly number[],
  ): schema.FileChangeRow | undefined {
    return this.database
      .update(schema.fileChanges)
      .set({
        status,
        acceptedLinesJson:
          status === 'accepted' && acceptedLines !== undefined
            ? JSON.stringify(acceptedLines)
            : null,
        updatedAt: now(),
      })
      .where(
        and(
          eq(schema.fileChanges.id, id),
          eq(schema.fileChanges.conversationId, conversationId),
          eq(schema.fileChanges.status, 'pending'),
        ),
      )
      .returning()
      .get();
  }
}

export interface UsageFilter {
  from?: Date;
  to?: Date;
  projectId?: string;
  userId?: string;
  model?: string;
  apiKeyId?: string;
}

export class UsageRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public record(
    input: Omit<typeof schema.usageRecords.$inferInsert, 'id'> & { id?: string },
  ): schema.UsageRecordRow {
    return this.database
      .insert(schema.usageRecords)
      .values({ id: input.id ?? randomUUID(), ...input })
      .returning()
      .get();
  }

  public list(filter: UsageFilter = {}, limit = 10_000): schema.UsageRecordRow[] {
    const clauses: SQL[] = [];
    if (filter.from !== undefined) clauses.push(gte(schema.usageRecords.occurredAt, filter.from));
    if (filter.to !== undefined) clauses.push(lte(schema.usageRecords.occurredAt, filter.to));
    if (filter.projectId !== undefined)
      clauses.push(eq(schema.usageRecords.projectId, filter.projectId));
    if (filter.userId !== undefined) clauses.push(eq(schema.usageRecords.userId, filter.userId));
    if (filter.model !== undefined) clauses.push(eq(schema.usageRecords.model, filter.model));
    if (filter.apiKeyId !== undefined)
      clauses.push(eq(schema.usageRecords.apiKeyId, filter.apiKeyId));
    return this.database
      .select()
      .from(schema.usageRecords)
      .where(clauses.length === 0 ? undefined : and(...clauses))
      .orderBy(desc(schema.usageRecords.occurredAt))
      .limit(limit)
      .all();
  }
}

export class MemoriesRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public list(projectId: string): schema.MemoryRow[] {
    return this.database
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.projectId, projectId), eq(schema.memories.active, true)))
      .orderBy(desc(schema.memories.updatedAt))
      .all();
  }

  public upsert(input: {
    id?: string;
    projectId: string;
    category: string;
    content: string;
    tokenEstimate: number;
  }): schema.MemoryRow {
    const timestamp = now();
    if (input.id !== undefined) {
      const updated = this.database
        .update(schema.memories)
        .set({ ...input, updatedAt: timestamp })
        .where(
          and(eq(schema.memories.id, input.id), eq(schema.memories.projectId, input.projectId)),
        )
        .returning()
        .get();
      if (updated !== undefined) return updated;
    }
    return this.database
      .insert(schema.memories)
      .values({
        id: input.id ?? randomUUID(),
        projectId: input.projectId,
        category: input.category,
        content: input.content,
        tokenEstimate: input.tokenEstimate,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  }
}

export class SettingsRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public get<T>(scope: string): T | undefined {
    const row = this.database
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.scope, scope))
      .get();
    return row === undefined ? undefined : (JSON.parse(row.valueJson) as T);
  }

  public set<T>(scope: string, value: T): T {
    this.database
      .insert(schema.settings)
      .values({ scope, valueJson: JSON.stringify(value), updatedAt: now() })
      .onConflictDoUpdate({
        target: schema.settings.scope,
        set: { valueJson: JSON.stringify(value), updatedAt: now() },
      })
      .run();
    return value;
  }
}

export class AuditRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public record(input: {
    actorId: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  }): void {
    this.database
      .insert(schema.auditLogs)
      .values({
        id: randomUUID(),
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        ipAddress: input.ipAddress ?? null,
        createdAt: now(),
      })
      .run();
  }

  public list(
    filter: { action?: string; targetType?: string; limit?: number; offset?: number } = {},
  ): Array<{
    id: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: Record<string, unknown>;
    ipAddress: string | null;
    createdAt: Date;
  }> {
    const clauses: SQL[] = [];
    if (filter.action !== undefined) clauses.push(eq(schema.auditLogs.action, filter.action));
    if (filter.targetType !== undefined) {
      clauses.push(eq(schema.auditLogs.targetType, filter.targetType));
    }
    return this.database
      .select()
      .from(schema.auditLogs)
      .where(clauses.length === 0 ? undefined : and(...clauses))
      .orderBy(desc(schema.auditLogs.createdAt))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0)
      .all()
      .map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
      }));
  }
}

export class ResponseCacheRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public get<T>(cacheKey: string, at = new Date()): T | undefined {
    const row = this.database
      .select()
      .from(schema.responseCache)
      .where(
        and(eq(schema.responseCache.cacheKey, cacheKey), gte(schema.responseCache.expiresAt, at)),
      )
      .get();
    return row === undefined ? undefined : (JSON.parse(row.responseJson) as T);
  }

  public set<T>(cacheKey: string, value: T, ttlMs: number, at = new Date()): void {
    this.database
      .insert(schema.responseCache)
      .values({
        cacheKey,
        responseJson: JSON.stringify(value),
        createdAt: at,
        expiresAt: new Date(at.getTime() + ttlMs),
      })
      .onConflictDoUpdate({
        target: schema.responseCache.cacheKey,
        set: {
          responseJson: JSON.stringify(value),
          createdAt: at,
          expiresAt: new Date(at.getTime() + ttlMs),
        },
      })
      .run();
  }

  public purgeExpired(at = new Date()): number {
    return this.database
      .delete(schema.responseCache)
      .where(or(lte(schema.responseCache.expiresAt, at), eq(schema.responseCache.expiresAt, at)))
      .run().changes;
  }
}

export class RevokedTokensRepository {
  public constructor(private readonly database: EAgentDatabase) {}

  public isRevoked(jti: string): boolean {
    return (
      this.database
        .select({ jti: schema.revokedTokens.jti })
        .from(schema.revokedTokens)
        .where(eq(schema.revokedTokens.jti, jti))
        .get() !== undefined
    );
  }

  public revoke(input: { jti: string; userId: string; expiresAt: Date; revokedAt: Date }): void {
    this.database
      .insert(schema.revokedTokens)
      .values(input)
      .onConflictDoUpdate({
        target: schema.revokedTokens.jti,
        set: {
          userId: input.userId,
          expiresAt: input.expiresAt,
          revokedAt: input.revokedAt,
        },
      })
      .run();
  }

  public purgeExpired(at = new Date()): number {
    return this.database
      .delete(schema.revokedTokens)
      .where(lte(schema.revokedTokens.expiresAt, at))
      .run().changes;
  }
}

export interface Repositories {
  users: UsersRepository;
  projects: ProjectsRepository;
  providers: ProvidersRepository;
  apiKeys: ApiKeysRepository;
  models: ModelsRepository;
  conversations: ConversationsRepository;
  usage: UsageRepository;
  memories: MemoriesRepository;
  settings: SettingsRepository;
  audit: AuditRepository;
  cache: ResponseCacheRepository;
  revokedTokens: RevokedTokensRepository;
}

export function createRepositories(database: EAgentDatabase): Repositories {
  return {
    users: new UsersRepository(database),
    projects: new ProjectsRepository(database),
    providers: new ProvidersRepository(database),
    apiKeys: new ApiKeysRepository(database),
    models: new ModelsRepository(database),
    conversations: new ConversationsRepository(database),
    usage: new UsageRepository(database),
    memories: new MemoriesRepository(database),
    settings: new SettingsRepository(database),
    audit: new AuditRepository(database),
    cache: new ResponseCacheRepository(database),
    revokedTokens: new RevokedTokensRepository(database),
  };
}
