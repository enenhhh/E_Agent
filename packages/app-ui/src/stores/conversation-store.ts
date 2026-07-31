import { create, type StoreApi } from 'zustand';

import { parseMentions } from '../lib/mentions';
import {
  TransportError,
  type BranchConversationOptions,
  type DeleteMessageResult,
  type EAgentTransport,
  type MessageSnapshot,
} from '../lib/transport';
import type {
  ContextOverview,
  ChatRequest,
  Conversation,
  FileChange,
  Message,
  Snapshot,
  StreamEvent,
  ToolCall,
} from '../types';

export interface SendInput {
  content: string;
  model: string;
  skill?: string;
  compareModels?: string[];
}

export interface QueuedPrompt {
  id: string;
  conversationId: string;
  input: SendInput;
  createdAt: string;
}

interface ConversationState {
  conversations: Conversation[];
  selectedId: string | null;
  messages: Message[];
  context: ContextOverview | null;
  snapshots: Snapshot[];
  snapshotsLoading: boolean;
  restoringSnapshotId: string | null;
  snapshotError: string | null;
  loading: boolean;
  streaming: boolean;
  error: string | null;
  queue: { running: number; queued: number; position?: number };
  queuedPrompts: QueuedPrompt[];
  abortController: AbortController | null;
  messageMutationId: string | null;
  selectionEpoch: number;
  conversationListEpoch: number;
  conversationRevision: number;
  loadConversations: (transport: EAgentTransport) => Promise<void>;
  refreshConversationSummary: (transport: EAgentTransport, id: string) => Promise<void>;
  selectConversation: (transport: EAgentTransport, id: string) => Promise<void>;
  createConversation: (transport: EAgentTransport) => Promise<string>;
  updateConversation: (
    transport: EAgentTransport,
    id: string,
    input: Partial<Pick<Conversation, 'title' | 'pinned' | 'archived'>>,
  ) => Promise<void>;
  deleteConversation: (transport: EAgentTransport, id: string) => Promise<void>;
  branchConversation: (
    transport: EAgentTransport,
    messageId: string,
    options?: BranchConversationOptions,
  ) => Promise<Conversation>;
  deleteMessage: (transport: EAgentTransport, messageId: string) => Promise<DeleteMessageResult>;
  setMessageFeedback: (
    transport: EAgentTransport,
    messageId: string,
    feedback: Message['feedback'],
  ) => Promise<void>;
  retryMessage: (
    transport: EAgentTransport,
    messageId: string,
    input: Omit<SendInput, 'content'>,
  ) => Promise<void>;
  editAndResend: (
    transport: EAgentTransport,
    messageId: string,
    content: string,
    input: Omit<SendInput, 'content'>,
  ) => Promise<void>;
  createSnapshot: (transport: EAgentTransport) => Promise<Snapshot>;
  loadSnapshots: (transport: EAgentTransport) => Promise<void>;
  restoreSnapshot: (transport: EAgentTransport, snapshotId: string) => Promise<void>;
  send: (transport: EAgentTransport, input: SendInput) => Promise<void>;
  sendNextQueued: (transport: EAgentTransport) => Promise<void>;
  updateQueuedPrompt: (id: string, content: string) => void;
  moveQueuedPrompt: (id: string, direction: -1 | 1) => void;
  removeQueuedPrompt: (id: string) => void;
  stop: () => void;
  decideFileChange: (
    transport: EAgentTransport,
    changeId: string,
    decision: 'accept' | 'reject',
  ) => Promise<void>;
  decideToolCall: (
    transport: EAgentTransport,
    conversationId: string,
    toolCallId: string,
    decision: 'approve' | 'reject',
  ) => Promise<void>;
  refreshQueue: (transport: EAgentTransport) => Promise<void>;
  clearError: () => void;
}

function eventToolCall(event: StreamEvent): ToolCall | undefined {
  return (
    event.toolCall ??
    (
      event as StreamEvent & {
        toolResult?: ToolCall;
      }
    ).toolResult
  );
}

function mergeToolCall(current: ToolCall | undefined, incoming: ToolCall): ToolCall {
  return {
    ...current,
    ...incoming,
    metadata: {
      ...(current?.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    },
  };
}

function updateToolCall(message: Message, incoming: ToolCall): Message {
  const current = message.toolCalls ?? [];
  const index = current.findIndex((toolCall) => toolCall.id === incoming.id);
  if (index < 0) {
    return { ...message, toolCalls: [...current, incoming] };
  }
  return {
    ...message,
    toolCalls: current.map((toolCall, toolCallIndex) =>
      toolCallIndex === index ? mergeToolCall(toolCall, incoming) : toolCall,
    ),
  };
}

interface FileChangeDecisionContext {
  fileChange: FileChange;
  parentAssistant?: Message;
  toolCall?: ToolCall;
}

const activeFileChangeDecisions = new Set<string>();
const claimedToolContinuations = new Set<string>();
const maximumClaimedToolContinuations = 1_024;
let conversationSummaryRequestSequence = 0;
const latestConversationSummaryRequest = new Map<string, number>();
const pendingDeleteReconciliations = new Map<
  string,
  { expectedPrefixIds: string[]; removedCount: number }
>();
const maximumPendingDeleteReconciliations = 128;

function pendingDeleteKey(conversationId: string, messageId: string): string {
  return JSON.stringify([conversationId, messageId]);
}

function rememberPendingDelete(
  key: string,
  value: { expectedPrefixIds: string[]; removedCount: number },
): void {
  if (
    !pendingDeleteReconciliations.has(key) &&
    pendingDeleteReconciliations.size >= maximumPendingDeleteReconciliations
  ) {
    const oldest = pendingDeleteReconciliations.keys().next().value as string | undefined;
    if (oldest !== undefined) pendingDeleteReconciliations.delete(oldest);
  }
  pendingDeleteReconciliations.set(key, value);
}

function continuationToolCallId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('metadata' in value)) return undefined;
  const metadata = value.metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const candidate = (metadata as Record<string, unknown>)['continuationToolCallId'];
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 256
    ? candidate
    : undefined;
}

