import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportError, type EAgentTransport } from '../lib/transport';
import type { ChatRequest, Message, ToolCall } from '../types';

import { useConversationStore } from './conversation-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const now = '2026-07-28T10:00:00.000Z';

function conversation(id: string) {
  return {
    id,
    title: id,
    pinned: false,
    archived: false,
    updatedAt: now,
    branchCount: 0,
    messageCount: 0,
  };
}

const emptyContext = {
  usedTokens: 0,
  contextWindow: 64_000,
  sources: [],
  compressed: false,
};

describe('conversation store', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [],
      selectedId: null,
      messages: [],
      context: null,
      snapshots: [],
      snapshotsLoading: false,
      restoringSnapshotId: null,
      snapshotError: null,
      loading: false,
      streaming: false,
      error: null,
      queue: { running: 0, queued: 0 },
      queuedPrompts: [],
      abortController: null,
      messageMutationId: null,
      selectionEpoch: 0,
      conversationListEpoch: 0,
      conversationRevision: 0,
    });
  });

  it('创建会话、消费流式事件并落入完整消息状态', async () => {
    const now = new Date().toISOString();
    let streamRequest: ChatRequest | undefined;
    const transport = {
      createConversation: async () => ({
        id: 'conversation-1',
        title: '新会话',
        pinned: false,
        archived: false,
        updatedAt: now,
        branchCount: 0,
        messageCount: 0,
      }),
      streamChat: async function* (request: ChatRequest) {
        streamRequest = request;
        yield {
          type: 'queue' as const,
          requestId: 'request-local',
          queue: { position: 2, active: 1, pending: 2 },
        };
        yield {
          type: 'queue' as const,
          requestId: 'request-local',
          queue: { position: null, active: 1, pending: 1 },
        };
        yield {
          type: 'start' as const,
          requestId: 'request-1',
          messageId: 'assistant-message-1',
        };
        yield {
          type: 'delta' as const,
          requestId: 'request-1',
          delta: '流式回答',
        };
        yield {
          type: 'usage' as const,
          requestId: 'request-1',
          usage: { inputTokens: 3, outputTokens: 4, cost: 0.001, latencyMs: 25 },
        };
        yield { type: 'done' as const, requestId: 'request-1' };
      },
      getContext: async () => ({
        usedTokens: 7,
        contextWindow: 64_000,
        sources: [],
        compressed: false,
      }),
      listMessages: async () => useConversationStore.getState().messages,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: '请回答',
      model: 'model-record-1',
    });

    const state = useConversationStore.getState();
    expect(state.selectedId).toBe('conversation-1');
    expect(state.streaming).toBe(false);
    expect(state.error).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: 'user', content: '请回答' });
    expect(streamRequest?.userMessageId).toBe(state.messages[0]?.id);
    expect(state.messages[1]).toMatchObject({
      id: 'assistant-message-1',
      role: 'assistant',
      content: '流式回答',
      status: 'completed',
      inputTokens: 3,
      outputTokens: 4,
      latencyMs: 25,
    });
    expect(state.context?.usedTokens).toBe(7);
    expect(state.queue).toEqual({ running: 1, queued: 1 });
  });

  it('从历史消息创建分支并保存当前会话快照', async () => {
    const now = new Date().toISOString();
    let branchedFrom: { conversationId: string; messageId: string } | undefined;
    let snapshottedConversationId: string | undefined;
    const original = {
      id: 'conversation-original',
      title: '原会话',
      pinned: false,
      archived: false,
      updatedAt: now,
      branchCount: 0,
      messageCount: 2,
    };
    const branch = {
      ...original,
      id: 'conversation-branch',
      title: '原会话（分支）',
      branchCount: 0,
    };
    const sourceMessage = {
      id: 'message-1',
      conversationId: original.id,
      role: 'user' as const,
      content: 'branch here',
      createdAt: now,
      status: 'completed' as const,
    };
    useConversationStore.setState({
      conversations: [original],
      selectedId: original.id,
      messages: [sourceMessage],
    });
    const transport = {
      branchConversation: async (conversationId: string, messageId: string) => {
        branchedFrom = { conversationId, messageId };
        return branch;
      },
      listMessages: vi.fn().mockResolvedValueOnce([sourceMessage]).mockResolvedValueOnce([]),
      getContext: async () => ({
        usedTokens: 0,
        contextWindow: 64_000,
        sources: [],
        compressed: false,
      }),
      createSnapshot: async (conversationId: string) => {
        snapshottedConversationId = conversationId;
        return {
          id: 'snapshot-1',
          conversationId,
          messageCount: original.messageCount,
          createdAt: now,
        };
      },
    } as unknown as EAgentTransport;

    const snapshot = await useConversationStore.getState().createSnapshot(transport);
    await useConversationStore.getState().branchConversation(transport, 'message-1');

    expect(snapshot.id).toBe('snapshot-1');
    expect(snapshottedConversationId).toBe(original.id);
    expect(branchedFrom).toEqual({
      conversationId: original.id,
      messageId: 'message-1',
    });
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: branch.id,
      conversations: [branch, { ...original, branchCount: 1 }],
      messages: [],
      loading: false,
    });
  });

  it('从重试目标之前复制前缀，并在新分支重发原用户消息', async () => {
    const original = {
      ...conversation('conversation-retry-source'),
      title: 'Original',
      messageCount: 4,
    };
    const originalMessages = [
      {
        id: 'user-earlier',
        conversationId: original.id,
        role: 'user' as const,
        content: 'earlier prompt',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'assistant-earlier',
        conversationId: original.id,
        role: 'assistant' as const,
        content: 'earlier answer',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'user-retry',
        conversationId: original.id,
        role: 'user' as const,
        content: 'retry this prompt',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'assistant-retry',
        conversationId: original.id,
        role: 'assistant' as const,
        content: 'failed answer',
        createdAt: now,
        status: 'failed' as const,
      },
    ];
    const localMessages = originalMessages.map((message) =>
      message.id === 'user-retry'
        ? { ...message, id: 'temporary-user-retry' }
        : message.id === 'assistant-retry'
          ? { ...message, id: 'temporary-assistant-retry' }
          : message,
    );
    const branch = {
      ...conversation('conversation-retry-branch'),
      title: 'Original · 重试',
      parentConversationId: original.id,
      branchedFromMessageId: 'user-retry',
      forkKind: 'retry' as const,
      originMessageId: 'assistant-retry',
      messageCount: 2,
    };
    const branchPrefix = originalMessages.slice(0, 2).map((message, index) => ({
      ...message,
      id: `retry-prefix-${String(index + 1)}`,
      conversationId: branch.id,
    }));
    useConversationStore.setState({
      conversations: [original],
      selectedId: original.id,
      messages: localMessages,
    });
    const branchConversation = vi.fn().mockResolvedValue(branch);
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(originalMessages)
      .mockResolvedValueOnce(originalMessages)
      .mockResolvedValueOnce(branchPrefix)
      .mockImplementationOnce(async () => useConversationStore.getState().messages);
    const streamChat = vi.fn(async function* () {
      yield {
        type: 'start' as const,
        requestId: 'retry-request',
        messageId: 'retry-answer-new',
      };
      yield { type: 'delta' as const, requestId: 'retry-request', delta: 'new answer' };
      yield { type: 'done' as const, requestId: 'retry-request' };
    });
    const transport = {
      branchConversation,
      listMessages,
      getContext: vi.fn().mockResolvedValue(emptyContext),
      streamChat,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().retryMessage(transport, 'temporary-assistant-retry', {
      model: 'model-retry',
    });

    expect(branchConversation).toHaveBeenCalledWith(original.id, 'user-retry', {
      includeFromMessage: false,
      kind: 'retry',
      originMessageId: 'assistant-retry',
      title: 'Original · 重试',
    });
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: branch.id,
        content: 'retry this prompt',
        model: 'model-retry',
      }),
      expect.any(AbortSignal),
    );
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: branch.id,
      messages: [
        expect.objectContaining({ content: 'earlier prompt' }),
        expect.objectContaining({ content: 'earlier answer' }),
        expect.objectContaining({ role: 'user', content: 'retry this prompt' }),
        expect.objectContaining({
          id: 'retry-answer-new',
          role: 'assistant',
          content: 'new answer',
          status: 'completed',
        }),
      ],
    });
  });

  it('仅用户消息已落库时创建普通分支后重发，不伪造助手重试来源', async () => {
    const original = {
      ...conversation('conversation-user-only-retry'),
      title: 'Original',
      messageCount: 1,
    };
    const persistedUser: Message = {
      id: 'persisted-user-only',
      conversationId: original.id,
      role: 'user',
      content: 'retry after pre-start failure',
      createdAt: now,
      status: 'completed',
    };
    const failedAssistant: Message = {
      id: 'transient-failed-assistant',
      conversationId: original.id,
      role: 'assistant',
      content: '生成失败，请重试。',
      createdAt: now,
      status: 'failed',
    };
    const branch = {
      ...conversation('conversation-user-only-branch'),
      title: 'Original · 重试',
      parentConversationId: original.id,
      branchedFromMessageId: persistedUser.id,
      forkKind: 'branch' as const,
      messageCount: 0,
    };
    useConversationStore.setState({
      conversations: [original],
      selectedId: original.id,
      messages: [persistedUser, failedAssistant],
    });
    const branchConversation = vi.fn().mockResolvedValue(branch);
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce([persistedUser])
      .mockResolvedValueOnce([persistedUser])
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => useConversationStore.getState().messages);
    const streamChat = vi.fn(async function* () {
      yield {
        type: 'start' as const,
        requestId: 'user-only-retry-request',
        messageId: 'user-only-retry-answer',
      };
      yield {
        type: 'delta' as const,
        requestId: 'user-only-retry-request',
        delta: 'recovered',
      };
      yield { type: 'done' as const, requestId: 'user-only-retry-request' };
    });
    const transport = {
      branchConversation,
      listMessages,
      getContext: vi.fn().mockResolvedValue(emptyContext),
      streamChat,
    } as unknown as EAgentTransport;

    await useConversationStore
      .getState()
      .retryMessage(transport, failedAssistant.id, { model: 'model-retry' });

    expect(branchConversation).toHaveBeenCalledWith(original.id, persistedUser.id, {
      includeFromMessage: false,
      kind: 'branch',
      title: 'Original · 重试',
    });
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: branch.id,
        content: persistedUser.content,
      }),
      expect.any(AbortSignal),
    );
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: branch.id,
      messageMutationId: null,
      messages: [
        expect.objectContaining({ role: 'user', content: persistedUser.content }),
        expect.objectContaining({
          id: 'user-only-retry-answer',
          role: 'assistant',
          content: 'recovered',
          status: 'completed',
        }),
      ],
    });
  });

  it('从待编辑消息之前复制前缀，并在 edit 分支发送修改稿', async () => {
    const original = {
      ...conversation('conversation-edit-source'),
      title: 'Editable',
      messageCount: 4,
    };
    const originalMessages = [
      {
        id: 'edit-user-earlier',
        conversationId: original.id,
        role: 'user' as const,
        content: 'earlier prompt',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'edit-assistant-earlier',
        conversationId: original.id,
        role: 'assistant' as const,
        content: 'earlier answer',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'edit-user-target',
        conversationId: original.id,
        role: 'user' as const,
        content: 'old prompt',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'edit-assistant-target',
        conversationId: original.id,
        role: 'assistant' as const,
        content: 'old answer',
        createdAt: now,
        status: 'completed' as const,
      },
    ];
    const branch = {
      ...conversation('conversation-edit-branch'),
      title: 'Editable · 编辑',
      parentConversationId: original.id,
      branchedFromMessageId: 'edit-user-target',
      forkKind: 'edit' as const,
      originMessageId: 'edit-user-target',
      messageCount: 2,
    };
    const branchPrefix = originalMessages.slice(0, 2).map((message, index) => ({
      ...message,
      id: `edit-prefix-${String(index + 1)}`,
      conversationId: branch.id,
    }));
    useConversationStore.setState({
      conversations: [original],
      selectedId: original.id,
      messages: originalMessages,
    });
    const branchConversation = vi.fn().mockResolvedValue(branch);
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce(originalMessages)
      .mockResolvedValueOnce(branchPrefix)
      .mockImplementationOnce(async () => useConversationStore.getState().messages);
    const streamChat = vi.fn(async function* () {
      yield {
        type: 'start' as const,
        requestId: 'edit-request',
        messageId: 'edit-answer-new',
      };
      yield { type: 'delta' as const, requestId: 'edit-request', delta: 'edited answer' };
      yield { type: 'done' as const, requestId: 'edit-request' };
    });
    const transport = {
      branchConversation,
      listMessages,
      getContext: vi.fn().mockResolvedValue(emptyContext),
      streamChat,
    } as unknown as EAgentTransport;

    await useConversationStore
      .getState()
      .editAndResend(transport, 'edit-user-target', '  edited prompt  ', {
        model: 'model-edit',
      });

    expect(branchConversation).toHaveBeenCalledWith(original.id, 'edit-user-target', {
      includeFromMessage: false,
      kind: 'edit',
      originMessageId: 'edit-user-target',
      title: 'Editable · 编辑',
    });
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: branch.id,
        content: 'edited prompt',
        model: 'model-edit',
      }),
      expect.any(AbortSignal),
    );
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: branch.id,
      messages: [
        expect.objectContaining({ content: 'earlier prompt' }),
        expect.objectContaining({ content: 'earlier answer' }),
        expect.objectContaining({ role: 'user', content: 'edited prompt' }),
        expect.objectContaining({
          id: 'edit-answer-new',
          role: 'assistant',
          content: 'edited answer',
          status: 'completed',
        }),
      ],
    });
  });

  it('列出快照并在恢复后重新加载消息、上下文与会话元数据', async () => {
    const now = new Date().toISOString();
    const conversation = {
      id: 'conversation-restore',
      title: '恢复前',
      pinned: false,
      archived: false,
      updatedAt: now,
      branchCount: 2,
      messageCount: 4,
    };
    const snapshot = {
      id: 'snapshot-restore',
      conversationId: conversation.id,
      messageCount: 2,
      createdAt: now,
    };
    const restoredMessage = {
      id: 'message-restored',
      conversationId: conversation.id,
      role: 'assistant' as const,
      content: '已恢复的回答',
      createdAt: now,
    };
    const context = {
      usedTokens: 18,
      contextWindow: 32_000,
      sources: [],
      compressed: false,
    };
    const calls: string[] = [];
    useConversationStore.setState({
      conversations: [conversation],
      selectedId: conversation.id,
    });
    const transport = {
      listSnapshots: async (conversationId: string) => {
        calls.push(`listSnapshots:${conversationId}`);
        return [snapshot];
      },
      restoreSnapshot: async (conversationId: string, snapshotId: string) => {
        calls.push(`restore:${conversationId}:${snapshotId}`);
        return {
          ...conversation,
          title: '恢复后的标题',
          messageCount: 2,
        };
      },
      listMessages: async (conversationId: string) => {
        calls.push(`messages:${conversationId}`);
        return [restoredMessage];
      },
      getContext: async (conversationId: string) => {
        calls.push(`context:${conversationId}`);
        return context;
      },
    } as unknown as EAgentTransport;

    await useConversationStore.getState().loadSnapshots(transport);
    await useConversationStore.getState().restoreSnapshot(transport, snapshot.id);

    expect(calls).toEqual([
      `listSnapshots:${conversation.id}`,
      `restore:${conversation.id}:${snapshot.id}`,
      `messages:${conversation.id}`,
      `context:${conversation.id}`,
      `listSnapshots:${conversation.id}`,
    ]);
    expect(useConversationStore.getState()).toMatchObject({
      snapshots: [snapshot],
      restoringSnapshotId: null,
      snapshotError: null,
      messages: [restoredMessage],
      context,
      conversations: [
        expect.objectContaining({
          id: conversation.id,
          title: '恢复后的标题',
          branchCount: 2,
          messageCount: 2,
        }),
      ],
    });
  });

  it('加载、选择、更新并删除会话，同时正确处理选中与非选中项', async () => {
    const first = conversation('first');
    const second = conversation('second');
    const transport = {
      listConversations: vi.fn().mockResolvedValue([first, second]),
      listMessages: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(async () => useConversationStore.getState().messages),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      updateConversation: vi.fn(async (id: string) => ({ ...conversation(id), title: 'updated' })),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
    } as unknown as EAgentTransport;

    await useConversationStore.getState().loadConversations(transport);
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: first.id,
      conversations: [first, second],
      loading: false,
      context: emptyContext,
    });
    await useConversationStore.getState().updateConversation(transport, second.id, {
      title: 'updated',
    });
    expect(useConversationStore.getState().conversations[1]?.title).toBe('updated');

    useConversationStore.setState({
      messages: [
        {
          id: 'message',
          conversationId: first.id,
          role: 'user',
          content: 'keep until selected is deleted',
          createdAt: now,
        },
      ],
      snapshots: [{ id: 'snapshot', conversationId: first.id, messageCount: 1, createdAt: now }],
      snapshotsLoading: true,
      restoringSnapshotId: 'snapshot',
      snapshotError: 'old',
    });
    await useConversationStore.getState().deleteConversation(transport, second.id);
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: first.id,
      messages: [expect.objectContaining({ id: 'message' })],
      snapshotsLoading: true,
      restoringSnapshotId: 'snapshot',
      snapshotError: 'old',
    });
    await useConversationStore.getState().deleteConversation(transport, first.id);
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: null,
      messages: [],
      context: null,
      snapshots: [],
      snapshotsLoading: false,
      restoringSnapshotId: null,
      snapshotError: null,
    });
  });

  it('删除消息后重新加载消息、上下文、快照和会话计数', async () => {
    const current = {
      ...conversation('conversation-delete-message'),
      branchCount: 2,
      messageCount: 3,
    };
    const messages = [
      {
        id: 'delete-keep',
        conversationId: current.id,
        role: 'user' as const,
        content: 'keep',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'delete-target',
        conversationId: current.id,
        role: 'assistant' as const,
        content: 'remove',
        createdAt: now,
        status: 'completed' as const,
      },
      {
        id: 'delete-tail',
        conversationId: current.id,
        role: 'user' as const,
        content: 'remove too',
        createdAt: now,
        status: 'completed' as const,
      },
    ];
    const snapshot = {
      id: 'snapshot-before-delete',
      conversationId: current.id,
      messageCount: 3,
      createdAt: now,
    };
    const refreshedContext = { ...emptyContext, usedTokens: 7 };
    const deleteMessage = vi.fn().mockResolvedValue({
      conversation: { ...current, branchCount: 0, messageCount: 1 },
      snapshot,
      removedCount: 2,
    });
    const transport = {
      deleteMessage,
      getMessageSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          messages,
          messageCount: 3,
          tailMessageId: 'delete-tail',
        })
        .mockResolvedValueOnce({
          messages: [messages[0]],
          messageCount: 1,
          tailMessageId: 'delete-keep',
        }),
      getContext: vi.fn().mockResolvedValue(refreshedContext),
      listSnapshots: vi.fn().mockResolvedValue([snapshot]),
    } as unknown as EAgentTransport;
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      messages,
      snapshots: [],
      context: emptyContext,
    });

    await expect(
      useConversationStore.getState().deleteMessage(transport, 'delete-target'),
    ).resolves.toMatchObject({
      removedCount: 2,
      snapshot,
    });

    expect(deleteMessage).toHaveBeenCalledWith(current.id, 'delete-target', {
      messageCount: 3,
      tailMessageId: 'delete-tail',
    });
    expect(useConversationStore.getState()).toMatchObject({
      messages: [expect.objectContaining({ id: 'delete-keep' })],
      context: refreshedContext,
      snapshots: [snapshot],
      conversations: [
        expect.objectContaining({
          id: current.id,
          messageCount: 1,
          branchCount: 2,
        }),
      ],
    });
  });

  it.each(['messages', 'context', 'snapshots'] as const)(
    'DELETE 已提交后即使 %s 刷新失败也保留本地提交结果',
    async (failingRefresh) => {
      const current = {
        ...conversation(`delete-refresh-${failingRefresh}`),
        messageCount: 2,
      };
      const messages: Message[] = [
        {
          id: 'refresh-keep',
          conversationId: current.id,
          role: 'user',
          content: 'keep',
          createdAt: now,
          status: 'completed',
        },
        {
          id: 'refresh-delete',
          conversationId: current.id,
          role: 'assistant',
          content: 'remove',
          createdAt: now,
          status: 'completed',
        },
      ];
      const snapshot = {
        id: `snapshot-${failingRefresh}`,
        conversationId: current.id,
        messageCount: 2,
        createdAt: now,
      };
      const getMessageSnapshot = vi.fn().mockResolvedValueOnce({
        messages,
        messageCount: 2,
        tailMessageId: 'refresh-delete',
      });
      if (failingRefresh === 'messages') {
        getMessageSnapshot.mockRejectedValueOnce(new Error('messages refresh failed'));
      } else {
        getMessageSnapshot.mockResolvedValueOnce({
          messages: [messages[0]],
          messageCount: 1,
          tailMessageId: 'refresh-keep',
        });
      }
      const transport = {
        getMessageSnapshot,
        deleteMessage: vi.fn().mockResolvedValue({
          conversation: { ...current, messageCount: 1 },
          snapshot,
          removedCount: 1,
        }),
        getContext:
          failingRefresh === 'context'
            ? vi.fn().mockRejectedValue(new Error('context refresh failed'))
            : vi.fn().mockResolvedValue(emptyContext),
        listSnapshots:
          failingRefresh === 'snapshots'
            ? vi.fn().mockRejectedValue(new Error('snapshots refresh failed'))
            : vi.fn().mockResolvedValue([snapshot]),
      } as unknown as EAgentTransport;
      useConversationStore.setState({
        conversations: [current],
        selectedId: current.id,
        messages,
        context: emptyContext,
        snapshots: [],
      });

      await expect(
        useConversationStore.getState().deleteMessage(transport, 'refresh-delete'),
      ).resolves.toMatchObject({ removedCount: 1, snapshot });

      expect(useConversationStore.getState()).toMatchObject({
        messages: [expect.objectContaining({ id: 'refresh-keep' })],
        snapshots: [snapshot],
        messageMutationId: null,
      });
      expect(
        useConversationStore.getState().messages.some((message) => message.id === 'refresh-delete'),
      ).toBe(false);
    },
  );

  it('DELETE 提交后的刷新窗口仍阻止发送，避免旧快照覆盖新消息', async () => {
    const current = {
      ...conversation('delete-refresh-send-lock'),
      messageCount: 1,
    };
    const target: Message = {
      id: 'delete-refresh-send-target',
      conversationId: current.id,
      role: 'user',
      content: 'remove me',
      createdAt: now,
      status: 'completed',
    };
    const contextRefresh = deferred<typeof emptyContext>();
    const streamChat = vi.fn();
    const transport = {
      getMessageSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          messages: [target],
          messageCount: 1,
          tailMessageId: target.id,
        })
        .mockResolvedValueOnce({
          messages: [],
          messageCount: 0,
          tailMessageId: null,
        }),
      deleteMessage: vi.fn().mockResolvedValue({
        conversation: { ...current, messageCount: 0 },
        removedCount: 1,
      }),
      getContext: vi.fn(() => contextRefresh.promise),
      listSnapshots: vi.fn().mockResolvedValue([]),
      streamChat,
    } as unknown as EAgentTransport;
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      messages: [target],
      context: emptyContext,
    });

    const deleting = useConversationStore.getState().deleteMessage(transport, target.id);
    await vi.waitFor(() => {
      expect(useConversationStore.getState().messages).toEqual([]);
      expect(useConversationStore.getState().messageMutationId).not.toBeNull();
    });

    await expect(
      useConversationStore.getState().send(transport, {
        content: 'must wait for delete refresh',
        model: 'model',
      }),
    ).rejects.toThrow('另一项消息操作正在进行');
    expect(streamChat).not.toHaveBeenCalled();

    contextRefresh.resolve(emptyContext);
    await deleting;
    expect(useConversationStore.getState().messageMutationId).toBeNull();
  });

  it('破坏性删除不校正旧临时 ID，而是刷新并要求用户重新确认', async () => {
    const current = { ...conversation('conversation-legacy-message-id'), messageCount: 2 };
    const localMessages: Message[] = [
      {
        id: 'temporary-user-id',
        conversationId: current.id,
        role: 'user',
        content: 'same prompt',
        createdAt: now,
        status: 'completed',
      },
      {
        id: 'local-assistant-id',
        conversationId: current.id,
        role: 'assistant',
        content: 'same answer',
        createdAt: now,
        status: 'completed',
      },
    ];
    const persistedMessages: Message[] = [
      { ...localMessages[0]!, id: 'persisted-user-id' },
      { ...localMessages[1]!, id: 'persisted-assistant-id' },
    ];
    const deleteMessage = vi.fn();
    const transport = {
      getMessageSnapshot: vi.fn().mockResolvedValue({
        messages: persistedMessages,
        messageCount: 2,
        tailMessageId: 'persisted-assistant-id',
      }),
      deleteMessage,
    } as unknown as EAgentTransport;
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      messages: localMessages,
    });

    await expect(
      useConversationStore.getState().deleteMessage(transport, 'temporary-user-id'),
    ).rejects.toThrow('消息已不存在或会话内容已变化');

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(useConversationStore.getState().messages).toEqual(persistedMessages);
  });

  it('把尚未落库的失败轮次作为本地消息删除，不再请求不存在的消息 ID', async () => {
    const current = { ...conversation('conversation-transient-delete'), messageCount: 0 };
    const localMessages: Message[] = [
      {
        id: 'transient-user',
        conversationId: current.id,
        role: 'user',
        content: 'offline prompt',
        createdAt: now,
        status: 'completed',
      },
      {
        id: 'transient-assistant',
        conversationId: current.id,
        role: 'assistant',
        content: '生成失败，请重试。',
        createdAt: now,
        status: 'failed',
      },
    ];
    const deleteMessage = vi.fn();
    const transport = {
      getMessageSnapshot: vi.fn().mockResolvedValue({
        messages: [],
        messageCount: 0,
        tailMessageId: null,
      }),
      deleteMessage,
    } as unknown as EAgentTransport;
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      messages: localMessages,
    });

    await expect(
      useConversationStore.getState().deleteMessage(transport, 'transient-assistant'),
    ).resolves.toMatchObject({ removedCount: 2, transient: true });

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(useConversationStore.getState().messages).toEqual([]);
  });

  it('反馈保存失败时回滚乐观状态', async () => {
    const current = conversation('conversation-feedback');
    const assistant = {
      id: 'assistant-feedback',
      conversationId: current.id,
      role: 'assistant' as const,
      content: 'answer',
      createdAt: now,
      status: 'completed' as const,
      feedback: 'unhelpful' as const,
    };
    const feedbackResult = deferred<never>();
    const expectedError = new Error('feedback failed');
    const setMessageFeedback = vi.fn(() => feedbackResult.promise);
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      messages: [assistant],
    });

    const pending = useConversationStore
      .getState()
      .setMessageFeedback(
        { setMessageFeedback } as unknown as EAgentTransport,
        assistant.id,
        'helpful',
      );
    const rejection = expect(pending).rejects.toBe(expectedError);
    expect(useConversationStore.getState().messages[0]?.feedback).toBe('helpful');
    feedbackResult.reject(expectedError);
    await rejection;

    expect(setMessageFeedback).toHaveBeenCalledWith(current.id, assistant.id, 'helpful');
    expect(useConversationStore.getState().messages[0]?.feedback).toBe('unhelpful');
  });

  it('把会话列表与内容加载错误转换为状态，并避免旧选择覆盖新选择', async () => {
    const transport = {
      listConversations: vi
        .fn()
        .mockRejectedValueOnce(new Error('list failed'))
        .mockRejectedValueOnce('unknown'),
    } as unknown as EAgentTransport;
    await useConversationStore.getState().loadConversations(transport);
    expect(useConversationStore.getState().error).toBe('list failed');
    await useConversationStore.getState().loadConversations(transport);
    expect(useConversationStore.getState().error).toBe('会话加载失败。');

    const oldMessages = deferred<never[]>();
    const oldContext = deferred<typeof emptyContext>();
    const racingTransport = {
      listMessages: vi.fn((id: string) =>
        id === 'old' ? oldMessages.promise : Promise.resolve([]),
      ),
      getContext: vi.fn((id: string) =>
        id === 'old' ? oldContext.promise : Promise.resolve({ ...emptyContext, usedTokens: 12 }),
      ),
    } as unknown as EAgentTransport;
    const oldSelection = useConversationStore.getState().selectConversation(racingTransport, 'old');
    await useConversationStore.getState().selectConversation(racingTransport, 'new');
    oldMessages.resolve([]);
    oldContext.resolve({ ...emptyContext, usedTokens: 99 });
    await oldSelection;
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: 'new',
      context: expect.objectContaining({ usedTokens: 12 }),
    });

    const staleFailure = deferred<never[]>();
    const staleSelection = useConversationStore.getState().selectConversation(
      {
        listMessages: () => staleFailure.promise,
        getContext: async () => emptyContext,
      } as unknown as EAgentTransport,
      'stale',
    );
    await useConversationStore.getState().selectConversation(racingTransport, 'new');
    staleFailure.reject(new Error('stale error'));
    await staleSelection;
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: 'new',
      error: null,
      loading: false,
    });

    const failedTransport = {
      listMessages: vi
        .fn()
        .mockRejectedValueOnce(new Error('content failed'))
        .mockRejectedValueOnce('unknown'),
      getContext: vi.fn().mockResolvedValue(emptyContext),
    } as unknown as EAgentTransport;
    await useConversationStore.getState().selectConversation(failedTransport, 'failed-one');
    expect(useConversationStore.getState().error).toBe('content failed');
    await useConversationStore.getState().selectConversation(failedTransport, 'failed-two');
    expect(useConversationStore.getState().error).toBe('会话内容加载失败。');
  });

  it('拒绝缺少当前会话的分支与快照操作，并忽略切换后的快照结果', async () => {
    const transport = {} as EAgentTransport;
    await expect(
      useConversationStore.getState().branchConversation(transport, 'message'),
    ).rejects.toThrow('请先选择会话');
    await expect(useConversationStore.getState().createSnapshot(transport)).rejects.toThrow(
      '请先选择会话',
    );
    await expect(
      useConversationStore.getState().restoreSnapshot(transport, 'snapshot'),
    ).rejects.toThrow('请先选择会话');
    await useConversationStore.getState().loadSnapshots(transport);
    expect(useConversationStore.getState()).toMatchObject({
      snapshots: [],
      snapshotsLoading: false,
    });

    const snapshotResult = deferred<{
      id: string;
      conversationId: string;
      messageCount: number;
      createdAt: string;
    }>();
    useConversationStore.setState({ selectedId: 'old', conversations: [conversation('old')] });
    const pending = useConversationStore.getState().createSnapshot({
      createSnapshot: () => snapshotResult.promise,
    } as unknown as EAgentTransport);
    useConversationStore.setState({ selectedId: 'new', snapshots: [] });
    snapshotResult.resolve({
      id: 'late',
      conversationId: 'old',
      messageCount: 1,
      createdAt: now,
    });
    await expect(pending).resolves.toMatchObject({ id: 'late' });
    expect(useConversationStore.getState().snapshots).toEqual([]);
  });

  it('隔离快照加载与恢复的错误和竞态', async () => {
    useConversationStore.setState({
      selectedId: 'old',
      conversations: [conversation('old'), conversation('new')],
    });
    const list = deferred<never[]>();
    const pendingList = useConversationStore.getState().loadSnapshots({
      listSnapshots: () => list.promise,
    } as unknown as EAgentTransport);
    useConversationStore.setState({ selectedId: 'new' });
    list.resolve([]);
    await pendingList;
    expect(useConversationStore.getState().snapshotsLoading).toBe(true);

    useConversationStore.setState({ selectedId: 'current', snapshotsLoading: false });
    const loadError = new Error('snapshot list failed');
    await expect(
      useConversationStore.getState().loadSnapshots({
        listSnapshots: async () => {
          throw loadError;
        },
      } as unknown as EAgentTransport),
    ).rejects.toBe(loadError);
    expect(useConversationStore.getState()).toMatchObject({
      snapshotsLoading: false,
      snapshotError: 'snapshot list failed',
    });
    await expect(
      useConversationStore.getState().loadSnapshots({
        listSnapshots: async () => {
          throw 'unknown';
        },
      } as unknown as EAgentTransport),
    ).rejects.toBe('unknown');
    expect(useConversationStore.getState().snapshotError).toBe('快照历史加载失败。');

    const restoreError = new Error('restore failed');
    await expect(
      useConversationStore.getState().restoreSnapshot(
        {
          restoreSnapshot: async () => {
            throw restoreError;
          },
        } as unknown as EAgentTransport,
        'snapshot',
      ),
    ).rejects.toBe(restoreError);
    expect(useConversationStore.getState()).toMatchObject({
      restoringSnapshotId: null,
      snapshotError: 'restore failed',
    });
    await expect(
      useConversationStore.getState().restoreSnapshot(
        {
          restoreSnapshot: async () => {
            throw 'unknown';
          },
        } as unknown as EAgentTransport,
        'snapshot',
      ),
    ).rejects.toBe('unknown');
    expect(useConversationStore.getState().snapshotError).toBe('快照恢复失败。');
  });

  it('消费所有流事件、合并工具与文件变更，并保留刷新失败后的结果', async () => {
    const selected = conversation('stream-events');
    useConversationStore.setState({ selectedId: selected.id, conversations: [selected] });
    let request: unknown;
    const transport = {
      streamChat: async function* (input: unknown) {
        request = input;
        yield { type: 'start' as const, requestId: 'request' };
        yield { type: 'reasoning' as const, requestId: 'request', delta: '思考：' };
        yield { type: 'delta' as const, requestId: 'request', delta: '回答' };
        yield { type: 'tool_call' as const, requestId: 'request' };
        yield {
          type: 'tool_call' as const,
          requestId: 'request',
          toolCall: {
            id: 'running',
            name: 'tool',
            arguments: '{}',
            status: 'running' as const,
          },
        };
        yield {
          type: 'tool_call' as const,
          requestId: 'request',
          toolCall: {
            id: 'completed',
            name: 'tool',
            arguments: '{}',
            status: 'running' as const,
          },
        };
        yield {
          type: 'tool_call' as const,
          requestId: 'request',
          toolCall: {
            id: 'completed',
            name: 'tool',
            arguments: '{}',
            status: 'completed' as const,
          },
        };
        yield { type: 'file_change' as const, requestId: 'request' };
        yield {
          type: 'file_change' as const,
          requestId: 'request',
          fileChange: {
            id: 'change',
            path: 'src/index.ts',
            diff: '@@',
            status: 'pending' as const,
          },
        };
        yield {
          type: 'usage' as const,
          requestId: 'request',
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cost: 0.1,
            latencyMs: 5,
            reasoningDurationMs: 13_000,
          },
        };
        yield { type: 'done' as const, requestId: 'request' };
        yield { type: 'error' as const, requestId: 'request', message: 'late error' };
      },
      listMessages: async () => {
        throw new Error('refresh failed');
      },
      getContext: async () => emptyContext,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: '  检查 @file:src/index.ts  ',
      model: 'model',
      skill: '@review',
      compareModels: ['one', 'two'],
    });

    expect(request).toEqual(
      expect.objectContaining({
        content: '检查 @file:src/index.ts',
        contextMentions: ['@file:src/index.ts'],
        skill: '@review',
        compareModels: ['one', 'two'],
      }),
    );
    const assistant = useConversationStore.getState().messages.at(-1);
    expect(assistant).toMatchObject({
      content: '回答',
      reasoning: '思考：',
      reasoningDurationMs: 13_000,
      status: 'failed',
      inputTokens: 2,
      outputTokens: 3,
      latencyMs: 5,
      toolCalls: [
        expect.objectContaining({ id: 'running', status: 'approval-required' }),
        expect.objectContaining({ id: 'completed', status: 'completed' }),
      ],
      fileChanges: [expect.objectContaining({ id: 'change' })],
    });
    expect(useConversationStore.getState().error).toBeNull();
  });

  it('流错误后的持久化刷新保留失败状态与错误说明', async () => {
    const selected = conversation('stream-error-persisted');
    useConversationStore.setState({ selectedId: selected.id, conversations: [selected] });
    let request: ChatRequest | undefined;
    const transport = {
      streamChat: async function* (input: ChatRequest) {
        request = input;
        yield {
          type: 'start' as const,
          requestId: 'failed-request',
          messageId: 'persisted-failed-assistant',
        };
        yield {
          type: 'error' as const,
          requestId: 'failed-request',
          message: '提供商暂时不可用',
        };
      },
      listMessages: async () => [
        {
          id: request?.userMessageId ?? '',
          conversationId: selected.id,
          role: 'user' as const,
          content: 'test persisted failure',
          createdAt: now,
          status: 'completed' as const,
        },
        {
          id: 'persisted-failed-assistant',
          conversationId: selected.id,
          role: 'assistant' as const,
          content: '',
          createdAt: now,
          status: 'completed' as const,
        },
      ],
      getContext: async () => emptyContext,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: 'test persisted failure',
      model: 'model',
    });

    expect(useConversationStore.getState().messages.at(-1)).toMatchObject({
      id: 'persisted-failed-assistant',
      content: '提供商暂时不可用',
      status: 'failed',
    });
  });

  it('开始流之前失败且整轮未落库时可直接重试，不创建无效分支', async () => {
    const selected = conversation('prestart-retry');
    useConversationStore.setState({ selectedId: selected.id, conversations: [selected] });
    let streamCount = 0;
    const branchConversation = vi.fn();
    const transport = {
      streamChat: async function* () {
        streamCount += 1;
        if (streamCount === 1) throw new Error('offline before start');
        yield {
          type: 'start' as const,
          requestId: 'retry-after-offline',
          messageId: 'retry-after-offline-assistant',
        };
        yield {
          type: 'delta' as const,
          requestId: 'retry-after-offline',
          delta: '恢复成功',
        };
        yield { type: 'done' as const, requestId: 'retry-after-offline' };
      },
      listMessages: vi.fn(() =>
        Promise.resolve(streamCount === 1 ? [] : useConversationStore.getState().messages),
      ),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      branchConversation,
    } as unknown as EAgentTransport;

    await expect(
      useConversationStore.getState().send(transport, {
        content: 'retry me',
        model: 'model',
      }),
    ).rejects.toThrow('offline before start');
    const failedAssistant = useConversationStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(failedAssistant?.status).toBe('failed');

    await useConversationStore
      .getState()
      .retryMessage(transport, failedAssistant?.id ?? '', { model: 'model' });

    expect(branchConversation).not.toHaveBeenCalled();
    expect(streamCount).toBe(2);
    expect(useConversationStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'retry me' }),
      expect.objectContaining({
        id: 'retry-after-offline-assistant',
        role: 'assistant',
        content: '恢复成功',
        status: 'completed',
      }),
    ]);
  });

  it('会话级消息操作锁拒绝并发重试，避免提示词串入另一分支', async () => {
    const selected = conversation('concurrent-retry-lock');
    const otherConversation = conversation('concurrent-retry-other');
    const userMessage: Message = {
      id: 'concurrent-retry-user',
      conversationId: selected.id,
      role: 'user',
      content: 'retry once',
      createdAt: now,
      status: 'completed',
    };
    const failedAssistant: Message = {
      id: 'concurrent-retry-assistant',
      conversationId: selected.id,
      role: 'assistant',
      content: 'failed',
      createdAt: now,
      status: 'failed',
    };
    useConversationStore.setState({
      conversations: [selected, otherConversation],
      selectedId: selected.id,
      messages: [userMessage, failedAssistant],
    });
    const firstRefresh = deferred<Message[]>();
    const listMessages = vi
      .fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue([]);
    const streamChat = vi.fn(async function* () {
      yield {
        type: 'start' as const,
        requestId: 'locked-retry',
        messageId: 'locked-retry-answer',
      };
      yield { type: 'done' as const, requestId: 'locked-retry' };
    });
    const transport = {
      listMessages,
      getContext: vi.fn().mockResolvedValue(emptyContext),
      streamChat,
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
    } as unknown as EAgentTransport;

    const firstRetry = useConversationStore
      .getState()
      .retryMessage(transport, failedAssistant.id, { model: 'model' });
    await expect(
      useConversationStore
        .getState()
        .retryMessage(transport, failedAssistant.id, { model: 'model' }),
    ).rejects.toThrow('另一项消息操作正在进行');
    await expect(
      useConversationStore.getState().selectConversation(transport, otherConversation.id),
    ).rejects.toThrow('另一项消息操作正在进行');
    await expect(useConversationStore.getState().createConversation(transport)).rejects.toThrow(
      '另一项消息操作正在进行',
    );
    await expect(
      useConversationStore.getState().deleteConversation(transport, selected.id),
    ).rejects.toThrow('另一项消息操作正在进行');
    await expect(
      useConversationStore.getState().send(transport, {
        content: 'must not send during retry',
        model: 'model',
      }),
    ).rejects.toThrow('另一项消息操作正在进行');
    expect(useConversationStore.getState().selectedId).toBe(selected.id);
    expect(transport.createConversation).not.toHaveBeenCalled();
    expect(transport.deleteConversation).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();

    firstRefresh.resolve([]);
    await firstRetry;
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().messageMutationId).toBeNull();
  });

  it('以乐观状态提交工具决策，执行完成后合并规范化结果', async () => {
    const completion = deferred<ToolCall>();
    useConversationStore.setState({
      selectedId: 'tools',
      messages: [
        {
          id: 'assistant',
          conversationId: 'tools',
          role: 'assistant',
          content: '',
          createdAt: now,
          status: 'completed',
          toolCalls: [
            {
              id: 'tool',
              name: 'workspace_run_command',
              arguments: '{"executable":"pnpm"}',
              status: 'approval-required',
            },
          ],
        },
      ],
    });
    const executeToolCall = vi.fn(() => completion.promise);
    const transport = {
      executeToolCall,
      listMessages: async () => {
        throw new Error('refresh failed');
      },
    } as unknown as EAgentTransport;

    const decision = useConversationStore
      .getState()
      .decideToolCall(transport, 'tools', 'tool', 'approve');
    expect(useConversationStore.getState().messages[0]?.toolCalls?.[0]?.status).toBe('running');

    completion.resolve({
      id: 'tool',
      name: 'workspace_run_command',
      arguments: '{"executable":"pnpm"}',
      status: 'completed',
      result: 'Tests passed',
      durationMs: 84,
      metadata: { kind: 'command', exitCode: 0 },
    });
    await decision;

    expect(executeToolCall).toHaveBeenCalledWith('tools', 'tool', 'approve');
    expect(useConversationStore.getState().messages[0]?.toolCalls?.[0]).toMatchObject({
      status: 'completed',
      result: 'Tests passed',
      durationMs: 84,
      metadata: { kind: 'command', exitCode: 0 },
    });
  });

  it('工具审批完成后把结果续传给模型，并将后续回答追加到原会话', async () => {
    useConversationStore.setState({
      selectedId: 'tools',
      messages: [
        {
          id: 'assistant',
          conversationId: 'tools',
          role: 'assistant',
          content: '',
          createdAt: now,
          model: 'model-with-tools',
          status: 'completed',
          toolCalls: [
            {
              id: 'tool',
              name: 'mcp_memory_search',
              arguments: '{"query":"architecture"}',
              status: 'approval-required',
            },
          ],
        },
      ],
    });
    let continuationRequest: ChatRequest | undefined;
    const transport = {
      executeToolCall: async () => ({
        id: 'tool',
        name: 'mcp_memory_search',
        arguments: '{"query":"architecture"}',
        status: 'completed' as const,
        result: 'memory result',
        metadata: { continuationToolCallId: 'tool' },
      }),
      listMessages: async () => useConversationStore.getState().messages,
      getContext: async () => null,
      streamChat: async function* (request: ChatRequest) {
        continuationRequest = request;
        yield { type: 'start' as const, requestId: 'continue', messageId: 'continued-answer' };
        yield { type: 'delta' as const, requestId: 'continue', delta: '已分析工具结果。' };
        yield { type: 'done' as const, requestId: 'continue' };
      },
    } as unknown as EAgentTransport;

    await useConversationStore.getState().decideToolCall(transport, 'tools', 'tool', 'approve');

    expect(continuationRequest).toEqual({
      conversationId: 'tools',
      content: '',
      model: 'model-with-tools',
      continuationToolCallId: 'tool',
      contextMentions: [],
    });
    expect(useConversationStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'continued-answer',
          content: '已分析工具结果。',
          status: 'completed',
        }),
      ]),
    );
  });

  it('只使用主进程签发的组续写标识，并对同一工具组最多续写一次', async () => {
    const conversationId = 'multi-tools-continuation';
    useConversationStore.setState({
      selectedId: conversationId,
      messages: [
        {
          id: 'assistant-multi-tools',
          conversationId,
          role: 'assistant',
          content: '',
          createdAt: now,
          model: 'model-with-tools',
          status: 'completed',
          toolCalls: [
            {
              id: 'tool-a',
              name: 'workspace_run_command',
              arguments: '{"executable":"pnpm"}',
              status: 'approval-required',
            },
            {
              id: 'tool-b',
              name: 'computer_list_processes',
              arguments: '{"query":"node"}',
              status: 'approval-required',
            },
          ],
        },
      ],
    });
    const continuationRequests: ChatRequest[] = [];
    const transport = {
      executeToolCall: async (_conversationId: string, toolCallId: string) => ({
        id: toolCallId,
        name: toolCallId === 'tool-a' ? 'workspace_run_command' : 'computer_list_processes',
        arguments: '{}',
        status: 'completed' as const,
        ...(toolCallId === 'tool-a' ? { metadata: { continuationToolCallId: 'tool-a' } } : {}),
      }),
      listMessages: async () => useConversationStore.getState().messages,
      getContext: async () => null,
      streamChat: async function* (request: ChatRequest) {
        continuationRequests.push(request);
        yield { type: 'start' as const, requestId: 'continue', messageId: crypto.randomUUID() };
        yield { type: 'done' as const, requestId: 'continue' };
      },
    } as unknown as EAgentTransport;

    await useConversationStore
      .getState()
      .decideToolCall(transport, conversationId, 'tool-b', 'approve');
    expect(continuationRequests).toHaveLength(0);

    await useConversationStore
      .getState()
      .decideToolCall(transport, conversationId, 'tool-a', 'approve');
    await useConversationStore
      .getState()
      .decideToolCall(transport, conversationId, 'tool-a', 'approve');

    expect(continuationRequests).toHaveLength(1);
    expect(continuationRequests[0]?.continuationToolCallId).toBe('tool-a');
  });

  it('工具续写流失败后释放界面侧 claim，允许服务端签发的同一标识重试', async () => {
    const conversationId = 'tool-continuation-retry';
    useConversationStore.setState({
      selectedId: conversationId,
      messages: [
        {
          id: 'assistant-retry-tool',
          conversationId,
          role: 'assistant',
          content: '',
          createdAt: now,
          model: 'retry-model',
          status: 'completed',
          toolCalls: [
            {
              id: 'retry-tool',
              name: 'workspace_run_command',
              arguments: '{}',
              status: 'approval-required',
            },
          ],
        },
      ],
    });
    let continuationRequests = 0;
    const transport = {
      executeToolCall: async () => ({
        id: 'retry-tool',
        name: 'workspace_run_command',
        arguments: '{}',
        status: 'completed' as const,
        metadata: { continuationToolCallId: 'retry-tool' },
      }),
      listMessages: async () => useConversationStore.getState().messages,
      getContext: async () => null,
      streamChat: async function* () {
        continuationRequests += 1;
        yield { type: 'start' as const, requestId: 'retry', messageId: crypto.randomUUID() };
        if (continuationRequests === 1) {
          yield { type: 'error' as const, requestId: 'retry', message: 'provider unavailable' };
          return;
        }
        yield { type: 'done' as const, requestId: 'retry' };
      },
    } as unknown as EAgentTransport;

    await useConversationStore
      .getState()
      .decideToolCall(transport, conversationId, 'retry-tool', 'approve');
    await useConversationStore
      .getState()
      .decideToolCall(transport, conversationId, 'retry-tool', 'approve');

    expect(continuationRequests).toBe(2);
  });

  it('工具决策失败时恢复等待确认状态', async () => {
    const executionError = new Error('approval failed');
    useConversationStore.setState({
      selectedId: 'tools',
      messages: [
        {
          id: 'assistant',
          conversationId: 'tools',
          role: 'assistant',
          content: '',
          createdAt: now,
          toolCalls: [
            {
              id: 'tool',
              name: 'workspace_run_command',
              arguments: '{}',
              status: 'approval-required',
              metadata: { kind: 'command' },
            },
          ],
        },
      ],
    });

    await expect(
      useConversationStore.getState().decideToolCall(
        {
          executeToolCall: async () => {
            throw executionError;
          },
        } as unknown as EAgentTransport,
        'tools',
        'tool',
        'approve',
      ),
    ).rejects.toBe(executionError);
    expect(useConversationStore.getState().messages[0]?.toolCalls?.[0]).toMatchObject({
      status: 'approval-required',
      metadata: { kind: 'command' },
    });
  });

  it('处理流异常、非 Error、主动停止以及空输入和重复发送', async () => {
    useConversationStore.setState({
      selectedId: 'errors',
      conversations: [conversation('errors')],
    });
    const throwTransport = (reason: unknown) =>
      ({
        streamChat: async function* () {
          throw reason;
          yield { type: 'done' as const, requestId: 'never' };
        },
      }) as unknown as EAgentTransport;
    await expect(
      useConversationStore.getState().send(throwTransport(new Error('send failed')), {
        content: 'first',
        model: 'model',
      }),
    ).rejects.toThrow('send failed');
    expect(useConversationStore.getState()).toMatchObject({
      error: 'send failed',
      streaming: false,
      abortController: null,
    });
    expect(useConversationStore.getState().messages.at(-1)).toMatchObject({
      content: '生成失败，请重试。',
      status: 'failed',
    });

    await expect(
      useConversationStore.getState().send(throwTransport('unknown'), {
        content: 'second',
        model: 'model',
      }),
    ).rejects.toBe('unknown');
    expect(useConversationStore.getState().error).toBe('消息发送失败。');

    const abortTransport = {
      streamChat: async function* (_input: unknown, signal: AbortSignal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield { type: 'done' as const, requestId: 'never' };
      },
    } as unknown as EAgentTransport;
    const sending = useConversationStore.getState().send(abortTransport, {
      content: 'stop me',
      model: 'model',
    });
    useConversationStore.getState().stop();
    await expect(sending).resolves.toBeUndefined();
    expect(useConversationStore.getState()).toMatchObject({ error: null, streaming: false });
    expect(useConversationStore.getState().messages.at(-1)).toMatchObject({
      content: '生成已停止。',
      status: 'cancelled',
    });

    const listMessages = vi.fn().mockResolvedValue([]);
    const desktopAbortTransport = {
      streamChat: async function* (_input: unknown, signal: AbortSignal) {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return;
        yield { type: 'done' as const, requestId: 'never' };
      },
      listMessages,
    } as unknown as EAgentTransport;
    const desktopSending = useConversationStore.getState().send(desktopAbortTransport, {
      content: 'desktop stop',
      model: 'model',
    });
    useConversationStore.getState().stop();
    await expect(desktopSending).resolves.toBeUndefined();
    expect(useConversationStore.getState().messages.at(-1)).toMatchObject({
      content: '生成已停止。',
      status: 'cancelled',
    });
    expect(listMessages).not.toHaveBeenCalled();

    const streamChat = vi.fn();
    await useConversationStore.getState().send({ streamChat } as unknown as EAgentTransport, {
      content: '   ',
      model: 'model',
    });
    useConversationStore.setState({ streaming: true });
    await useConversationStore.getState().send({ streamChat } as unknown as EAgentTransport, {
      content: 'ignored',
      model: 'model',
    });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('流式响应落库后刷新会话摘要并显示后端生成的标题', async () => {
    const current = { ...conversation('generated-title'), title: '新会话' };
    const refreshed = {
      ...current,
      title: '解释并修复登录状态竞态',
      messageCount: 2,
      updatedAt: '2026-07-28T10:01:00.000Z',
    };
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const getConversation = vi.fn().mockResolvedValue(refreshed);
    const transport = {
      streamChat: async function* () {
        yield { type: 'done' as const, requestId: 'generated-title' };
      },
      listMessages: vi.fn(async () => useConversationStore.getState().messages),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      getConversation,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: '请解释并修复登录状态竞态',
      model: 'model',
    });

    expect(getConversation).toHaveBeenCalledWith(current.id);
    expect(useConversationStore.getState().conversations).toEqual([refreshed]);
  });

  it('流后摘要刷新不覆盖刷新期间完成的手动重命名', async () => {
    const current = { ...conversation('generated-title-race'), title: '新会话' };
    const staleSummary = {
      ...current,
      title: '后端自动标题',
      messageCount: 2,
    };
    const summaryRefresh = deferred<ReturnType<typeof conversation>[]>();
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const transport = {
      streamChat: async function* () {
        yield { type: 'done' as const, requestId: 'generated-title-race' };
      },
      listMessages: vi.fn(async () => useConversationStore.getState().messages),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      getConversation: vi.fn(() =>
        summaryRefresh.promise.then((conversations) => conversations[0]!),
      ),
    } as unknown as EAgentTransport;
    const sending = useConversationStore.getState().send(transport, {
      content: '生成一个标题',
      model: 'model',
    });
    await vi.waitFor(() =>
      expect(transport.getConversation as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce(),
    );

    await useConversationStore.getState().updateConversation(
      {
        updateConversation: vi.fn().mockResolvedValue({
          ...current,
          title: '用户保留的标题',
        }),
      } as unknown as EAgentTransport,
      current.id,
      { title: '用户保留的标题' },
    );
    summaryRefresh.resolve([staleSummary]);
    await sending;

    expect(useConversationStore.getState().conversations[0]?.title).toBe('用户保留的标题');
  });

  it('同一会话重叠刷新时丢弃先返回的旧摘要并采用最新响应', async () => {
    const current = { ...conversation('generated-title-overlap'), title: '新会话' };
    const staleSummary = {
      ...current,
      title: '旧摘要标题',
      messageCount: 1,
    };
    const latestSummary = {
      ...current,
      title: '最新摘要标题',
      messageCount: 2,
    };
    const staleRefresh = deferred<typeof staleSummary>();
    const latestRefresh = deferred<typeof latestSummary>();
    const getConversation = vi
      .fn()
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockImplementationOnce(() => latestRefresh.promise);
    const transport = { getConversation } as unknown as EAgentTransport;
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });

    const staleRequest = useConversationStore
      .getState()
      .refreshConversationSummary(transport, current.id);
    const latestRequest = useConversationStore
      .getState()
      .refreshConversationSummary(transport, current.id);
    expect(getConversation).toHaveBeenCalledTimes(2);

    staleRefresh.resolve(staleSummary);
    await staleRequest;
    expect(useConversationStore.getState().conversations[0]).toBe(current);

    latestRefresh.resolve(latestSummary);
    await latestRequest;
    expect(useConversationStore.getState().conversations[0]).toEqual(latestSummary);
  });

  it('刷新期间更新其他会话仍合并目标会话的自动标题', async () => {
    const current = { ...conversation('generated-title-target'), title: '新会话' };
    const other = { ...conversation('generated-title-other'), title: '其他会话' };
    const refreshed = {
      ...current,
      title: '目标会话自动标题',
      messageCount: 2,
    };
    const summaryRefresh = deferred<typeof refreshed>();
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current, other],
    });
    const transport = {
      streamChat: async function* () {
        yield { type: 'done' as const, requestId: 'generated-title-unrelated-race' };
      },
      listMessages: vi.fn(async () => useConversationStore.getState().messages),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      getConversation: vi.fn(() => summaryRefresh.promise),
    } as unknown as EAgentTransport;
    const sending = useConversationStore.getState().send(transport, {
      content: '生成目标标题',
      model: 'model',
    });
    await vi.waitFor(() =>
      expect(transport.getConversation as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce(),
    );

    await useConversationStore.getState().updateConversation(
      {
        updateConversation: vi.fn().mockResolvedValue({
          ...other,
          pinned: true,
        }),
      } as unknown as EAgentTransport,
      other.id,
      { pinned: true },
    );
    summaryRefresh.resolve(refreshed);
    await sending;

    expect(useConversationStore.getState().conversations).toEqual([
      refreshed,
      { ...other, pinned: true },
    ]);
  });

  it('主动取消后仍以目标身份保护方式刷新已落库的自动标题', async () => {
    const current = { ...conversation('generated-title-abort'), title: '新会话' };
    const refreshed = {
      ...current,
      title: '取消后仍可见的标题',
      messageCount: 1,
    };
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const summaryRefresh = deferred<typeof refreshed>();
    const getConversation = vi.fn(() => summaryRefresh.promise);
    const transport = {
      streamChat: async function* (_input: unknown, signal: AbortSignal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield { type: 'done' as const, requestId: 'never' };
      },
      getConversation,
    } as unknown as EAgentTransport;

    const sending = useConversationStore.getState().send(transport, {
      content: '首轮消息随后取消',
      model: 'model',
    });
    useConversationStore.getState().stop();
    await vi.waitFor(() => expect(getConversation).toHaveBeenCalledWith(current.id));
    expect(useConversationStore.getState()).toMatchObject({
      streaming: false,
      error: null,
      conversations: [current],
    });
    expect(useConversationStore.getState().messages.at(-1)?.status).toBe('cancelled');
    summaryRefresh.resolve(refreshed);
    await expect(sending).resolves.toBeUndefined();

    expect(useConversationStore.getState().conversations[0]).toEqual(refreshed);
  });

  it('用持久化消息刷新成功结果，但不让旧会话刷新覆盖当前会话', async () => {
    useConversationStore.setState({
      selectedId: 'persisted',
      conversations: [conversation('persisted'), conversation('new')],
    });
    const messages = deferred<
      Array<{
        id: string;
        conversationId: string;
        role: 'assistant';
        content: string;
        createdAt: string;
      }>
    >();
    const context = deferred<typeof emptyContext>();
    const listMessages = vi.fn(() => messages.promise);
    const transport = {
      streamChat: async function* () {
        yield { type: 'done' as const, requestId: 'done' };
      },
      listMessages,
      getContext: () => context.promise,
    } as unknown as EAgentTransport;
    const sending = useConversationStore.getState().send(transport, {
      content: 'persist',
      model: 'model',
    });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    expect(useConversationStore.getState().streaming).toBe(true);
    useConversationStore.setState({ selectedId: 'new', messages: [] });
    messages.resolve([
      {
        id: 'persisted-message',
        conversationId: 'persisted',
        role: 'assistant',
        content: 'persisted',
        createdAt: now,
      },
    ]);
    context.resolve({ ...emptyContext, usedTokens: 50 });
    await sending;
    expect(useConversationStore.getState()).toMatchObject({
      selectedId: 'new',
      streaming: false,
      messages: [],
      context: null,
    });
  });

  it('切换会话后再返回时不让已取消的旧刷新覆盖新状态', async () => {
    const original = conversation('post-stream-aba');
    const other = conversation('post-stream-aba-other');
    useConversationStore.setState({
      selectedId: original.id,
      conversations: [original, other],
    });
    const staleMessages = deferred<Message[]>();
    const staleContext = deferred<typeof emptyContext>();
    const streamTransport = {
      streamChat: async function* () {
        yield { type: 'done' as const, requestId: 'post-stream-aba' };
      },
      listMessages: vi.fn(() => staleMessages.promise),
      getContext: vi.fn(() => staleContext.promise),
    } as unknown as EAgentTransport;
    const sending = useConversationStore.getState().send(streamTransport, {
      content: 'old request',
      model: 'model',
    });
    await vi.waitFor(() =>
      expect(streamTransport.listMessages as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce(),
    );

    const freshMessage: Message = {
      id: 'post-stream-aba-fresh',
      conversationId: original.id,
      role: 'assistant',
      content: 'fresh state',
      createdAt: now,
      status: 'completed',
    };
    const navigationTransport = {
      listMessages: vi.fn((id: string) =>
        Promise.resolve(id === original.id ? [freshMessage] : []),
      ),
      getContext: vi.fn((id: string) =>
        Promise.resolve({
          ...emptyContext,
          usedTokens: id === original.id ? 21 : 10,
        }),
      ),
    } as unknown as EAgentTransport;

    await useConversationStore.getState().selectConversation(navigationTransport, other.id);
    await useConversationStore.getState().selectConversation(navigationTransport, original.id);
    staleMessages.resolve([
      {
        ...freshMessage,
        id: 'post-stream-aba-stale',
        content: 'stale state',
      },
    ]);
    staleContext.resolve({ ...emptyContext, usedTokens: 99 });
    await sending;

    expect(useConversationStore.getState()).toMatchObject({
      selectedId: original.id,
      streaming: false,
      messages: [freshMessage],
      context: { ...emptyContext, usedTokens: 21 },
    });
  });

  it('权威消息刷新为空时移除已被协作端删除的乐观消息', async () => {
    const current = conversation('authoritative-empty-refresh');
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const transport = {
      streamChat: async function* () {
        yield {
          type: 'start' as const,
          requestId: 'authoritative-empty',
          messageId: 'authoritative-empty-assistant',
        };
        yield {
          type: 'delta' as const,
          requestId: 'authoritative-empty',
          delta: 'will be deleted remotely',
        };
        yield { type: 'done' as const, requestId: 'authoritative-empty' };
      },
      listMessages: vi.fn().mockResolvedValue([]),
      getContext: vi.fn().mockResolvedValue(emptyContext),
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: 'delete this turn from another client',
      model: 'model',
    });

    expect(useConversationStore.getState()).toMatchObject({
      streaming: false,
      messages: [],
      context: emptyContext,
    });
  });

  it('上下文刷新失败时仍应用已成功返回的权威空消息列表', async () => {
    const current = conversation('authoritative-empty-context-failure');
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const transport = {
      streamChat: async function* () {
        yield {
          type: 'delta' as const,
          requestId: 'authoritative-empty-context-failure',
          delta: 'deleted remotely',
        };
        yield {
          type: 'done' as const,
          requestId: 'authoritative-empty-context-failure',
        };
      },
      listMessages: vi.fn().mockResolvedValue([]),
      getContext: vi.fn().mockRejectedValue(new Error('context unavailable')),
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: 'remote deletion with context failure',
      model: 'model',
    });

    expect(useConversationStore.getState()).toMatchObject({
      streaming: false,
      messages: [],
      context: null,
      error: null,
    });
  });

  it('流结束后的持久化同步完成前保持忙碌，并在同步后安全发送排队消息', async () => {
    const current = conversation('stream-settlement-barrier');
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
    });
    const firstMessages = deferred<Message[]>();
    const firstContext = deferred<typeof emptyContext>();
    const requests: ChatRequest[] = [];
    const listMessages = vi.fn(() =>
      listMessages.mock.calls.length === 1
        ? firstMessages.promise
        : Promise.resolve(useConversationStore.getState().messages),
    );
    let contextRequests = 0;
    const transport = {
      streamChat: async function* (request: ChatRequest) {
        requests.push(request);
        const turn = requests.length;
        yield {
          type: 'start' as const,
          requestId: `settlement-${String(turn)}`,
          messageId: `settlement-assistant-${String(turn)}`,
        };
        yield {
          type: 'delta' as const,
          requestId: `settlement-${String(turn)}`,
          delta: `answer-${String(turn)}`,
        };
        yield { type: 'done' as const, requestId: `settlement-${String(turn)}` };
      },
      listMessages,
      getContext: vi.fn(() => {
        contextRequests += 1;
        return contextRequests === 1 ? firstContext.promise : Promise.resolve(emptyContext);
      }),
    } as unknown as EAgentTransport;

    const firstSend = useConversationStore.getState().send(transport, {
      content: 'first prompt',
      model: 'model',
    });
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    expect(useConversationStore.getState().streaming).toBe(true);

    await useConversationStore.getState().send(transport, {
      content: 'second prompt',
      model: 'model',
    });
    expect(requests).toHaveLength(1);
    expect(useConversationStore.getState().queuedPrompts).toHaveLength(1);

    firstMessages.resolve([
      {
        id: requests[0]?.userMessageId ?? 'missing-user-id',
        conversationId: current.id,
        role: 'user',
        content: 'first prompt',
        createdAt: now,
        status: 'completed',
      },
      {
        id: 'settlement-assistant-1',
        conversationId: current.id,
        role: 'assistant',
        content: 'answer-1',
        createdAt: now,
        status: 'completed',
      },
    ]);
    firstContext.resolve(emptyContext);
    await firstSend;
    expect(useConversationStore.getState().streaming).toBe(false);

    await useConversationStore.getState().sendNextQueued(transport);
    expect(requests).toHaveLength(2);
    expect(useConversationStore.getState().queuedPrompts).toEqual([]);
    expect(useConversationStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'first prompt' }),
      expect.objectContaining({ role: 'assistant', content: 'answer-1' }),
      expect.objectContaining({ role: 'user', content: 'second prompt' }),
      expect.objectContaining({ role: 'assistant', content: 'answer-2' }),
    ]);
  });

  it('生成期间管理下一轮队列，并在空闲后按调整后的顺序发送', async () => {
    const current = conversation('queued-conversation');
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
      streaming: true,
    });
    const transport = {
      streamChat: vi.fn(async function* (request: { content: string }) {
        yield { type: 'done' as const, requestId: request.content };
      }),
      listMessages: vi.fn().mockResolvedValue([]),
      getContext: vi.fn().mockResolvedValue(emptyContext),
    } as unknown as EAgentTransport;

    await useConversationStore.getState().send(transport, {
      content: 'first queued',
      model: 'model',
    });
    await useConversationStore.getState().send(transport, {
      content: 'second queued',
      model: 'model',
    });
    const [first, second] = useConversationStore.getState().queuedPrompts;
    expect([first?.input.content, second?.input.content]).toEqual([
      'first queued',
      'second queued',
    ]);
    if (!first || !second) throw new Error('queue setup failed');
    useConversationStore.getState().updateQueuedPrompt(first.id, 'edited first');
    useConversationStore.getState().moveQueuedPrompt(second.id, -1);
    useConversationStore.setState({ streaming: false });

    await useConversationStore.getState().sendNextQueued(transport);

    expect(transport.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'second queued' }),
      expect.any(AbortSignal),
    );
    expect(useConversationStore.getState().queuedPrompts).toMatchObject([
      { input: { content: 'edited first' } },
    ]);
    useConversationStore.getState().removeQueuedPrompt(first.id);
    expect(useConversationStore.getState().queuedPrompts).toEqual([]);
  });

  it('更新文件变更决策、队列状态并保留辅助刷新失败前的值', async () => {
    const fileMessage = {
      id: 'assistant',
      conversationId: 'files',
      role: 'assistant' as const,
      content: 'change',
      createdAt: now,
      fileChanges: [
        { id: 'target', path: 'a.ts', diff: '@@', status: 'pending' as const },
        { id: 'other', path: 'b.ts', diff: '@@', status: 'pending' as const },
      ],
    };
    const decideFileChange = vi.fn().mockResolvedValue(undefined);
    useConversationStore.setState({ selectedId: null, messages: [fileMessage] });
    await useConversationStore
      .getState()
      .decideFileChange({ decideFileChange } as unknown as EAgentTransport, 'target', 'accept');
    expect(decideFileChange).not.toHaveBeenCalled();

    useConversationStore.setState({ selectedId: 'files' });
    await useConversationStore
      .getState()
      .decideFileChange({ decideFileChange } as unknown as EAgentTransport, 'target', 'accept');
    expect(useConversationStore.getState().messages[0]?.fileChanges).toEqual([
      expect.objectContaining({ id: 'target', status: 'accepted' }),
      expect.objectContaining({ id: 'other', status: 'pending' }),
    ]);
    await useConversationStore
      .getState()
      .decideFileChange({ decideFileChange } as unknown as EAgentTransport, 'target', 'reject');
    expect(useConversationStore.getState().messages[0]?.fileChanges?.[0]?.status).toBe('accepted');
    expect(decideFileChange).toHaveBeenCalledOnce();
    expect(decideFileChange).toHaveBeenCalledWith('files', 'target', 'accept');

    await useConversationStore.getState().refreshQueue({
      getQueueStatus: async () => ({ running: 2, queued: 3, position: 1 }),
    } as unknown as EAgentTransport);
    expect(useConversationStore.getState().queue).toEqual({ running: 2, queued: 3, position: 1 });
    await useConversationStore.getState().refreshQueue({
      getQueueStatus: async () => {
        throw new Error('optional status failed');
      },
    } as unknown as EAgentTransport);
    expect(useConversationStore.getState().queue).toEqual({ running: 2, queued: 3, position: 1 });
    useConversationStore.setState({ error: 'old' });
    useConversationStore.getState().clearError();
    expect(useConversationStore.getState().error).toBeNull();
  });

  it('文件变更审批后刷新父工具卡，并用父工具和模型继续桌面对话', async () => {
    const parentMessage: Message = {
      id: 'assistant-file-change',
      conversationId: 'files',
      role: 'assistant',
      content: '',
      createdAt: now,
      model: 'model-with-file-tools',
      status: 'completed',
      toolCalls: [
        {
          id: 'file-tool',
          name: 'workspace_propose_write',
          arguments: '{"path":"src/generated.ts","content":"export {}"}',
          status: 'approval-required',
          result: '@@ -0,0 +1 @@\n+export {}',
          metadata: { kind: 'file-change', changeId: 'file-change' },
        },
      ],
      fileChanges: [
        {
          id: 'file-change',
          path: 'src/generated.ts',
          diff: '@@ -0,0 +1 @@\n+export {}',
          status: 'pending',
        },
      ],
    };
    useConversationStore.setState({ selectedId: 'files', messages: [parentMessage] });

    let continuationRequest: ChatRequest | undefined;
    const decideFileChange = vi.fn().mockResolvedValue({
      id: 'file-tool',
      name: 'workspace_propose_write',
      arguments: '{"path":"src/generated.ts","content":"export {}"}',
      status: 'completed',
      result: '服务端确认的 Diff',
      durationMs: 24,
      metadata: {
        kind: 'file-change',
        changeId: 'file-change',
        path: 'src/generated.ts',
        continuationToolCallId: 'file-tool',
      },
    });
    const listMessages = vi.fn().mockRejectedValue(new Error('refresh unavailable'));
    const transport = {
      kind: 'desktop',
      decideFileChange,
      listMessages,
      getContext: async () => emptyContext,
      streamChat: async function* (request: ChatRequest) {
        continuationRequest = request;
        yield {
          type: 'start' as const,
          requestId: 'file-continuation',
          messageId: 'file-continuation-message',
        };
        yield {
          type: 'delta' as const,
          requestId: 'file-continuation',
          delta: '文件已更新。',
        };
        yield { type: 'done' as const, requestId: 'file-continuation' };
      },
    } as unknown as EAgentTransport;

    await useConversationStore.getState().decideFileChange(transport, 'file-change', 'accept');

    expect(decideFileChange).toHaveBeenCalledWith('files', 'file-change', 'accept');
    expect(listMessages).toHaveBeenCalledWith('files');
    expect(continuationRequest).toEqual({
      conversationId: 'files',
      content: '',
      model: 'model-with-file-tools',
      continuationToolCallId: 'file-tool',
      contextMentions: [],
    });
    expect(useConversationStore.getState().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'assistant-file-change',
          fileChanges: [expect.objectContaining({ id: 'file-change', status: 'accepted' })],
          toolCalls: [
            expect.objectContaining({
              id: 'file-tool',
              status: 'completed',
              result: '服务端确认的 Diff',
              durationMs: 24,
            }),
          ],
        }),
        expect.objectContaining({
          id: 'file-continuation-message',
          content: '文件已更新。',
          status: 'completed',
        }),
      ]),
    );
  });

  it('文件变更决策失败时回滚文件和父工具状态，并拦截并发重复提交', async () => {
    const completion = deferred<void>();
    const decisionError = new Error('file approval failed');
    useConversationStore.setState({
      selectedId: 'files',
      messages: [
        {
          id: 'assistant-file-change',
          conversationId: 'files',
          role: 'assistant',
          content: '',
          createdAt: now,
          model: 'model-with-file-tools',
          status: 'completed',
          toolCalls: [
            {
              id: 'file-tool',
              name: 'workspace_propose_write',
              arguments: '{}',
              status: 'approval-required',
              metadata: { kind: 'file-change', changeId: 'file-change' },
            },
          ],
          fileChanges: [
            {
              id: 'file-change',
              path: 'src/generated.ts',
              diff: '@@',
              status: 'pending',
            },
          ],
        },
      ],
    });
    const decideFileChange = vi.fn(() => completion.promise);
    const transport = {
      kind: 'desktop',
      decideFileChange,
    } as unknown as EAgentTransport;

    const firstDecision = useConversationStore
      .getState()
      .decideFileChange(transport, 'file-change', 'accept');
    const failedDecision = expect(firstDecision).rejects.toBe(decisionError);
    expect(useConversationStore.getState().messages[0]).toMatchObject({
      fileChanges: [{ id: 'file-change', status: 'accepted' }],
      toolCalls: [{ id: 'file-tool', status: 'running' }],
    });

    await useConversationStore.getState().decideFileChange(transport, 'file-change', 'accept');
    expect(decideFileChange).toHaveBeenCalledOnce();

    completion.reject(decisionError);
    await failedDecision;
    expect(useConversationStore.getState().messages[0]).toMatchObject({
      fileChanges: [{ id: 'file-change', status: 'pending' }],
      toolCalls: [{ id: 'file-tool', status: 'approval-required' }],
    });
  });

  it('Web 文件决策保持原有请求语义，不发起桌面工具 continuation', async () => {
    useConversationStore.setState({
      selectedId: 'files',
      messages: [
        {
          id: 'assistant-file-change',
          conversationId: 'files',
          role: 'assistant',
          content: '',
          createdAt: now,
          model: 'web-model',
          status: 'completed',
          toolCalls: [
            {
              id: 'file-tool',
              name: 'workspace_propose_write',
              arguments: '{}',
              status: 'approval-required',
              metadata: { kind: 'file-change', changeId: 'file-change' },
            },
          ],
          fileChanges: [
            {
              id: 'file-change',
              path: 'src/generated.ts',
              diff: '@@',
              status: 'pending',
            },
          ],
        },
      ],
    });
    const streamChat = vi.fn(async function* () {
      yield { type: 'done' as const, requestId: 'unexpected' };
    });
    const transport = {
      kind: 'http',
      decideFileChange: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      streamChat,
    } as unknown as EAgentTransport;

    await useConversationStore.getState().decideFileChange(transport, 'file-change', 'reject');

    expect(transport.decideFileChange).toHaveBeenCalledWith('files', 'file-change', 'reject');
    expect(streamChat).not.toHaveBeenCalled();
    expect(useConversationStore.getState().messages[0]).toMatchObject({
      fileChanges: [{ id: 'file-change', status: 'rejected' }],
      toolCalls: [{ id: 'file-tool', status: 'rejected' }],
    });
  });

  it('用加载代次阻止 A 到 B 再回 A 时的旧响应覆盖新响应', async () => {
    const slowMessages = deferred<Message[]>();
    const slowContext = deferred<typeof emptyContext>();
    const freshMessage: Message = {
      id: 'selection-epoch-fresh',
      conversationId: 'selection-a',
      role: 'assistant',
      content: 'fresh selection',
      createdAt: now,
      status: 'completed',
    };
    let aMessageLoads = 0;
    let aContextLoads = 0;
    const transport = {
      listMessages: vi.fn((id: string) => {
        if (id !== 'selection-a') return Promise.resolve([]);
        aMessageLoads += 1;
        return aMessageLoads === 1 ? slowMessages.promise : Promise.resolve([freshMessage]);
      }),
      getContext: vi.fn((id: string) => {
        if (id !== 'selection-a') {
          return Promise.resolve({ ...emptyContext, usedTokens: 5 });
        }
        aContextLoads += 1;
        return aContextLoads === 1
          ? slowContext.promise
          : Promise.resolve({ ...emptyContext, usedTokens: 15 });
      }),
    } as unknown as EAgentTransport;

    const firstSelection = useConversationStore
      .getState()
      .selectConversation(transport, 'selection-a');
    await vi.waitFor(() => expect(transport.listMessages).toHaveBeenCalledOnce());
    await useConversationStore.getState().selectConversation(transport, 'selection-b');
    await useConversationStore.getState().selectConversation(transport, 'selection-a');
    slowMessages.resolve([
      {
        ...freshMessage,
        id: 'selection-epoch-stale',
        content: 'stale selection',
      },
    ]);
    slowContext.resolve({ ...emptyContext, usedTokens: 99 });
    await firstSelection;

    expect(useConversationStore.getState()).toMatchObject({
      selectedId: 'selection-a',
      loading: false,
      messages: [freshMessage],
      context: { ...emptyContext, usedTokens: 15 },
    });
  });

  it('会话列表刷新期间创建新会话时丢弃过期列表结果', async () => {
    const staleList = deferred<ReturnType<typeof conversation>[]>();
    const listConversations = vi.fn(() => staleList.promise);
    const loading = useConversationStore.getState().loadConversations({
      listConversations,
    } as unknown as EAgentTransport);
    await vi.waitFor(() => expect(listConversations).toHaveBeenCalledOnce());

    const created = conversation('created-during-list-refresh');
    await useConversationStore.getState().createConversation({
      createConversation: vi.fn().mockResolvedValue(created),
    } as unknown as EAgentTransport);
    staleList.resolve([conversation('stale-server-list')]);
    await loading;

    expect(useConversationStore.getState()).toMatchObject({
      conversations: [created],
      selectedId: created.id,
      loading: false,
    });
  });

  it('删除响应丢失但服务端已提交时通过权威快照按成功收敛', async () => {
    const current = { ...conversation('delete-unknown-commit'), messageCount: 2 };
    const userMessage: Message = {
      id: 'delete-unknown-user',
      conversationId: current.id,
      role: 'user',
      content: 'keep me',
      createdAt: now,
      status: 'completed',
    };
    const assistantMessage: Message = {
      id: 'delete-unknown-assistant',
      conversationId: current.id,
      role: 'assistant',
      content: 'delete me',
      createdAt: now,
      status: 'completed',
    };
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
      messages: [userMessage, assistantMessage],
    });
    let snapshotCalls = 0;
    const getMessageSnapshot = vi.fn(async () => {
      snapshotCalls += 1;
      const messages = snapshotCalls === 1 ? [userMessage, assistantMessage] : [userMessage];
      return {
        messages,
        messageCount: messages.length,
        tailMessageId: messages.at(-1)?.id ?? null,
      };
    });
    const transport = {
      getMessageSnapshot,
      deleteMessage: vi
        .fn()
        .mockRejectedValue(new TransportError('response lost', { code: 'NETWORK_ERROR' })),
      getContext: vi.fn().mockResolvedValue(emptyContext),
      listSnapshots: vi.fn().mockResolvedValue([]),
    } as unknown as EAgentTransport;

    const result = await useConversationStore
      .getState()
      .deleteMessage(transport, assistantMessage.id);

    expect(result).toMatchObject({
      conversation: { id: current.id, messageCount: 1 },
      removedCount: 1,
    });
    expect(transport.deleteMessage).toHaveBeenCalledOnce();
    expect(getMessageSnapshot).toHaveBeenCalledTimes(3);
    expect(useConversationStore.getState()).toMatchObject({
      messages: [userMessage],
      messageMutationId: null,
      error: null,
    });
  });

  it('删除提交后即时对账也离线时在网络恢复后的第二次点击收敛', async () => {
    const current = { ...conversation('delete-delayed-reconciliation'), messageCount: 2 };
    const userMessage: Message = {
      id: 'delete-delayed-user',
      conversationId: current.id,
      role: 'user',
      content: 'keep me',
      createdAt: now,
      status: 'completed',
    };
    const assistantMessage: Message = {
      id: 'delete-delayed-assistant',
      conversationId: current.id,
      role: 'assistant',
      content: 'delete me',
      createdAt: now,
      status: 'completed',
    };
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
      messages: [userMessage, assistantMessage],
    });
    let snapshotCalls = 0;
    const getMessageSnapshot = vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return {
          messages: [userMessage, assistantMessage],
          messageCount: 2,
          tailMessageId: assistantMessage.id,
        };
      }
      if (snapshotCalls === 2) {
        throw new TransportError('still offline', { code: 'NETWORK_ERROR' });
      }
      return {
        messages: [userMessage],
        messageCount: 1,
        tailMessageId: userMessage.id,
      };
    });
    const deleteMessage = vi
      .fn()
      .mockRejectedValue(new TransportError('response lost', { code: 'NETWORK_ERROR' }));
    const transport = {
      getMessageSnapshot,
      deleteMessage,
      getContext: vi.fn().mockResolvedValue(emptyContext),
      listSnapshots: vi.fn().mockResolvedValue([]),
    } as unknown as EAgentTransport;

    await expect(
      useConversationStore.getState().deleteMessage(transport, assistantMessage.id),
    ).rejects.toThrow('response lost');
    const result = await useConversationStore
      .getState()
      .deleteMessage(transport, assistantMessage.id);

    expect(result).toMatchObject({
      conversation: { id: current.id, messageCount: 1 },
      removedCount: 1,
    });
    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(getMessageSnapshot).toHaveBeenCalledTimes(3);
    expect(useConversationStore.getState()).toMatchObject({
      messages: [userMessage],
      messageMutationId: null,
    });
  });

  it('删除收到确定的客户端冲突时清除待对账标记且不伪报成功', async () => {
    const current = { ...conversation('delete-definitive-conflict'), messageCount: 1 };
    const assistantMessage: Message = {
      id: 'delete-definitive-assistant',
      conversationId: current.id,
      role: 'assistant',
      content: 'changed remotely',
      createdAt: now,
      status: 'completed',
    };
    useConversationStore.setState({
      selectedId: current.id,
      conversations: [current],
      messages: [assistantMessage],
    });
    const getMessageSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [assistantMessage],
        messageCount: 1,
        tailMessageId: assistantMessage.id,
      })
      .mockResolvedValue({
        messages: [],
        messageCount: 0,
        tailMessageId: null,
      });
    const transport = {
      getMessageSnapshot,
      deleteMessage: vi.fn().mockRejectedValue(
        new TransportError('definitive conflict', {
          code: 'CONFLICT',
          status: 409,
        }),
      ),
    } as unknown as EAgentTransport;

    await expect(
      useConversationStore.getState().deleteMessage(transport, assistantMessage.id),
    ).rejects.toThrow('definitive conflict');
    await expect(
      useConversationStore.getState().deleteMessage(transport, assistantMessage.id),
    ).rejects.toThrow(/不存在|已变化/u);

    expect(transport.deleteMessage).toHaveBeenCalledOnce();
    expect(getMessageSnapshot).toHaveBeenCalledTimes(2);
    expect(useConversationStore.getState().messageMutationId).toBeNull();
  });
});
