import { createHash } from 'node:crypto';

import type {
  BranchConversationRequest,
  CreateFileChangeRequest,
  ConversationDetail,
  ConversationListQuery,
  ConversationListResponse,
  CreateConversationRequest,
  DeleteMessageQuery,
  DeleteMessageResponse,
  MessageFeedbackRequest,
  Snapshot,
  UpdateFileChangeRequest,
  UpdateConversationRequest,
} from '@e-agent/contracts';
import type {
  AuditRepository,
  ConversationRow,
  ConversationsRepository,
  ProjectsRepository,
} from '@e-agent/database';

import { isDefaultConversationTitle } from './conversation-title.js';
import { DomainError, assertFound } from './errors.js';
import { mapConversation, mapMessage } from './mappers.js';
import { assertProjectAccess } from './project-access.js';

export interface Actor {
  id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function mutationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 对话、分支和快照领域服务。 */
export class ConversationService {
  public constructor(
    private readonly repository: ConversationsRepository,
    private readonly projects: ProjectsRepository,
    private readonly audit?: AuditRepository,
  ) {}

  public list(query: ConversationListQuery, actor: Actor): ConversationListResponse {
    if (query.projectId !== undefined) {
      assertProjectAccess(this.projects, query.projectId, actor);
    }
    const offset = decodeOffset(query.cursor);
    const rows = this.repository.list({
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(actor.role === 'owner' || actor.role === 'admin' ? {} : { userId: actor.id }),
      ...(query.archived === undefined ? {} : { archived: query.archived }),
      ...(query.search === undefined ? {} : { search: query.search }),
      limit: query.limit + 1,
      offset,
    });
    for (const row of rows) this.assertAccess(row, actor);
    const hasMore = rows.length > query.limit;
    return {
      conversations: rows.slice(0, query.limit).map(mapConversation),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? encodeOffset(offset + query.limit) : null,
      },
    };
  }

  public get(id: string, actor: Actor): ConversationDetail {
    const conversation = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(conversation, actor);
    return {
      conversation: mapConversation(conversation),
      messages: this.repository.listMessages(id).map(mapMessage),
    };
  }

  /** 读取侧栏所需的单个会话摘要，不加载消息时间线。 */
  public getSummary(id: string, actor: Actor) {
    const conversation = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(conversation, actor);
    return {
      conversation: mapConversation(conversation),
      branchCount: this.repository.countDirectBranches(
        id,
        actor.role === 'owner' || actor.role === 'admin' ? undefined : actor.id,
      ),
    };
  }

  public create(input: CreateConversationRequest, actor: Actor) {
    if (actor.role === 'viewer') throw new DomainError('FORBIDDEN', '只读成员不能创建对话');
    if (input.projectId !== null) assertProjectAccess(this.projects, input.projectId, actor);
    return mapConversation(
      this.repository.create({
        projectId: input.projectId,
        userId: actor.id,
        title: input.title,
        autoTitlePending: isDefaultConversationTitle(input.title),
      }),
    );
  }