function claimToolContinuation(conversationId: string, toolCallId: string): boolean {
  const key = JSON.stringify([conversationId, toolCallId]);
  if (claimedToolContinuations.has(key)) return false;
  claimedToolContinuations.add(key);
  while (claimedToolContinuations.size > maximumClaimedToolContinuations) {
    const oldestKey = claimedToolContinuations.values().next().value as string | undefined;
    if (oldestKey === undefined) break;
    claimedToolContinuations.delete(oldestKey);
  }
  return true;
}

function releaseToolContinuation(conversationId: string, toolCallId: string): void {
  claimedToolContinuations.delete(JSON.stringify([conversationId, toolCallId]));
}

function toolCallFileChangeId(toolCall: ToolCall): string | undefined {
  const changeId = toolCall.metadata?.['changeId'];
  return typeof changeId === 'string' ? changeId : undefined;
}

function findFileChangeDecisionContext(
  messages: Message[],
  changeId: string,
): FileChangeDecisionContext | undefined {
  const fileChangeOwner = messages.find((message) =>
    message.fileChanges?.some((change) => change.id === changeId),
  );
  const fileChange = fileChangeOwner?.fileChanges?.find((change) => change.id === changeId);
  if (!fileChangeOwner || !fileChange) {
    return undefined;
  }

  const parentAssistant = [fileChangeOwner, ...messages].find(
    (message) =>
      message.role === 'assistant' &&
      message.toolCalls?.some((toolCall) => toolCallFileChangeId(toolCall) === changeId),
  );
  const toolCall = parentAssistant?.toolCalls?.find(
    (candidate) => toolCallFileChangeId(candidate) === changeId,
  );
  return { fileChange, parentAssistant, toolCall };
}

function applyFileChangeDecision(
  messages: Message[],
  input: {
    conversationId: string;
    changeId: string;
    fileStatus: FileChange['status'];
    toolCallId?: string;
    toolStatus?: ToolCall['status'];
  },
): Message[] {
  return messages.map((message) => {
    if (message.conversationId !== input.conversationId) {
      return message;
    }
    const fileChanges = message.fileChanges?.map((change) =>
      change.id === input.changeId ? { ...change, status: input.fileStatus } : change,
    );
    const toolCalls = message.toolCalls?.map((toolCall) =>
      input.toolCallId !== undefined &&
      input.toolStatus !== undefined &&
      toolCall.id === input.toolCallId
        ? { ...toolCall, status: input.toolStatus }
        : toolCall,
    );
    return {
      ...message,
      ...(fileChanges === undefined ? {} : { fileChanges }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    };
  });
}

function restoreFileChangeDecision(
  messages: Message[],
  input: {
    conversationId: string;
    changeId: string;
    previousFileChange: FileChange;
    previousToolCall?: ToolCall;
  },
): Message[] {
  return messages.map((message) => {
    if (message.conversationId !== input.conversationId) {
      return message;
    }
    const fileChanges = message.fileChanges?.map((change) =>
      change.id === input.changeId ? input.previousFileChange : change,
    );
    const toolCalls = message.toolCalls?.map((toolCall) =>
      input.previousToolCall !== undefined && toolCall.id === input.previousToolCall.id
        ? input.previousToolCall
        : toolCall,
    );
    return {
      ...message,
      ...(fileChanges === undefined ? {} : { fileChanges }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    };
  });
}

function appendEvent(message: Message, event: StreamEvent): Message {
  if (message.status === 'cancelled' && event.type !== 'usage') {
    return message;
  }
  switch (event.type) {
    case 'delta':
      return {
        ...message,
        content: `${message.content}${event.delta ?? ''}`,
        status: 'streaming',
      };
    case 'reasoning':
      return {
        ...message,
        reasoning: `${message.reasoning ?? ''}${event.delta ?? ''}`,
        status: 'streaming',
      };
    case 'tool_call':
    case 'tool_result': {
      const toolCall = eventToolCall(event);
      if (!toolCall) {
        return message;
      }
      return updateToolCall(message, toolCall);
    }
    case 'file_change':
      return event.fileChange
        ? {
            ...message,
            fileChanges: [...(message.fileChanges ?? []), event.fileChange],
          }
        : message;
    case 'usage':
      return {
        ...message,
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        latencyMs: event.usage?.latencyMs,
        reasoningDurationMs: event.usage?.reasoningDurationMs,
      };
    case 'done':
      return {
        ...message,
        status: 'completed',
        toolCalls: message.toolCalls?.map((toolCall) =>
          toolCall.status === 'running' || toolCall.status === 'pending'
            ? { ...toolCall, status: 'approval-required' }
            : toolCall,
        ),
      };
    case 'error':
      return {
        ...message,
        content: message.content || event.message || '生成失败。',
        status: 'failed',
        toolCalls: message.toolCalls?.map((toolCall) =>
          toolCall.status === 'running' || toolCall.status === 'pending'
            ? {
                ...toolCall,
                status: 'failed',
                result: toolCall.result ?? event.message ?? '工具调用未完成。',
              }
            : toolCall,
        ),
      };
    default:
      return message;
  }
}

function updateAssistant(
  messages: Message[],
  assistantMessageId: string,
  event: StreamEvent,
): Message[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? appendEvent(message, event) : message,
  );
}

function resolvePersistedMessages(
  localMessages: readonly Message[],
  persistedMessages: readonly Message[],
  messageIds: readonly string[],
): Map<string, Message> {
  const resolved = new Map<string, Message>();
  for (const messageId of messageIds) {
    const exact = persistedMessages.find((message) => message.id === messageId);
    if (exact !== undefined) resolved.set(messageId, exact);
  }
  const unresolved = new Set(messageIds.filter((messageId) => !resolved.has(messageId)));
  if (unresolved.size === 0 || localMessages.length !== persistedMessages.length) return resolved;

  // 兼容旧版本临时 ID，但只允许本次操作指定的消息发生 ID 差异；其余位置必须完全一致。
  for (let index = 0; index < localMessages.length; index += 1) {
    const localMessage = localMessages[index];
    const persistedMessage = persistedMessages[index];
    if (localMessage === undefined || persistedMessage === undefined) return resolved;
    if (localMessage.id === persistedMessage.id) continue;
    if (
      !unresolved.has(localMessage.id) ||
      localMessage.role !== persistedMessage.role ||
      localMessage.content !== persistedMessage.content
    ) {
      return resolved;
    }
  }
  for (let index = 0; index < localMessages.length; index += 1) {
    const localMessage = localMessages[index];
    const persistedMessage = persistedMessages[index];
    if (
      localMessage !== undefined &&
      persistedMessage !== undefined &&
      unresolved.has(localMessage.id)
    ) {
      resolved.set(localMessage.id, persistedMessage);
    }
  }
  return resolved;
}

function mergePersistedMessageState(
  localMessages: readonly Message[],
  persistedMessages: readonly Message[],
): Message[] {
  return persistedMessages.map((persistedMessage) => {
    const localMessage = localMessages.find((message) => message.id === persistedMessage.id);
    if (
      localMessage?.role !== 'assistant' ||
      (localMessage.status !== 'failed' && localMessage.status !== 'cancelled')
    ) {
      return persistedMessage;
    }
    return {
      ...persistedMessage,
      content: persistedMessage.content || localMessage.content,
      reasoning: persistedMessage.reasoning ?? localMessage.reasoning,
      status: localMessage.status,
    };
  });
}

function transientFailedSuffixLength(
  localMessages: readonly Message[],
  persistedMessages: readonly Message[],
  messageId: string,
): number {
  const targetIndex = localMessages.findIndex((message) => message.id === messageId);
  if (targetIndex < persistedMessages.length || persistedMessages.length > localMessages.length) {
    return 0;
  }
  for (let index = 0; index < persistedMessages.length; index += 1) {
    if (localMessages[index]?.id !== persistedMessages[index]?.id) return 0;
  }
  const suffix = localMessages.slice(persistedMessages.length);
  if (
    suffix.length === 0 ||
    !suffix.some((message) => message.status === 'failed' || message.status === 'cancelled') ||
    suffix.some((message) =>
      persistedMessages.some((persistedMessage) => persistedMessage.id === message.id),
    )
  ) {
    return 0;
  }
  return suffix.length;
}

function mutationOutcomeMayBeUnknown(error: unknown): boolean {
  if (!(error instanceof TransportError)) return true;
  return (
    error.code === 'NETWORK_ERROR' ||
    error.code === 'REQUEST_TIMEOUT' ||
    error.status === undefined ||
    error.status === 408 ||
    error.status >= 500
  );
}

function hasMessagePrefix(messages: Message[], expectedPrefixIds: string[]): boolean {
  return (
    messages.length >= expectedPrefixIds.length &&
    expectedPrefixIds.every((messageId, index) => messages[index]?.id === messageId)
  );
}

/**
 * 读取并安全合并目标会话的权威摘要。
 * 对象身份相当于目标级修订号：其他会话更新会保留该引用，目标自身被修改或删除时则丢弃旧结果。
 */
async function refreshConversationSummaryInternal(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  conversationId: string,
): Promise<void> {
  const expectedConversation = get().conversations.find(
    (conversation) => conversation.id === conversationId,
  );
  if (expectedConversation === undefined) return;
  conversationSummaryRequestSequence += 1;
  const requestSequence = conversationSummaryRequestSequence;
  latestConversationSummaryRequest.set(conversationId, requestSequence);
  let refreshedConversation: Conversation;
  try {
    refreshedConversation = await transport.getConversation(conversationId);
  } catch {
    if (latestConversationSummaryRequest.get(conversationId) === requestSequence) {
      latestConversationSummaryRequest.delete(conversationId);
    }
    return;
  }
  if (latestConversationSummaryRequest.get(conversationId) !== requestSequence) return;
  set((state) => {
    const currentConversation = state.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (currentConversation !== expectedConversation) return {};
    return {
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId ? refreshedConversation : conversation,
      ),
      conversationRevision: state.conversationRevision + 1,
    };
  });
  if (latestConversationSummaryRequest.get(conversationId) === requestSequence) {
    latestConversationSummaryRequest.delete(conversationId);
  }
}

