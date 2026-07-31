import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCoreServices, type CoreServices } from '../src/index.js';

const MASTER_KEY = 'conversation-operations-master-key-at-least-32-chars';
const SESSION_SECRET = 'conversation-operations-session-secret-at-least-32-chars';

describe('会话消息操作', () => {
  let database: DatabaseContext;
  let services: CoreServices;
  let actor: { id: string; role: 'owner' };

  beforeEach(() => {
    database = openDatabase({ url: ':memory:' });
    services = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
    });
    const owner = services.repositories.users.create({
      email: 'conversation-owner@example.com',
      displayName: 'Conversation Owner',
      passwordHash: 'not-used-in-this-test',
      role: 'owner',
    });
    actor = { id: owner.id, role: 'owner' };
  });

  afterEach(() => database.close());

  it('定向读取会话摘要时校验权限并只查询直接分支数', () => {
    const member = services.repositories.users.create({
      email: 'summary-member@example.com',
      displayName: 'Summary Member',
      passwordHash: 'not-used-in-this-test',
      role: 'member',
    });
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: member.id,
      title: 'Summary source',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });
    services.repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: message.id,
      userId: member.id,
      title: 'Member branch',
    });
    services.repositories.conversations.branch({
      conversationId: conversation.id,
      fromMessageId: message.id,
      userId: actor.id,
      title: 'Owner branch',
    });
    const listMessages = vi.spyOn(services.repositories.conversations, 'listMessages');
    const countDirectBranches = vi.spyOn(
      services.repositories.conversations,
      'countDirectBranches',
    );

    expect(services.conversations.getSummary(conversation.id, actor)).toEqual({
      conversation: expect.objectContaining({
        id: conversation.id,
        title: 'Summary source',
        messageCount: 1,
      }),
      branchCount: 2,
    });
    expect(listMessages).not.toHaveBeenCalled();
    expect(countDirectBranches).toHaveBeenCalledWith(conversation.id, undefined);

    expect(
      services.conversations.getSummary(conversation.id, {
        id: member.id,
        role: 'member',
      }),
    ).toEqual({
      conversation: expect.objectContaining({ id: conversation.id }),
      branchCount: 1,
    });
    expect(countDirectBranches).toHaveBeenLastCalledWith(conversation.id, member.id);

    const thirdMember = services.repositories.users.create({
      email: 'third-member@example.com',
      displayName: 'Third Member',
      passwordHash: 'not-used-in-this-test',
      role: 'member',
    });
    expect(() =>
      services.conversations.getSummary(conversation.id, {
        id: thirdMember.id,
        role: 'member',
      }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(countDirectBranches).toHaveBeenCalledTimes(2);
  });

  it('按重试语义创建不包含原助手回答的分支并记录来源', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Original',
    });
    services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });
    const assistant = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'First answer',
    });

    const branch = services.conversations.branch(
      conversation.id,
      {
        fromMessageId: assistant.id,
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: assistant.id,
      },
      actor,
    );

    expect(branch).toMatchObject({
      parentConversationId: conversation.id,
      branchedFromMessageId: assistant.id,
      forkKind: 'retry',
      originMessageId: assistant.id,
      title: 'Original（重试）',
      messageCount: 1,
    });
    expect(services.repositories.conversations.listMessages(branch.id)).toMatchObject([
      { role: 'user', content: 'Question' },
    ]);
    expect(
      services.repositories.audit.list({ action: 'conversation.branch', limit: 1 })[0]?.metadata,
    ).toMatchObject({
      sourceConversationId: conversation.id,
      fromMessageId: assistant.id,
      includeFromMessage: false,
      kind: 'retry',
      originMessageId: assistant.id,
    });
  });

  it('使用同一 operationId 重放分支并且只创建一个分支和一条审计', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Idempotent branch',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Branch here',
    });
    const request = {
      operationId: 'branch-operation-0001',
      fromMessageId: message.id,
      includeFromMessage: true,
      kind: 'branch' as const,
    };

    const first = services.conversations.branch(conversation.id, request, actor);
    const restartedServices = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
    });
    const replay = restartedServices.conversations.branch(conversation.id, request, actor);

    expect(replay).toEqual(first);
    expect(
      services.repositories.conversations
        .list({ limit: 20, offset: 0 })
        .filter((item) => item.parentConversationId === conversation.id),
    ).toHaveLength(1);
    expect(services.repositories.audit.list({ action: 'conversation.branch' })).toHaveLength(1);
  });

  it('拒绝使用用户消息作为重试来源', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Original',
    });
    const userMessage = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });

    expect(() =>
      services.conversations.branch(
        conversation.id,
        {
          fromMessageId: userMessage.id,
          includeFromMessage: false,
          kind: 'retry',
          originMessageId: userMessage.id,
        },
        actor,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: '只能重试助手消息',
      }),
    );
  });

  it('删除目标消息及后续时间线，并自动创建可恢复快照', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Delete tail',
    });
    const first = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Keep me',
    });
    const target = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Delete me',
    });
    const tail = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Delete me too',
    });

    const result = services.conversations.deleteMessage(
      conversation.id,
      target.id,
      { expectedMessageCount: 3, expectedTailMessageId: tail.id },
      actor,
    );

    expect(result).toMatchObject({
      conversation: { id: conversation.id, messageCount: 1 },
      snapshot: { conversationId: conversation.id, messageCount: 3 },
      removedCount: 2,
    });
    expect(services.repositories.conversations.listMessages(conversation.id)).toMatchObject([
      { id: first.id, content: 'Keep me' },
    ]);
    expect(services.repositories.conversations.listSnapshots(conversation.id)[0]?.id).toBe(
      result.snapshot.id,
    );
    expect(
      services.repositories.audit.list({ action: 'message.delete_tail', limit: 1 })[0],
    ).toMatchObject({
      targetId: target.id,
      metadata: {
        conversationId: conversation.id,
        removedCount: 2,
        snapshotId: result.snapshot.id,
        previousMessageCount: 3,
        messageCount: 1,
      },
    });
  });

  it('使用同一 operationId 重放删除结果而不是返回消息不存在', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Idempotent delete',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Delete once',
    });
    const request = {
      operationId: 'delete-operation-0001',
      expectedMessageCount: 1,
      expectedTailMessageId: message.id,
    };

    const first = services.conversations.deleteMessage(conversation.id, message.id, request, actor);
    const restartedServices = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
    });
    const replay = restartedServices.conversations.deleteMessage(
      conversation.id,
      message.id,
      request,
      actor,
    );

    expect(replay).toEqual(first);
    expect(services.repositories.conversations.listMessages(conversation.id)).toHaveLength(0);
    expect(services.repositories.conversations.listSnapshots(conversation.id)).toHaveLength(1);
    expect(services.repositories.audit.list({ action: 'message.delete_tail' })).toHaveLength(1);
    const persisted = database.sqlite
      .prepare('SELECT response_json FROM mutation_operations WHERE operation_id = ?')
      .get(request.operationId) as { response_json: string };
    expect(persisted.response_json).not.toContain('stateJson');
    expect(persisted.response_json).not.toContain('Delete once');
  });

  it('拒绝把同一 operationId 用于不同删除请求', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Conflicting key',
    });
    const first = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'First',
    });
    const second = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Second',
    });
    services.conversations.deleteMessage(
      conversation.id,
      second.id,
      {
        operationId: 'delete-operation-conflict',
        expectedMessageCount: 2,
        expectedTailMessageId: second.id,
      },
      actor,
    );

    expect(() =>
      services.conversations.deleteMessage(
        conversation.id,
        first.id,
        {
          operationId: 'delete-operation-conflict',
          expectedMessageCount: 2,
          expectedTailMessageId: second.id,
        },
        actor,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('非幂等旧调用在审计降级时仍返回已提交的删除结果', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Audit degradation',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Delete despite audit failure',
    });
    vi.spyOn(services.repositories.audit, 'record').mockImplementation(() => {
      throw new Error('audit storage unavailable');
    });

    expect(
      services.conversations.deleteMessage(
        conversation.id,
        message.id,
        { expectedMessageCount: 1, expectedTailMessageId: message.id },
        actor,
      ),
    ).toMatchObject({ conversation: { messageCount: 0 }, removedCount: 1 });
    expect(services.repositories.conversations.listMessages(conversation.id)).toHaveLength(0);
  });

  it('消息数预条件过期时返回冲突且不创建快照', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Concurrent mutation',
    });
    const message = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Keep until refreshed',
    });

    expect(() =>
      services.conversations.deleteMessage(
        conversation.id,
        message.id,
        { expectedMessageCount: 0, expectedTailMessageId: message.id },
        actor,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(services.repositories.conversations.listMessages(conversation.id)).toHaveLength(1);
    expect(services.repositories.conversations.listSnapshots(conversation.id)).toHaveLength(0);
  });

  it('设置和撤销助手反馈，并拒绝评价用户消息', () => {
    const conversation = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Feedback',
    });
    const userMessage = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Question',
    });
    const assistant = services.repositories.conversations.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Answer',
    });

    expect(
      services.conversations.updateMessageFeedback(
        conversation.id,
        assistant.id,
        { feedback: 'helpful' },
        actor,
      ),
    ).toMatchObject({ id: assistant.id, feedback: 'helpful' });
    expect(
      services.conversations.updateMessageFeedback(
        conversation.id,
        assistant.id,
        { feedback: null },
        actor,
      ),
    ).toMatchObject({ id: assistant.id, feedback: null });
    expect(() =>
      services.conversations.updateMessageFeedback(
        conversation.id,
        userMessage.id,
        { feedback: 'unhelpful' },
        actor,
      ),
    ).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(services.repositories.audit.list({ action: 'message.feedback.update' })).toHaveLength(2);
  });

  it('连续重试保持同一答案版本组，并把新版本挂到原会话', () => {
    const root = services.repositories.conversations.create({
      projectId: null,
      userId: actor.id,
      title: 'Root',
    });
    const rootUser = services.repositories.conversations.addMessage({
      conversationId: root.id,
      role: 'user',
      content: 'Question',
    });
    const rootAssistant = services.repositories.conversations.addMessage({
      conversationId: root.id,
      role: 'assistant',
      content: 'First answer',
    });
    const firstRetry = services.conversations.branch(
      root.id,
      {
        fromMessageId: rootUser.id,
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: rootAssistant.id,
      },
      actor,
    );
    const retryUser = services.repositories.conversations.addMessage({
      conversationId: firstRetry.id,
      role: 'user',
      content: 'Question',
    });
    const retryAssistant = services.repositories.conversations.addMessage({
      conversationId: firstRetry.id,
      role: 'assistant',
      content: 'Second answer',
    });

    const secondRetry = services.conversations.branch(
      firstRetry.id,
      {
        fromMessageId: retryUser.id,
        includeFromMessage: false,
        kind: 'retry',
        originMessageId: retryAssistant.id,
      },
      actor,
    );

    expect(secondRetry).toMatchObject({
      parentConversationId: root.id,
      forkKind: 'retry',
      originMessageId: rootAssistant.id,
      messageCount: 0,
    });
  });
});