  public update(id: string, input: UpdateConversationRequest, actor: Actor) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能修改对话');
    const updated = mapConversation(
      assertFound(
        this.repository.update(id, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
        }),
        '对话不存在',
      ),
    );
    this.audit?.record({
      actorId: actor.id,
      action: 'conversation.update',
      targetType: 'conversation',
      targetId: id,
      metadata: { fields: Object.keys(input).sort() },
    });
    return updated;
  }

  public delete(id: string, actor: Actor): void {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能删除对话');
    if (!this.repository.delete(id)) throw new DomainError('NOT_FOUND', '对话不存在');
    this.audit?.record({
      actorId: actor.id,
      action: 'conversation.delete',
      targetType: 'conversation',
      targetId: id,
    });
  }

  public branch(id: string, input: BranchConversationRequest, actor: Actor) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能创建分支');
    const mutation =
      input.operationId === undefined
        ? undefined
        : {
            actorId: actor.id,
            operationId: input.operationId,
            operationType: 'conversation.branch' as const,
            requestFingerprint: mutationFingerprint({
              conversationId: id,
              fromMessageId: input.fromMessageId,
              includeFromMessage: input.includeFromMessage,
              kind: input.kind,
              originMessageId: input.originMessageId ?? null,
              title: input.title ?? null,
            }),
          };
    if (mutation !== undefined) {
      try {
        const replay = this.repository.getBranchMutationResult(mutation);
        if (replay !== undefined) return mapConversation(replay);
      } catch (error) {
        throw new DomainError('CONFLICT', error instanceof Error ? error.message : '幂等操作冲突', {
          cause: error,
        });
      }
    }
    const branchPoint = assertFound(
      this.repository.getMessage(id, input.fromMessageId),
      '分支消息不存在',
    );
    const originMessage =
      input.originMessageId === undefined
        ? branchPoint
        : assertFound(this.repository.getMessage(id, input.originMessageId), '来源消息不存在');
    if (input.kind === 'retry' && originMessage.role !== 'assistant') {
      throw new DomainError('BAD_REQUEST', '只能重试助手消息');
    }
    if (input.kind === 'edit' && originMessage.role !== 'user') {
      throw new DomainError('BAD_REQUEST', '只能编辑用户消息');
    }
    const titleSuffix = {
      branch: '分支',
      retry: '重试',
      edit: '编辑',
    }[input.kind];
    const retryLineage =
      input.kind === 'retry' &&
      current.forkKind === 'retry' &&
      current.parentConversationId !== null &&
      current.originMessageId !== null
        ? {
            parentConversationId: current.parentConversationId,
            originMessageId: current.originMessageId,
          }
        : undefined;
    try {
      const repositoryInput = {
        conversationId: id,
        fromMessageId: input.fromMessageId,
        userId: actor.id,
        title: input.title ?? `${current.title}（${titleSuffix}）`,
        includeFromMessage: input.includeFromMessage,
        ...(retryLineage === undefined
          ? {}
          : { parentConversationId: retryLineage.parentConversationId }),
        forkKind: input.kind,
        originMessageId: retryLineage?.originMessageId ?? originMessage.id,
      };
      const result =
        mutation === undefined
          ? { conversation: this.repository.branch(repositoryInput), replayed: false }
          : this.repository.branchIdempotent(repositoryInput, mutation);
      const branch = mapConversation(result.conversation);
      if (mutation === undefined && !result.replayed) {
        try {
          this.audit?.record({
            actorId: actor.id,
            action: 'conversation.branch',
            targetType: 'conversation',
            targetId: branch.id,
            metadata: {
              sourceConversationId: id,
              fromMessageId: input.fromMessageId,
              includeFromMessage: input.includeFromMessage,
              kind: input.kind,
              originMessageId: retryLineage?.originMessageId ?? originMessage.id,
            },
          });
        } catch {
          // 业务写入已经提交；审计降级不能把成功伪装成失败。
        }
      }
      return branch;
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法创建分支';
      throw new DomainError(message.includes('幂等键') ? 'CONFLICT' : 'BAD_REQUEST', message, {
        cause: error,
      });
    }
  }

  /** 删除目标消息及其后的时间线，并在同一事务内保存可恢复快照。 */
  public deleteMessage(
    id: string,
    messageId: string,
    input: DeleteMessageQuery,
    actor: Actor,
  ): DeleteMessageResponse {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能删除消息');
    const mutation =
      input.operationId === undefined
        ? undefined
        : {
            actorId: actor.id,
            operationId: input.operationId,
            operationType: 'message.delete_tail' as const,
            requestFingerprint: mutationFingerprint({
              conversationId: id,
              messageId,
              expectedMessageCount: input.expectedMessageCount,
              expectedTailMessageId: input.expectedTailMessageId,
            }),
          };
    if (mutation !== undefined) {
      try {
        const replay = this.repository.getDeleteMessageMutationResult(mutation);
        if (replay !== undefined) {
          return {
            conversation: mapConversation(replay.conversation),
            snapshot: {
              id: replay.snapshot.id,
              conversationId: replay.snapshot.conversationId,
              messageCount: replay.snapshot.messageCount,
              createdAt: replay.snapshot.createdAt.toISOString(),
            },
            removedCount: replay.removedCount,
          };
        }
      } catch (error) {
        throw new DomainError('CONFLICT', error instanceof Error ? error.message : '幂等操作冲突', {
          cause: error,
        });
      }
    } else {
      const target = assertFound(this.repository.getMessage(id, messageId), '消息不存在');
      if (target.role === 'system') {
        throw new DomainError('BAD_REQUEST', '系统消息不能删除');
      }
      const currentMessages = this.repository.listMessages(id);
      if (
        current.messageCount !== input.expectedMessageCount ||
        currentMessages.length !== input.expectedMessageCount ||
        currentMessages.at(-1)?.id !== input.expectedTailMessageId
      ) {
        throw new DomainError('CONFLICT', '会话已发生变化，请刷新后重试');
      }
    }

    try {
      const repositoryInput = {
        conversationId: id,
        messageId,
        expectedMessageCount: input.expectedMessageCount,
        expectedTailMessageId: input.expectedTailMessageId,
      };
      const result =
        mutation === undefined
          ? {
              ...this.repository.truncateFromMessage(repositoryInput),
              replayed: false,
            }
          : this.repository.truncateFromMessageIdempotent(repositoryInput, mutation);
      const response: DeleteMessageResponse = {
        conversation: mapConversation(result.conversation),
        snapshot: {
          id: result.snapshot.id,
          conversationId: result.snapshot.conversationId,
          messageCount: result.snapshot.messageCount,
          createdAt: result.snapshot.createdAt.toISOString(),
        },
        removedCount: result.removedCount,
      };
      if (mutation === undefined && !result.replayed) {
        try {
          this.audit?.record({
            actorId: actor.id,
            action: 'message.delete_tail',
            targetType: 'message',
            targetId: messageId,
            metadata: {
              conversationId: id,
              removedCount: result.removedCount,
              snapshotId: result.snapshot.id,
              previousMessageCount: current.messageCount,
              messageCount: result.conversation.messageCount,
            },
          });
        } catch {
          // 业务写入已经提交；审计降级不能把成功伪装成失败。
        }
      }
      return response;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const message = error instanceof Error ? error.message : '无法删除消息';
      if (message.includes('已发生变化')) {
        throw new DomainError('CONFLICT', message, { cause: error });
      }
      if (message.includes('幂等键')) {
        throw new DomainError('CONFLICT', message, { cause: error });
      }
      if (message.includes('不存在')) {
        throw new DomainError('NOT_FOUND', message, { cause: error });
      }
      throw new DomainError('BAD_REQUEST', message, { cause: error });
    }
  }

  /** 更新助手消息的有用/无用反馈；传入 null 可撤销反馈。 */
  public updateMessageFeedback(
    id: string,
    messageId: string,
    input: MessageFeedbackRequest,
    actor: Actor,
  ) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能评价消息');
    const target = assertFound(this.repository.getMessage(id, messageId), '消息不存在');
    if (target.role !== 'assistant') {
      throw new DomainError('BAD_REQUEST', '只能评价助手消息');
    }
    const updated = assertFound(
      this.repository.updateMessageFeedback(id, messageId, input.feedback),
      '消息不存在',
    );
    this.audit?.record({
      actorId: actor.id,
      action: 'message.feedback.update',
      targetType: 'message',
      targetId: messageId,
      metadata: {
        conversationId: id,
        feedback: input.feedback,
      },
    });
    return mapMessage(updated);
  }

  public createSnapshot(id: string, actor: Actor): Snapshot {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能创建快照');
    const snapshot = this.repository.createSnapshot(id);
    const mapped = {
      id: snapshot.id,
      conversationId: snapshot.conversationId,
      messageCount: snapshot.messageCount,
      createdAt: snapshot.createdAt.toISOString(),
    };
    this.audit?.record({
      actorId: actor.id,
      action: 'snapshot.create',
      targetType: 'snapshot',
      targetId: snapshot.id,
      metadata: { conversationId: id },
    });
    return mapped;
  }

  public listSnapshots(id: string, actor: Actor): Snapshot[] {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    return this.repository.listSnapshots(id).map((snapshot) => ({
      id: snapshot.id,
      conversationId: snapshot.conversationId,
      messageCount: snapshot.messageCount,
      createdAt: snapshot.createdAt.toISOString(),
    }));
  }

  public restoreSnapshot(id: string, snapshotId: string, actor: Actor) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能恢复快照');
    const snapshot = this.repository
      .listSnapshots(id)
      .find((candidate) => candidate.id === snapshotId);
    if (snapshot === undefined) throw new DomainError('NOT_FOUND', '快照不存在');
    const restored = mapConversation(this.repository.restoreSnapshot(snapshotId));
    this.audit?.record({
      actorId: actor.id,
      action: 'snapshot.restore',
      targetType: 'conversation',
      targetId: id,
      metadata: { snapshotId },
    });
    return restored;
  }

  public listFileChanges(id: string, actor: Actor) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    return this.repository.listFileChanges(id).map((change) => ({
      id: change.id,
      conversationId: change.conversationId,
      path: change.path,
      diff: change.diff,
      status: change.status,
      acceptedLines:
        change.acceptedLinesJson === null
          ? null
          : (JSON.parse(change.acceptedLinesJson) as number[]),
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    }));
  }

  public createFileChange(id: string, input: CreateFileChangeRequest, actor: Actor) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能登记文件变更');
    const change = this.repository.createFileChange({
      conversationId: id,
      path: input.path.replaceAll('\\', '/'),
      diff: input.diff,
    });
    return {
      id: change.id,
      conversationId: change.conversationId,
      path: change.path,
      diff: change.diff,
      status: change.status,
      acceptedLines: null,
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    };
  }

  public decideFileChange(
    id: string,
    changeId: string,
    input: UpdateFileChangeRequest,
    actor: Actor,
  ) {
    const current = assertFound(this.repository.get(id), '对话不存在');
    this.assertAccess(current, actor);
    this.assertCanMutate(actor, '只读成员不能审批文件变更');
    const change = assertFound(
      this.repository.updateFileChange(changeId, id, input.status, input.acceptedLines),
      '待审批文件变更不存在',
    );
    return {
      id: change.id,
      conversationId: change.conversationId,
      path: change.path,
      diff: change.diff,
      status: change.status,
      acceptedLines:
        change.acceptedLinesJson === null
          ? null
          : (JSON.parse(change.acceptedLinesJson) as number[]),
      createdAt: change.createdAt.toISOString(),
      updatedAt: change.updatedAt.toISOString(),
    };
  }

  private assertAccess(
    conversation: Pick<ConversationRow, 'userId' | 'projectId'>,
    actor: Actor,
  ): void {
    if (actor.role === 'owner' || actor.role === 'admin') return;
    if (conversation.userId !== actor.id) throw new DomainError('FORBIDDEN', '无权访问此对话');
    if (conversation.projectId !== null) {
      assertProjectAccess(this.projects, conversation.projectId, actor);
    }
  }

  private assertCanMutate(actor: Actor, message: string): void {
    if (actor.role === 'viewer') throw new DomainError('FORBIDDEN', message);
  }
}