async function streamAssistantResponse(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  request: ChatRequest,
  messagesToAppend: Message[],
  assistantMessage: Message,
): Promise<boolean> {
  const controller = new AbortController();
  const selectionEpoch = get().selectionEpoch;
  let assistantMessageId = assistantMessage.id;
  let streamFailed = false;
  set((state) => ({
    messages: [...state.messages, ...messagesToAppend],
    streaming: true,
    error: null,
    abortController: controller,
  }));

  try {
    for await (const event of transport.streamChat(request, controller.signal)) {
      if (event.type === 'error') streamFailed = true;
      if (event.type === 'start' && event.messageId && event.messageId !== assistantMessageId) {
        const previousId = assistantMessageId;
        assistantMessageId = event.messageId;
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === previousId ? { ...message, id: assistantMessageId } : message,
          ),
        }));
      }
      set((state) =>
        event.type === 'queue' && event.queue
          ? {
              queue: {
                running: event.queue.active,
                queued: event.queue.pending,
                ...(event.queue.position === null ? {} : { position: event.queue.position }),
              },
            }
          : {
              messages: updateAssistant(state.messages, assistantMessageId, event),
            },
      );
    }
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === assistantMessageId &&
        message.status !== 'failed' &&
        message.status !== 'cancelled'
          ? { ...message, status: 'completed' }
          : message,
      ),
      queue: { running: state.queue.running, queued: state.queue.queued },
    }));

    if (!controller.signal.aborted) {
      const messagesRefresh = transport.listMessages(request.conversationId);
      const contextRefresh = transport.getContext(request.conversationId);
      const summaryRefresh = refreshConversationSummaryInternal(
        set,
        get,
        transport,
        request.conversationId,
      );
      const [messagesResult, contextResult] = await Promise.allSettled([
        messagesRefresh,
        contextRefresh,
      ]);
      await summaryRefresh;
      if (
        !controller.signal.aborted &&
        get().abortController === controller &&
        get().selectedId === request.conversationId &&
        get().selectionEpoch === selectionEpoch
      ) {
        set((state) => ({
          ...(messagesResult.status === 'fulfilled'
            ? {
                messages: mergePersistedMessageState(state.messages, messagesResult.value),
              }
            : {}),
          ...(contextResult.status === 'fulfilled' ? { context: contextResult.value } : {}),
        }));
      }
    } else {
      await refreshConversationSummaryInternal(set, get, transport, request.conversationId);
    }
    if (get().abortController === controller) {
      set((state) => ({
        streaming: false,
        abortController: null,
        queue: { running: state.queue.running, queued: state.queue.queued },
      }));
    }
    return !controller.signal.aborted && !streamFailed;
  } catch (error) {
    const aborted = controller.signal.aborted;
    if (get().abortController === controller) {
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: message.content || (aborted ? '生成已停止。' : '生成失败，请重试。'),
                status: aborted ? 'cancelled' : 'failed',
              }
            : message,
        ),
        streaming: false,
        abortController: null,
        queue: { running: state.queue.running, queued: state.queue.queued },
        error: aborted ? null : error instanceof Error ? error.message : '消息发送失败。',
      }));
    }
    await refreshConversationSummaryInternal(set, get, transport, request.conversationId);
    if (!aborted) throw error;
    return false;
  }
}

async function streamToolContinuation(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  input: {
    conversationId: string;
    model: string | undefined;
    toolCallId: string | undefined;
  },
): Promise<void> {
  if (
    input.model === undefined ||
    input.toolCallId === undefined ||
    get().selectedId !== input.conversationId ||
    get().streaming
  ) {
    return;
  }
  if (!claimToolContinuation(input.conversationId, input.toolCallId)) return;
  const assistantMessage: Message = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    model: input.model,
    status: 'pending',
  };
  let succeeded = false;
  try {
    succeeded = await streamAssistantResponse(
      set,
      get,
      transport,
      {
        conversationId: input.conversationId,
        content: '',
        model: input.model,
        continuationToolCallId: input.toolCallId,
        contextMentions: [],
      },
      [assistantMessage],
      assistantMessage,
    );
  } finally {
    if (!succeeded) {
      releaseToolContinuation(input.conversationId, input.toolCallId);
    }
  }
}

function beginMessageMutation(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
): string {
  assertMessageMutationIdle(get);
  const operationId = crypto.randomUUID();
  set({ messageMutationId: operationId });
  return operationId;
}

function assertMessageMutationIdle(get: StoreApi<ConversationState>['getState']): void {
  if (get().messageMutationId !== null) {
    throw new Error('另一项消息操作正在进行，请稍候。');
  }
}

function finishMessageMutation(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  operationId: string,
): void {
  if (get().messageMutationId === operationId) {
    set({ messageMutationId: null });
  }
}

async function selectConversationInternal(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  id: string,
  allowDuringMessageMutation = false,
): Promise<void> {
  if (!allowDuringMessageMutation) {
    assertMessageMutationIdle(get);
  }
  if (get().streaming && get().selectedId === id) {
    return;
  }
  if (get().streaming) {
    get().stop();
  }
  const selectionEpoch = get().selectionEpoch + 1;
  set({
    selectedId: id,
    selectionEpoch,
    loading: true,
    error: null,
    messages: [],
    context: null,
    snapshots: [],
    snapshotsLoading: false,
    restoringSnapshotId: null,
    snapshotError: null,
  });
  try {
    const [messages, context] = await Promise.all([
      transport.listMessages(id),
      transport.getContext(id),
    ]);
    if (
      get().selectedId === id &&
      get().selectionEpoch === selectionEpoch &&
      (allowDuringMessageMutation || get().messageMutationId === null)
    ) {
      set({ messages, context, loading: false });
    }
  } catch (error) {
    if (
      get().selectedId === id &&
      get().selectionEpoch === selectionEpoch &&
      (allowDuringMessageMutation || get().messageMutationId === null)
    ) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '会话内容加载失败。',
      });
    }
  }
}

async function createConversationInternal(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
): Promise<string> {
  if (get().streaming) {
    get().stop();
  }
  const conversation = await transport.createConversation('新会话');
  set((state) => ({
    conversations: [conversation, ...state.conversations],
    selectedId: conversation.id,
    selectionEpoch: state.selectionEpoch + 1,
    conversationRevision: state.conversationRevision + 1,
    loading: false,
    messages: [],
    context: null,
    snapshots: [],
    snapshotsLoading: false,
    restoringSnapshotId: null,
    snapshotError: null,
  }));
  return conversation.id;
}

async function branchConversationInternal(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  messageId: string,
  options: BranchConversationOptions = {},
): Promise<Conversation> {
  const conversationId = get().selectedId;
  if (!conversationId) {
    throw new Error('请先选择会话。');
  }
  if (get().streaming) {
    throw new Error('请先停止当前生成，再创建新对话。');
  }
  const localMessages = get().messages;
  const persistedMessages = await transport.listMessages(conversationId);
  const requestedMessageIds = [
    messageId,
    ...(options.originMessageId === undefined ? [] : [options.originMessageId]),
  ];
  const resolvedMessages = resolvePersistedMessages(
    localMessages,
    persistedMessages,
    requestedMessageIds,
  );
  const target = resolvedMessages.get(messageId);
  const origin =
    options.originMessageId === undefined
      ? undefined
      : resolvedMessages.get(options.originMessageId);
  if (get().selectedId === conversationId) {
    set({ messages: persistedMessages });
  }
  if (target === undefined || (options.originMessageId !== undefined && origin === undefined)) {
    throw new Error('消息已不存在或会话内容已变化，已刷新当前会话。');
  }
  const branch = await transport.branchConversation(conversationId, target.id, {
    ...options,
    ...(origin === undefined ? {} : { originMessageId: origin.id }),
  } as BranchConversationOptions);
  set((state) => ({
    conversations: [
      branch,
      ...state.conversations
        .filter((item) => item.id !== branch.id)
        .map((item) =>
          item.id === (branch.parentConversationId ?? conversationId)
            ? { ...item, branchCount: item.branchCount + 1 }
            : item,
        ),
    ],
    selectedId: branch.id,
    selectionEpoch: state.selectionEpoch + 1,
    conversationRevision: state.conversationRevision + 1,
    messages: [],
    context: null,
    snapshots: [],
    snapshotsLoading: false,
    restoringSnapshotId: null,
    snapshotError: null,
  }));
  await selectConversationInternal(set, get, transport, branch.id, true);
  return branch;
}

async function sendToConversation(
  set: StoreApi<ConversationState>['setState'],
  get: StoreApi<ConversationState>['getState'],
  transport: EAgentTransport,
  conversationId: string,
  input: SendInput,
): Promise<void> {
  const trimmed = input.content.trim();
  if (!trimmed) return;
  if (get().streaming) {
    throw new Error('当前会话仍在生成，请稍候。');
  }
  if (get().selectedId !== conversationId) {
    throw new Error('当前会话已切换，请在目标会话中重新执行。');
  }

  const now = new Date().toISOString();
  const userMessage: Message = {
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content: trimmed,
    createdAt: now,
    status: 'completed',
  };
  const assistantMessage: Message = {
    id: crypto.randomUUID(),
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: now,
    model: input.model,
    status: 'pending',
  };
  const mentions = parseMentions(trimmed);
  await streamAssistantResponse(
    set,
    get,
    transport,
    {
      conversationId,
      userMessageId: userMessage.id,
      content: trimmed,
      model: input.model,
      skill: input.skill,
      contextMentions: mentions.map((mention) => mention.raw),
      compareModels: input.compareModels,
    },
    [userMessage, assistantMessage],
    assistantMessage,
  );
}

export const useConversationStore = create<ConversationState>((set, get) => ({
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

  loadConversations: async (transport) => {
    if (get().streaming || get().messageMutationId !== null) return;
    const conversationListEpoch = get().conversationListEpoch + 1;
    const conversationRevision = get().conversationRevision;
    set({ loading: true, error: null, conversationListEpoch });
    try {
      const conversations = await transport.listConversations();
      if (
        get().conversationListEpoch !== conversationListEpoch ||
        get().conversationRevision !== conversationRevision ||
        get().streaming ||
        get().messageMutationId !== null
      ) {
        if (get().conversationListEpoch === conversationListEpoch) {
          set({ loading: false });
        }
        return;
      }
      set({ conversations, loading: false });
      const selectedId = get().selectedId ?? conversations[0]?.id;
      if (selectedId) {
        await get().selectConversation(transport, selectedId);
      }
    } catch (error) {
      if (
        get().conversationListEpoch === conversationListEpoch &&
        get().conversationRevision === conversationRevision
      ) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : '会话加载失败。',
        });
      }
    }
  },

  refreshConversationSummary: async (transport, id) =>
    refreshConversationSummaryInternal(set, get, transport, id),

  selectConversation: async (transport, id) => selectConversationInternal(set, get, transport, id),

  createConversation: async (transport) => {
    const operationId = beginMessageMutation(set, get);
    try {
      return await createConversationInternal(set, get, transport);
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  updateConversation: async (transport, id, input) => {
    const conversation = await transport.updateConversation(id, input);
    set((state) => ({
      conversations: state.conversations.map((item) => (item.id === id ? conversation : item)),
      conversationRevision: state.conversationRevision + 1,
    }));
  },

  deleteConversation: async (transport, id) => {
    const operationId = beginMessageMutation(set, get);
    try {
      if (get().streaming && get().selectedId === id) {
        throw new Error('请先停止当前生成，再删除会话。');
      }
      await transport.deleteConversation(id);
      const deletingSelectedConversation = get().selectedId === id;
      const remaining = get().conversations.filter((conversation) => conversation.id !== id);
      const nextConversationId = deletingSelectedConversation ? remaining[0]?.id : undefined;
      set({
        conversations: remaining,
        selectedId: deletingSelectedConversation ? (nextConversationId ?? null) : get().selectedId,
        selectionEpoch: deletingSelectedConversation
          ? get().selectionEpoch + 1
          : get().selectionEpoch,
        conversationRevision: get().conversationRevision + 1,
        loading: deletingSelectedConversation ? false : get().loading,
        messages: deletingSelectedConversation ? [] : get().messages,
        context: deletingSelectedConversation ? null : get().context,
        snapshots: deletingSelectedConversation ? [] : get().snapshots,
        snapshotsLoading: deletingSelectedConversation ? false : get().snapshotsLoading,
        restoringSnapshotId: deletingSelectedConversation ? null : get().restoringSnapshotId,
        snapshotError: deletingSelectedConversation ? null : get().snapshotError,
      });
      if (nextConversationId) {
        await selectConversationInternal(set, get, transport, nextConversationId, true);
      }
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  branchConversation: async (transport, messageId, options = {}) => {
    const operationId = beginMessageMutation(set, get);
    try {
      return await branchConversationInternal(set, get, transport, messageId, options);
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  deleteMessage: async (transport, messageId) => {
    const operationId = beginMessageMutation(set, get);
    try {
      const conversationId = get().selectedId;
      if (!conversationId) {
        throw new Error('请先选择会话。');
      }
      if (get().streaming) {
        throw new Error('请先停止当前生成，再删除消息。');
      }
      const localMessages = get().messages;
      const currentConversation = get().conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      if (!currentConversation) {
        throw new Error('会话不存在或已被删除。');
      }
      const messageSnapshot = await transport.getMessageSnapshot(conversationId);
      const persistedMessages = messageSnapshot.messages;
      if (get().selectedId === conversationId) {
        set({ messages: persistedMessages });
      }
      const reconciliationKey = pendingDeleteKey(conversationId, messageId);
      const targetIndex = persistedMessages.findIndex((message) => message.id === messageId);
      if (targetIndex < 0) {
        const pendingDelete = pendingDeleteReconciliations.get(reconciliationKey);
        if (
          pendingDelete !== undefined &&
          hasMessagePrefix(persistedMessages, pendingDelete.expectedPrefixIds)
        ) {
          pendingDeleteReconciliations.delete(reconciliationKey);
          const result: DeleteMessageResult = {
            conversation: {
              ...currentConversation,
              messageCount: messageSnapshot.messageCount,
            },
            removedCount: pendingDelete.removedCount,
          };
          if (get().selectedId === conversationId && get().messageMutationId === operationId) {
            set((state) => ({
              conversations: state.conversations.map((conversation) =>
                conversation.id === conversationId
                  ? { ...result.conversation, branchCount: conversation.branchCount }
                  : conversation,
              ),
              conversationRevision: state.conversationRevision + 1,
              messages: persistedMessages,
              context: null,
            }));
          }
          const [contextRefresh, snapshotsRefresh] = await Promise.allSettled([
            transport.getContext(conversationId),
            transport.listSnapshots(conversationId),
          ]);
          if (get().selectedId === conversationId && get().messageMutationId === operationId) {
            set({
              ...(contextRefresh.status === 'fulfilled' ? { context: contextRefresh.value } : {}),
              ...(snapshotsRefresh.status === 'fulfilled'
                ? { snapshots: snapshotsRefresh.value }
                : {}),
            });
          }
          return result;
        }
        const transientRemovedCount = transientFailedSuffixLength(
          localMessages,
          persistedMessages,
          messageId,
        );
        if (transientRemovedCount > 0) {
          return {
            conversation: {
              ...currentConversation,
              messageCount: messageSnapshot.messageCount,
            },
            removedCount: transientRemovedCount,
            transient: true,
          };
        }
        throw new Error('消息已不存在或会话内容已变化，已刷新当前会话。');
      }
      if (messageSnapshot.tailMessageId === null) {
        throw new Error('会话内容已变化，已刷新当前会话。');
      }
      const target = persistedMessages[targetIndex]!;
      const expectedPrefix = persistedMessages.slice(0, targetIndex);
      const expectedPrefixIds = expectedPrefix.map((message) => message.id);
      rememberPendingDelete(reconciliationKey, {
        expectedPrefixIds,
        removedCount: persistedMessages.length - targetIndex,
      });
      let remainingMessages = expectedPrefix;
      let result: DeleteMessageResult;
      try {
        result = await transport.deleteMessage(conversationId, target.id, {
          messageCount: messageSnapshot.messageCount,
          tailMessageId: messageSnapshot.tailMessageId,
        });
        pendingDeleteReconciliations.delete(reconciliationKey);
      } catch (error) {
        if (!mutationOutcomeMayBeUnknown(error)) {
          pendingDeleteReconciliations.delete(reconciliationKey);
          throw error;
        }
        let reconciledSnapshot: MessageSnapshot;
        try {
          reconciledSnapshot = await transport.getMessageSnapshot(conversationId);
        } catch {
          throw error;
        }
        if (
          reconciledSnapshot.messages.some((message) => message.id === target.id) ||
          !hasMessagePrefix(reconciledSnapshot.messages, expectedPrefixIds)
        ) {
          throw error;
        }
        pendingDeleteReconciliations.delete(reconciliationKey);
        remainingMessages = reconciledSnapshot.messages;
        result = {
          conversation: {
            ...currentConversation,
            messageCount: reconciledSnapshot.messageCount,
          },
          removedCount: Math.max(1, persistedMessages.length - targetIndex),
        };
      }
      if (get().selectedId === conversationId && get().messageMutationId === operationId) {
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? { ...result.conversation, branchCount: conversation.branchCount }
              : conversation,
          ),
          conversationRevision: state.conversationRevision + 1,
          messages: remainingMessages,
          context: null,
          snapshots:
            result.snapshot === undefined
              ? state.snapshots
              : [
                  result.snapshot,
                  ...state.snapshots.filter((snapshot) => snapshot.id !== result.snapshot?.id),
                ],
        }));
      }

      const [messagesRefresh, contextRefresh, snapshotsRefresh] = await Promise.allSettled([
        transport.getMessageSnapshot(conversationId),
        transport.getContext(conversationId),
        transport.listSnapshots(conversationId),
      ]);
      if (get().selectedId === conversationId && get().messageMutationId === operationId) {
        set((state) => ({
          ...(messagesRefresh.status === 'fulfilled'
            ? { messages: messagesRefresh.value.messages }
            : {}),
          ...(contextRefresh.status === 'fulfilled' ? { context: contextRefresh.value } : {}),
          ...(snapshotsRefresh.status === 'fulfilled' ? { snapshots: snapshotsRefresh.value } : {}),
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? { ...result.conversation, branchCount: conversation.branchCount }
              : conversation,
          ),
          conversationRevision: state.conversationRevision + 1,
        }));
      }
      return result;
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  setMessageFeedback: async (transport, messageId, feedback) => {
    const conversationId = get().selectedId;
    if (!conversationId) {
      throw new Error('请先选择会话。');
    }
    const current = get().messages.find((message) => message.id === messageId);
    if (!current || current.role !== 'assistant') {
      throw new Error('只能评价助手回答。');
    }
    const operationId = beginMessageMutation(set, get);
    const previous = current.feedback ?? null;
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, feedback } : message,
      ),
    }));
    try {
      const updated = await transport.setMessageFeedback(conversationId, messageId, feedback);
      if (get().selectedId === conversationId) {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId ? { ...message, feedback: updated.feedback ?? null } : message,
          ),
        }));
      }
    } catch (error) {
      if (get().selectedId === conversationId) {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === messageId ? { ...message, feedback: previous } : message,
          ),
        }));
      }
      throw error;
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  retryMessage: async (transport, messageId, input) => {
    const operationId = beginMessageMutation(set, get);
    try {
      const state = get();
      const conversationId = state.selectedId;
      if (!conversationId) {
        throw new Error('请先选择会话。');
      }
      const messageIndex = state.messages.findIndex((message) => message.id === messageId);
      const message = state.messages[messageIndex];
      if (!message || message.role !== 'assistant') {
        throw new Error('只能重试助手回答。');
      }
      const userMessage = [...state.messages.slice(0, messageIndex)]
        .reverse()
        .find((candidate) => candidate.role === 'user');
      if (!userMessage) {
        throw new Error('没有找到可重试的用户消息。');
      }
      const currentConversation = state.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      const persistedMessages = await transport.listMessages(conversationId);
      const resolvedMessages = resolvePersistedMessages(state.messages, persistedMessages, [
        userMessage.id,
        messageId,
      ]);
      const persistedUser = resolvedMessages.get(userMessage.id);
      const persistedAssistant = resolvedMessages.get(messageId);
      if (get().selectedId !== conversationId) {
        throw new Error('当前会话已切换，请在目标会话中重试。');
      }
      set({ messages: persistedMessages });

      let targetConversationId = conversationId;
      if (persistedUser !== undefined && persistedAssistant !== undefined) {
        const branch = await branchConversationInternal(set, get, transport, persistedUser.id, {
          includeFromMessage: false,
          kind: 'retry',
          originMessageId: persistedAssistant.id,
          title: `${currentConversation?.title ?? '会话'} · 重试`,
        });
        targetConversationId = branch.id;
      } else if (
        (message.status === 'failed' || message.status === 'cancelled') &&
        persistedAssistant === undefined
      ) {
        if (persistedUser !== undefined) {
          const branch = await branchConversationInternal(set, get, transport, persistedUser.id, {
            includeFromMessage: false,
            kind: 'branch',
            title: `${currentConversation?.title ?? '会话'} · 重试`,
          });
          targetConversationId = branch.id;
        } else if (
          transientFailedSuffixLength(state.messages, persistedMessages, userMessage.id) === 0
        ) {
          throw new Error('消息已不存在或会话内容已变化，已刷新当前会话。');
        }
      } else {
        throw new Error('消息已不存在或会话内容已变化，已刷新当前会话。');
      }
      await sendToConversation(set, get, transport, targetConversationId, {
        ...input,
        content: userMessage.content,
      });
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  editAndResend: async (transport, messageId, content, input) => {
    const operationId = beginMessageMutation(set, get);
    try {
      const trimmed = content.trim();
      if (!trimmed) {
        throw new Error('消息内容不能为空。');
      }
      const state = get();
      const message = state.messages.find((candidate) => candidate.id === messageId);
      if (!message || message.role !== 'user') {
        throw new Error('只能编辑用户消息。');
      }
      const currentConversation = state.conversations.find(
        (conversation) => conversation.id === state.selectedId,
      );
      const branch = await branchConversationInternal(set, get, transport, messageId, {
        includeFromMessage: false,
        kind: 'edit',
        originMessageId: messageId,
        title: `${currentConversation?.title ?? '会话'} · 编辑`,
      });
      await sendToConversation(set, get, transport, branch.id, {
        ...input,
        content: trimmed,
      });
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  createSnapshot: async (transport) => {
    const operationId = beginMessageMutation(set, get);
    try {
      const conversationId = get().selectedId;
      if (!conversationId) {
        throw new Error('请先选择会话。');
      }
      const snapshot = await transport.createSnapshot(conversationId);
      if (get().selectedId === conversationId && get().messageMutationId === operationId) {
        set((state) => ({
          snapshots: [
            snapshot,
            ...state.snapshots.filter((candidate) => candidate.id !== snapshot.id),
          ],
        }));
      }
      return snapshot;
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  loadSnapshots: async (transport) => {
    const conversationId = get().selectedId;
    if (!conversationId) {
      set({ snapshots: [], snapshotsLoading: false });
      return;
    }
    set({ snapshotsLoading: true, snapshotError: null });
    try {
      const snapshots = await transport.listSnapshots(conversationId);
      if (get().selectedId === conversationId) {
        set({ snapshots, snapshotsLoading: false });
      }
    } catch (error) {
      if (get().selectedId === conversationId) {
        set({
          snapshotsLoading: false,
          snapshotError: error instanceof Error ? error.message : '快照历史加载失败。',
        });
      }
      throw error;
    }
  },

  restoreSnapshot: async (transport, snapshotId) => {
    const operationId = beginMessageMutation(set, get);
    const conversationId = get().selectedId;
    try {
      if (!conversationId) {
        throw new Error('请先选择会话。');
      }
      set({ restoringSnapshotId: snapshotId, snapshotError: null });
      const restored = await transport.restoreSnapshot(conversationId, snapshotId);
      const [messages, context, snapshots] = await Promise.all([
        transport.listMessages(conversationId),
        transport.getContext(conversationId),
        transport.listSnapshots(conversationId),
      ]);
      if (get().selectedId === conversationId && get().messageMutationId === operationId) {
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId ? restored : conversation,
          ),
          conversationRevision: state.conversationRevision + 1,
          messages,
          context,
          snapshots,
          restoringSnapshotId: null,
          snapshotError: null,
        }));
      }
    } catch (error) {
      if (get().selectedId === conversationId) {
        set({
          restoringSnapshotId: null,
          snapshotError: error instanceof Error ? error.message : '快照恢复失败。',
        });
      }
      throw error;
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  send: async (transport, input) => {
    const trimmed = input.content.trim();
    if (!trimmed) {
      return;
    }
    assertMessageMutationIdle(get);
    if (get().loading) {
      throw new Error('会话正在加载，请稍候。');
    }
    if (get().streaming) {
      const conversationId = get().selectedId;
      if (!conversationId) return;
      set((state) => ({
        queuedPrompts: [
          ...state.queuedPrompts,
          {
            id: crypto.randomUUID(),
            conversationId,
            input: { ...input, content: trimmed },
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    let conversationId = get().selectedId;
    if (!conversationId) {
      conversationId = await get().createConversation(transport);
    }
    await sendToConversation(set, get, transport, conversationId, {
      ...input,
      content: trimmed,
    });
  },

  sendNextQueued: async (transport) => {
    if (get().streaming || get().loading || get().messageMutationId !== null) {
      return;
    }
    const conversationId = get().selectedId;
    const next = get().queuedPrompts.find((prompt) => prompt.conversationId === conversationId);
    if (!next) {
      return;
    }
    set((state) => ({
      queuedPrompts: state.queuedPrompts.filter((prompt) => prompt.id !== next.id),
    }));
    await get().send(transport, next.input);
  },

  updateQueuedPrompt: (id, content) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    set((state) => ({
      queuedPrompts: state.queuedPrompts.map((prompt) =>
        prompt.id === id ? { ...prompt, input: { ...prompt.input, content: trimmed } } : prompt,
      ),
    }));
  },

  moveQueuedPrompt: (id, direction) => {
    set((state) => {
      const index = state.queuedPrompts.findIndex((prompt) => prompt.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= state.queuedPrompts.length) {
        return state;
      }
      const queuedPrompts = [...state.queuedPrompts];
      const [prompt] = queuedPrompts.splice(index, 1);
      if (!prompt) return state;
      queuedPrompts.splice(target, 0, prompt);
      return { queuedPrompts };
    });
  },

  removeQueuedPrompt: (id) => {
    set((state) => ({
      queuedPrompts: state.queuedPrompts.filter((prompt) => prompt.id !== id),
    }));
  },

  stop: () => {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.role === 'assistant' &&
        (message.status === 'pending' || message.status === 'streaming')
          ? {
              ...message,
              content: message.content || '生成已停止。',
              status: 'cancelled',
              toolCalls: message.toolCalls?.map((toolCall) =>
                toolCall.status === 'running' || toolCall.status === 'pending'
                  ? { ...toolCall, status: 'cancelled' }
                  : toolCall,
              ),
            }
          : message,
      ),
    }));
    get().abortController?.abort();
  },

  decideFileChange: async (transport, changeId, decision) => {
    const conversationId = get().selectedId;
    if (!conversationId) {
      return;
    }
    const context = findFileChangeDecisionContext(get().messages, changeId);
    if (!context || context.fileChange.status !== 'pending') {
      return;
    }
    const decisionKey = `${conversationId}:${changeId}`;
    if (activeFileChangeDecisions.has(decisionKey)) {
      return;
    }
    const operationId = beginMessageMutation(set, get);
    activeFileChangeDecisions.add(decisionKey);

    const fileStatus = decision === 'accept' ? 'accepted' : 'rejected';
    const optimisticToolStatus = decision === 'accept' ? 'running' : 'rejected';
    const committedToolStatus = decision === 'accept' ? 'completed' : 'rejected';
    set((state) =>
      state.selectedId === conversationId
        ? {
            messages: applyFileChangeDecision(state.messages, {
              conversationId,
              changeId,
              fileStatus,
              toolCallId: context.toolCall?.id,
              toolStatus: optimisticToolStatus,
            }),
          }
        : state,
    );

    let decisionApplied = false;
    try {
      const result = await transport.decideFileChange(conversationId, changeId, decision);
      decisionApplied = true;
      if (get().selectedId === conversationId) {
        set((state) => ({
          messages: applyFileChangeDecision(state.messages, {
            conversationId,
            changeId,
            fileStatus,
            toolCallId: context.toolCall?.id,
            toolStatus: committedToolStatus,
          }).map((message) =>
            result !== undefined && message.toolCalls?.some((toolCall) => toolCall.id === result.id)
              ? updateToolCall(message, result)
              : message,
          ),
        }));
      }

      try {
        const persistedMessages = await transport.listMessages(conversationId);
        if (persistedMessages.length > 0 && get().selectedId === conversationId) {
          set({
            messages: applyFileChangeDecision(persistedMessages, {
              conversationId,
              changeId,
              fileStatus,
              toolCallId: context.toolCall?.id,
              toolStatus: committedToolStatus,
            }),
          });
        }
      } catch {
        // 文件决策已经提交；刷新失败时保留本地最终状态，稍后切换会话会重新加载。
      }

      if (transport.kind === 'desktop') {
        await streamToolContinuation(set, get, transport, {
          conversationId,
          model: context.parentAssistant?.model,
          toolCallId: continuationToolCallId(result),
        });
      }
    } catch (error) {
      if (!decisionApplied && get().selectedId === conversationId) {
        set((state) => ({
          messages: restoreFileChangeDecision(state.messages, {
            conversationId,
            changeId,
            previousFileChange: context.fileChange,
            previousToolCall: context.toolCall,
          }),
        }));
      }
      throw error;
    } finally {
      activeFileChangeDecisions.delete(decisionKey);
      finishMessageMutation(set, get, operationId);
    }
  },

  decideToolCall: async (transport, conversationId, toolCallId, decision) => {
    if (get().selectedId !== conversationId) {
      throw new Error('当前会话已切换，请在目标会话中重新执行。');
    }
    const parentAssistant = get().messages.find(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some((toolCall) => toolCall.id === toolCallId),
    );
    const continuationModel = parentAssistant?.model;
    const previous = get()
      .messages.flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const operationId = beginMessageMutation(set, get);
    set((state) => ({
      messages: state.messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls?.map((toolCall) =>
          toolCall.id === toolCallId
            ? {
                ...toolCall,
                status: decision === 'approve' ? 'running' : 'cancelled',
              }
            : toolCall,
        ),
      })),
    }));
    let decisionApplied = false;
    try {
      const result: unknown = await transport.executeToolCall(conversationId, toolCallId, decision);
      decisionApplied = true;
      const continuationId = continuationToolCallId(result);
      if (
        result !== null &&
        typeof result === 'object' &&
        'id' in result &&
        typeof result.id === 'string'
      ) {
        set((state) => ({
          messages: state.messages.map((message) =>
            message.toolCalls?.some((toolCall) => toolCall.id === result.id)
              ? updateToolCall(message, result as ToolCall)
              : message,
          ),
        }));
      }
      try {
        const persistedMessages = await transport.listMessages(conversationId);
        if (persistedMessages.length > 0 && get().selectedId === conversationId) {
          set({ messages: persistedMessages });
        }
      } catch {
        // 工具决定已执行；持久化刷新失败时保留本地状态，稍后切换会话会再次加载。
      }
      await streamToolContinuation(set, get, transport, {
        conversationId,
        model: continuationModel,
        toolCallId: continuationId,
      });
    } catch (error) {
      if (!decisionApplied) {
        set((state) => ({
          messages: state.messages.map((message) => ({
            ...message,
            toolCalls: message.toolCalls?.map((toolCall) =>
              toolCall.id === toolCallId && previous
                ? {
                    ...toolCall,
                    ...previous,
                    metadata: { ...(toolCall.metadata ?? {}), ...(previous.metadata ?? {}) },
                  }
                : toolCall,
            ),
          })),
        }));
      }
      throw error;
    } finally {
      finishMessageMutation(set, get, operationId);
    }
  },

  refreshQueue: async (transport) => {
    try {
      const queue = await transport.getQueueStatus();
      set({ queue });
    } catch {
      // 队列状态是辅助信息，失败时保留上一次状态，不打断主流程。
    }
  },

  clearError: () => set({ error: null }),
}));
