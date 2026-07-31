import { createHash, randomUUID } from 'node:crypto';

import {
  OpenAICompatibleClient,
  ProviderError,
  type OpenAICompatibleClientOptions,
  type ProviderStreamEvent,
  type RuntimeChatRequest,
} from '@e-agent/ai-runtime';
import type {
  ChatCompletionResponse,
  ChatMessageInput,
  ChatStreamEvent,
  ChatUsage,
  SendChatRequest,
  ToolCall,
} from '@e-agent/contracts';
import type {
  ConversationRow,
  ConversationsRepository,
  MemoriesRepository,
  ProjectsRepository,
  ResponseCacheRepository,
} from '@e-agent/database';
import type { AppLogger } from '@e-agent/observability';

import { ContextManager, estimateTokens, type ContextSourceInput } from './context-manager.js';
import {
  ConversationExecutionQueue,
  type ConversationExecutionLease,
} from './conversation-execution-queue.js';
import type { Actor } from './conversation-service.js';
import {
  DEFAULT_CONVERSATION_TITLES,
  deriveConversationTitle,
  isDefaultConversationTitle,
} from './conversation-title.js';
import { DomainError } from './errors.js';
import type { KeyPool } from './key-pool.js';
import type { ModelService } from './model-service.js';
import { assertProjectAccess } from './project-access.js';
import type { QueueLease, QueueSnapshot, RequestQueue } from './request-queue.js';
import type { SettingsService } from './settings-service.js';
import {
  inferSystemPromptLocale,
  inferSystemPromptScene,
  injectSystemPrompt,
  type SystemPromptSurface,
} from './system-prompt.js';
import type { UsageService } from './usage-service.js';

export interface ChatExecutionOptions {
  signal?: AbortSignal;
  onQueuePosition?: (position: number) => void;
}

export interface ChatRuntimeClient {
  streamChat(request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent>;
  close?(): Promise<void> | void;
}

export type ChatClientFactory = (options: OpenAICompatibleClientOptions) => ChatRuntimeClient;

async function closeRuntimeClient(client: ChatRuntimeClient | undefined): Promise<void> {
  try {
    await client?.close?.();
  } catch {
    // 资源清理失败不能覆盖已经生成的响应或原始上游错误。
  }
}

function messageText(message: ChatMessageInput): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : `[image:${part.imageUrl.url}]`))
    .join('\n');
}

function cacheKey(userId: string, idempotencyKey: string): string {
  return `chat:${createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex')}`;
}

function mergeToolDelta(
  calls: Map<number, { id: string; name: string; arguments: string }>,
  event: {
    index: number;
    id?: string | undefined;
    name?: string | undefined;
    arguments?: string | undefined;
    snapshot?: boolean | undefined;
  },
): void {
  const current = calls.get(event.index) ?? {
    id: `tool-call-${event.index}`,
    name: '',
    arguments: '',
  };
  if (event.id !== undefined && event.id.trim() !== '') {
    current.id = event.id.slice(0, 256);
  }
  if (event.snapshot === true) {
    if (event.name !== undefined) current.name = event.name;
    if (event.arguments !== undefined) current.arguments = event.arguments;
    calls.set(event.index, current);
    return;
  }
  if (event.name !== undefined) current.name += event.name;
  if (event.arguments !== undefined) current.arguments += event.arguments;
  calls.set(event.index, current);
}

function materializeToolCalls(
  calls: ReadonlyMap<number, { id: string; name: string; arguments: string }>,
): ToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name || 'unknown_tool',
        arguments: call.arguments,
      },
    }));
}

function estimateFallbackUsage(messages: readonly ChatMessageInput[], output: string): ChatUsage {
  const inputTokens = messages.reduce(
    (total, message) => total + estimateTokens(messageText(message)) + 4,
    0,
  );
  const outputTokens = output === '' ? 0 : estimateTokens(output);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** 完整聊天编排：上下文预算、队列、Key 池、SSE、持久化、成本与幂等缓存。 */
export class ChatService {
  readonly #conversationExecutions = new ConversationExecutionQueue();

  public constructor(
    private readonly dependencies: {
      conversations: ConversationsRepository;
      memories: MemoriesRepository;
      projects: ProjectsRepository;
      cache: ResponseCacheRepository;
      models: ModelService;
      keyPool: KeyPool;
      settings: SettingsService;
      usage: UsageService;
      queue: RequestQueue;
      logger?: AppLogger;
      clientFactory?: ChatClientFactory;
      systemPromptSurface?: SystemPromptSurface;
    },
  ) {}

  public async *stream(
    request: SendChatRequest,
    actor: Actor,
    options: ChatExecutionOptions = {},
  ): AsyncGenerator<ChatStreamEvent> {
    if (actor.role === 'viewer') throw new DomainError('FORBIDDEN', '只读成员不能发送消息');
    let existingConversation = this.validateConversationRequest(request, actor);
    const executionKey =
      request.conversationId !== undefined
        ? `conversation:${request.conversationId}`
        : request.idempotencyKey === undefined
          ? undefined
          : cacheKey(actor.id, request.idempotencyKey);
    let executionLease: ConversationExecutionLease | undefined;
    if (executionKey !== undefined) {
      executionLease = await this.#conversationExecutions.acquire(executionKey, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    let autoTitleConversationId: string | undefined;

    try {
      // 等待期间会话可能被删除或权限可能变化，进入临界区后必须重新校验。
      if (request.conversationId !== undefined) {
        existingConversation = this.validateConversationRequest(request, actor);
      }
      if (request.idempotencyKey !== undefined) {
        const cached = this.dependencies.cache.get<ChatCompletionResponse>(
          cacheKey(actor.id, request.idempotencyKey),
        );
        if (cached !== undefined) {
          yield {
            type: 'start',
            requestId: cached.requestId,
            conversationId: cached.conversationId,
            messageId: cached.messageId,
            model: cached.model,
            createdAt: new Date().toISOString(),
          };
          if (cached.reasoning !== undefined && cached.reasoning !== '') {
            yield { type: 'reasoning_delta', content: cached.reasoning };
          }
          if (cached.content !== '') yield { type: 'delta', content: cached.content };
          yield {
            type: 'usage',
            usage: { ...cached.usage, estimatedCostUsd: 0 },
            durationMs: 0,
            ...(cached.reasoningDurationMs === undefined
              ? {}
              : { reasoningDurationMs: cached.reasoningDurationMs }),
            cacheHit: true,
          };
          this.applyAutoTitle(cached.conversationId);
          yield { type: 'done', finishReason: cached.finishReason, messageId: cached.messageId };
          return;
        }
      }

      const conversation = this.resolveConversation(request, actor, existingConversation);
      autoTitleConversationId = conversation.id;
      const settings = this.dependencies.settings.get();
      const resolvedModelId = request.modelId ?? settings.defaultModels.chat ?? undefined;
      const model = this.dependencies.models.resolve({
        ...(resolvedModelId === undefined ? {} : { modelId: resolvedModelId }),
        ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
        ...(request.model === undefined ? {} : { remoteModel: request.model }),
      });
      const conversationId = conversation.id;
      const messageId = randomUUID();
      const requestId = randomUUID();
      const createdAt = new Date();
      const currentMessages = this.buildPromptMessages(conversationId, request.messages, {
        locale: inferSystemPromptLocale(request.messages),
        scene: inferSystemPromptScene({
          ...(request.skill === undefined ? {} : { skill: request.skill }),
          messages: request.messages,
        }),
        availableTools: request.tools?.map((tool) => tool.function.name) ?? [],
        surface: this.dependencies.systemPromptSurface ?? 'shared',
      });
      const triggerMessageId = this.persistLatestInput(
        conversationId,
        request.messages,
        request.userMessageId,
      );
      const sources = this.memorySources(conversation.projectId);
      const context = await new ContextManager({
        threshold: settings.contextCompressionThreshold,
        ...(settings.contextCompressionModelId === null
          ? {}
          : {
              summarizer: (messages: ChatMessageInput[], signal?: AbortSignal) =>
                this.summarizeContext({
                  messages,
                  modelId: settings.contextCompressionModelId!,
                  actor,
                  conversationId,
                  projectId: conversation.projectId,
                  ...(signal === undefined ? {} : { signal }),
                }),
            }),
      }).prepare({
        messages: currentMessages,
        contextWindow: model.contextWindow ?? 32_000,
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        sources,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const selected = this.dependencies.keyPool.select(model.providerId);
      const lease = yield* this.acquireChatLease(options);
      const startedAt = performance.now();
      let upstreamUsage: ChatUsage | undefined;
      let content = '';
      let reasoning = '';
      let reasoningStartedAt: number | undefined;
      let reasoningEndedAt: number | undefined;
      let finishReason: string | null = null;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let completed = false;
      let client: ChatRuntimeClient | undefined;

      try {
        yield {
          type: 'start',
          requestId,
          conversationId,
          messageId,
          model: model.remoteId,
          createdAt: createdAt.toISOString(),
        };
        const clientFactory =
          this.dependencies.clientFactory ??
          ((clientOptions) => new OpenAICompatibleClient(clientOptions));
        client = clientFactory({
          baseUrl: selected.provider.baseUrl,
          ...(selected.provider.type === 'ollama' ? { allowInsecureLoopback: true } : {}),
          ...(selected.apiKey === undefined ? {} : { apiKey: selected.apiKey }),
          ...(selected.proxyUrl === null ? {} : { proxyUrl: selected.proxyUrl }),
        });
        for await (const event of client.streamChat({
          model: model.remoteId,
          messages: context.messages,
          ...(request.tools === undefined ? {} : { tools: request.tools }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })) {
          if (event.type === 'delta') {
            if (reasoningStartedAt !== undefined) reasoningEndedAt = performance.now();
            content += event.content;
            yield event;
          } else if (event.type === 'reasoning_delta') {
            reasoningStartedAt ??= performance.now();
            reasoningEndedAt = performance.now();
            reasoning += event.content;
            yield event;
          } else if (event.type === 'tool_call_delta') {
            if (reasoningStartedAt !== undefined) reasoningEndedAt = performance.now();
            mergeToolDelta(toolCalls, event);
            yield event;
          } else if (event.type === 'usage') {
            upstreamUsage = event.usage;
          } else if (event.type === 'done') {
            finishReason = event.finishReason;
          }
        }
        completed = true;
        const usage = upstreamUsage?.totalTokens
          ? upstreamUsage
          : estimateFallbackUsage(context.messages, content);
        const estimatedCostUsd = this.estimateCost(
          usage.inputTokens,
          usage.outputTokens,
          model.inputPricePerMillion,
          model.outputPricePerMillion,
        );
        const normalizedUsage = { ...usage, estimatedCostUsd };
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        const reasoningDurationMs =
          reasoningStartedAt === undefined
            ? undefined
            : Math.max(0, Math.round((reasoningEndedAt ?? performance.now()) - reasoningStartedAt));
        const finalToolCalls = materializeToolCalls(toolCalls);
        const assistantInput = {
          id: messageId,
          conversationId,
          role: 'assistant',
          content,
          reasoning: reasoning || null,
          reasoningDurationMs: reasoningDurationMs ?? null,
          toolCallsJson: JSON.stringify(finalToolCalls),
          model: model.remoteId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        } as const;
        let assistantPersisted = true;
        if (triggerMessageId === undefined) {
          this.dependencies.conversations.addMessage(assistantInput);
        } else {
          assistantPersisted =
            this.dependencies.conversations.addMessageIfMessageExists(
              assistantInput,
              triggerMessageId,
            ) !== undefined;
        }
        this.dependencies.usage.record({
          userId: actor.id,
          projectId: conversation.projectId,
          conversationId,
          providerId: model.providerId,
          apiKeyId: selected.keyId,
          model: model.remoteId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          estimatedCostUsd,
          durationMs,
          cacheHit: false,
          successful: true,
        });
        this.dependencies.keyPool.recordUsage(selected.keyId, estimatedCostUsd, usage.totalTokens);
        const updatedConversation = this.dependencies.conversations.get(conversationId);
        if (
          assistantPersisted &&
          updatedConversation !== undefined &&
          updatedConversation.messageCount > 0 &&
          updatedConversation.messageCount % settings.autoSnapshotInterval === 0
        ) {
          this.dependencies.conversations.createSnapshot(conversationId);
        }
        const completion: ChatCompletionResponse = {
          requestId,
          conversationId,
          messageId,
          model: model.remoteId,
          content,
          ...(reasoning === '' ? {} : { reasoning }),
          ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
          toolCalls: finalToolCalls,
          finishReason,
          usage: normalizedUsage,
          durationMs,
          cacheHit: false,
        };
        if (request.idempotencyKey !== undefined) {
          this.dependencies.cache.set(
            cacheKey(actor.id, request.idempotencyKey),
            completion,
            24 * 60 * 60 * 1_000,
          );
        }
        yield {
          type: 'usage',
          usage: normalizedUsage,
          durationMs,
          ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
          cacheHit: false,
        };
        if (
          assistantPersisted &&
          updatedConversation !== undefined &&
          updatedConversation.messageCount >= 2 &&
          updatedConversation.autoTitlePending
        ) {
          this.applyAutoTitle(conversationId);
        }
        yield { type: 'done', finishReason, messageId };
      } catch (error) {
        const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
        this.dependencies.logger?.warn(
          {
            err: error,
            requestId,
            conversationId,
            providerId: model.providerId,
            model: model.remoteId,
          },
          '聊天请求失败',
        );
        this.dependencies.usage.record({
          userId: actor.id,
          projectId: conversation.projectId,
          conversationId,
          providerId: model.providerId,
          apiKeyId: selected.keyId,
          model: model.remoteId,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          durationMs,
          successful: false,
          errorCode: error instanceof ProviderError ? error.code : 'CHAT_FAILED',
        });
        yield {
          type: 'error',
          code: error instanceof ProviderError ? error.code : 'CHAT_FAILED',
          message: error instanceof Error ? error.message : '模型请求失败',
          retryable: error instanceof ProviderError ? error.retryable : false,
        };
      } finally {
        await closeRuntimeClient(client);
        lease.release();
        if (!completed) {
          const reasoningDurationMs =
            reasoningStartedAt === undefined
              ? undefined
              : Math.max(
                  0,
                  Math.round((reasoningEndedAt ?? performance.now()) - reasoningStartedAt),
                );
          const assistantInput = {
            id: messageId,
            conversationId,
            role: 'assistant',
            content,
            reasoning: reasoning || null,
            reasoningDurationMs: reasoningDurationMs ?? null,
            toolCallsJson: JSON.stringify(materializeToolCalls(toolCalls)),
            model: model.remoteId,
          } as const;
          let assistantPersisted = true;
          if (triggerMessageId === undefined) {
            this.dependencies.conversations.addMessage(assistantInput);
          } else {
            assistantPersisted =
              this.dependencies.conversations.addMessageIfMessageExists(
                assistantInput,
                triggerMessageId,
              ) !== undefined;
          }
          if (assistantPersisted) {
            this.applyAutoTitle(conversationId);
          }
        }
      }
    } finally {
      if (autoTitleConversationId !== undefined) {
        this.applyAutoTitle(autoTitleConversationId);
      }
      executionLease?.release();
    }
  }

  public async complete(
    request: SendChatRequest,
    actor: Actor,
    options: ChatExecutionOptions = {},
  ): Promise<ChatCompletionResponse> {
    let start: Extract<ChatStreamEvent, { type: 'start' }> | undefined;
    let content = '';
    let reasoning = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let usageEvent: Extract<ChatStreamEvent, { type: 'usage' }> | undefined;
    let finishReason: string | null = null;
    for await (const event of this.stream(request, actor, options)) {
      if (event.type === 'start') start = event;
      else if (event.type === 'delta') content += event.content;
      else if (event.type === 'reasoning_delta') reasoning += event.content;
      else if (event.type === 'tool_call_delta') mergeToolDelta(toolCalls, event);
      else if (event.type === 'usage') usageEvent = event;
      else if (event.type === 'done') finishReason = event.finishReason;
      else if (event.type === 'error') {
        throw new DomainError('PROVIDER_ERROR', event.message, {
          retryable: event.retryable,
          details: { providerCode: event.code },
        });
      }
    }
    if (start === undefined || usageEvent === undefined) {
      throw new DomainError('INTERNAL_ERROR', '聊天响应不完整');
    }
    return {
      requestId: start.requestId,
      conversationId: start.conversationId,
      messageId: start.messageId,
      model: start.model,
      content,
      ...(reasoning === '' ? {} : { reasoning }),
      ...(usageEvent.reasoningDurationMs === undefined
        ? {}
        : { reasoningDurationMs: usageEvent.reasoningDurationMs }),
      toolCalls: materializeToolCalls(toolCalls),
      finishReason,
      usage: usageEvent.usage,
      durationMs: usageEvent.durationMs,
      cacheHit: usageEvent.cacheHit,
    };
  }

  /**
   * 获取聊天并发租约，并将等待位置转换为聊天流事件。
   * acquire 的位置回调可能同步触发，因此先写入缓冲区，避免首个位置丢失。
   */
  private async *acquireChatLease(
    options: ChatExecutionOptions,
  ): AsyncGenerator<ChatStreamEvent, QueueLease> {
    const buffered: ChatStreamEvent[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let lease: QueueLease | undefined;
    let failure: unknown;
    let wasQueued = false;

    const notify = (): void => {
      wake?.();
      wake = undefined;
    };
    const pushQueueEvent = (position: number | null, snapshot: QueueSnapshot): void => {
      buffered.push({
        type: 'queue',
        position,
        active: snapshot.active,
        pending: snapshot.pending,
      });
      notify();
    };

    void this.dependencies.queue
      .acquire({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onPosition: (position, snapshot) => {
          wasQueued = true;
          options.onQueuePosition?.(position);
          pushQueueEvent(position, snapshot);
        },
      })
      .then(
        (acquiredLease) => {
          lease = acquiredLease;
          settled = true;
          if (wasQueued) pushQueueEvent(null, this.dependencies.queue.snapshot);
          notify();
        },
        (error: unknown) => {
          failure = error;
          settled = true;
          if (wasQueued) pushQueueEvent(null, this.dependencies.queue.snapshot);
          notify();
        },
      );

    while (!settled || buffered.length > 0) {
      if (buffered.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (settled || buffered.length > 0) notify();
        });
      }
      const event = buffered.shift();
      if (event !== undefined) yield event;
    }
    if (failure !== undefined) throw failure;
    if (lease === undefined) throw new DomainError('INTERNAL_ERROR', '请求队列未返回执行租约');
    return lease;
  }

  private validateConversationRequest(
    request: SendChatRequest,
    actor: Actor,
  ): ConversationRow | undefined {
    if (request.conversationId !== undefined) {
      const conversation = this.dependencies.conversations.get(request.conversationId);
      if (conversation === undefined) throw new DomainError('NOT_FOUND', '对话不存在');
      if (actor.role !== 'owner' && actor.role !== 'admin' && conversation.userId !== actor.id) {
        throw new DomainError('FORBIDDEN', '无权访问此对话');
      }
      if (request.projectId !== undefined && request.projectId !== conversation.projectId) {
        throw new DomainError('BAD_REQUEST', '不能覆盖已有对话绑定的项目');
      }
      if (conversation.projectId !== null) {
        assertProjectAccess(this.dependencies.projects, conversation.projectId, actor);
      }
      return conversation;
    }
    if (request.projectId !== undefined) {
      assertProjectAccess(this.dependencies.projects, request.projectId, actor);
    }
    return undefined;
  }

  private resolveConversation(
    request: SendChatRequest,
    actor: Actor,
    existingConversation: ConversationRow | undefined,
  ): ConversationRow {
    if (existingConversation !== undefined) return existingConversation;
    if (request.conversationId !== undefined) {
      return this.validateConversationRequest(request, actor)!;
    }
    return this.dependencies.conversations.create({
      projectId: request.projectId ?? null,
      userId: actor.id,
      title: deriveConversationTitle(request.messages),
    });
  }

  private buildPromptMessages(
    conversationId: string,
    inputMessages: ChatMessageInput[],
    systemPrompt: Parameters<typeof injectSystemPrompt>[1],
  ): ChatMessageInput[] {
    if (inputMessages.length > 1) return injectSystemPrompt(inputMessages, systemPrompt);
    const persisted = this.dependencies.conversations.listMessages(conversationId);
    const latestToolSequence = new Map<string, number>();
    for (const message of persisted) {
      if (message.role === 'tool' && message.parentMessageId !== null) {
        latestToolSequence.set(message.parentMessageId, message.sequence);
      }
    }
    const history = persisted
      .filter(
        (message) =>
          message.role !== 'tool' ||
          message.parentMessageId === null ||
          latestToolSequence.get(message.parentMessageId) === message.sequence,
      )
      .map(
        (message) =>
          ({
            role: message.role,
            content: message.content,
            ...(message.role === 'assistant'
              ? { toolCalls: JSON.parse(message.toolCallsJson) as ToolCall[] }
              : {}),
            ...(message.role === 'tool' && message.parentMessageId !== null
              ? { toolCallId: message.parentMessageId }
              : {}),
          }) satisfies ChatMessageInput,
      );
    return injectSystemPrompt([...history, ...inputMessages], systemPrompt);
  }

  private persistLatestInput(
    conversationId: string,
    inputMessages: ChatMessageInput[],
    userMessageId?: string,
  ): string | undefined {
    const latest = inputMessages.at(-1);
    if (userMessageId !== undefined && latest?.role !== 'user') {
      throw new DomainError('BAD_REQUEST', '用户消息标识只能用于请求末尾的用户消息');
    }
    if (latest === undefined || latest.role === 'assistant' || latest.role === 'system') {
      return undefined;
    }
    const content = messageText(latest);
    if (latest.role === 'user' && userMessageId !== undefined) {
      const persisted = this.dependencies.conversations.getMessageById(userMessageId);
      if (persisted !== undefined) {
        throw new DomainError('CONFLICT', '用户消息标识已被占用，请勿重复提交同一条消息');
      }
      return this.dependencies.conversations.addMessage({
        id: userMessageId,
        conversationId,
        role: latest.role,
        content,
        toolCallsJson: JSON.stringify(latest.toolCalls ?? []),
        parentMessageId: latest.toolCallId ?? null,
      }).id;
    }
    const existing = this.dependencies.conversations.listMessages(conversationId).at(-1);
    if (existing?.role === latest.role && existing.content === content) return existing.id;
    return this.dependencies.conversations.addMessage({
      conversationId,
      role: latest.role,
      content,
      toolCallsJson: JSON.stringify(latest.toolCalls ?? []),
      parentMessageId: latest.toolCallId ?? null,
    }).id;
  }

  private memorySources(projectId: string | null | undefined): ContextSourceInput[] {
    if (projectId === undefined || projectId === null) return [];
    return this.dependencies.memories.list(projectId).map((memory) => ({
      source: 'memory',
      content: `[${memory.category}] ${memory.content}`,
    }));
  }

  private async summarizeContext(input: {
    messages: ChatMessageInput[];
    modelId: string;
    actor: Actor;
    conversationId: string;
    projectId: string | null;
    signal?: AbortSignal;
  }): Promise<string> {
    const model = this.dependencies.models.resolve({ modelId: input.modelId });
    const selected = this.dependencies.keyPool.select(model.providerId);
    const lease = await this.dependencies.queue.acquire({
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const startedAt = performance.now();
    let content = '';
    let upstreamUsage: ChatUsage | undefined;
    let client: ChatRuntimeClient | undefined;
    try {
      const transcript = input.messages
        .map((message) => `${message.role}: ${messageText(message)}`)
        .join('\n')
        .slice(-Math.max(8_000, (model.contextWindow ?? 16_000) * 3));
      const clientFactory =
        this.dependencies.clientFactory ??
        ((clientOptions) => new OpenAICompatibleClient(clientOptions));
      client = clientFactory({
        baseUrl: selected.provider.baseUrl,
        ...(selected.provider.type === 'ollama' ? { allowInsecureLoopback: true } : {}),
        ...(selected.apiKey === undefined ? {} : { apiKey: selected.apiKey }),
        ...(selected.proxyUrl === null ? {} : { proxyUrl: selected.proxyUrl }),
      });
      const prompt: ChatMessageInput[] = [
        {
          role: 'system',
          content:
            '请把旧对话压缩为可继续编程任务的事实摘要。保留需求、约束、文件/符号名、已做决定、错误与未完成事项；不要添加新事实，只输出摘要。',
        },
        { role: 'user', content: transcript },
      ];
      for await (const event of client.streamChat({
        model: model.remoteId,
        messages: prompt,
        temperature: 0.1,
        maxTokens: Math.min(2_048, Math.max(256, model.contextWindow ?? 2_048)),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })) {
        if (event.type === 'delta') content += event.content;
        else if (event.type === 'usage') upstreamUsage = event.usage;
      }
      if (content.trim() === '') throw new Error('摘要模型返回空内容');
      const usage = upstreamUsage?.totalTokens
        ? upstreamUsage
        : estimateFallbackUsage(prompt, content);
      const estimatedCostUsd = this.estimateCost(
        usage.inputTokens,
        usage.outputTokens,
        model.inputPricePerMillion,
        model.outputPricePerMillion,
      );
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      this.dependencies.usage.record({
        userId: input.actor.id,
        projectId: input.projectId,
        conversationId: input.conversationId,
        providerId: model.providerId,
        apiKeyId: selected.keyId,
        model: model.remoteId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        estimatedCostUsd,
        durationMs,
        cacheHit: false,
        successful: true,
      });
      this.dependencies.keyPool.recordUsage(selected.keyId, estimatedCostUsd, usage.totalTokens);
      return content.trim();
    } catch (error) {
      this.dependencies.logger?.warn(
        {
          err: error,
          conversationId: input.conversationId,
          model: model.remoteId,
        },
        '上下文摘要模型不可用，回退到本地压缩',
      );
      throw error;
    } finally {
      await closeRuntimeClient(client);
      lease.release();
    }
  }

  private estimateCost(
    inputTokens: number,
    outputTokens: number,
    inputPricePerMillion: number | null,
    outputPricePerMillion: number | null,
  ): number {
    return (
      (inputTokens * (inputPricePerMillion ?? 0) + outputTokens * (outputPricePerMillion ?? 0)) /
      1_000_000
    );
  }

  /**
   * done 事件前完成一次很小的 SQLite 事务，使 done 明确表示回复与标题均已持久化；
   * Repository 内的条件更新负责跨请求幂等，并保护并发的手动重命名。
   */
  private applyAutoTitle(conversationId: string): void {
    try {
      const conversation = this.dependencies.conversations.get(conversationId);
      if (
        conversation === undefined ||
        conversation.messageCount < 1 ||
        !conversation.autoTitlePending ||
        !isDefaultConversationTitle(conversation.title)
      ) {
        return;
      }
      const firstMessages = this.dependencies.conversations.listFirstMessages(conversationId);
      if (firstMessages[0]?.role !== 'user') return;
      const title = deriveConversationTitle(
        [{ role: 'user', content: firstMessages[0].content }],
        firstMessages[1]?.role === 'assistant' ? firstMessages[1].content : '',
      );
      this.dependencies.conversations.updateTitleAfterFirstExchange(
        conversationId,
        title,
        DEFAULT_CONVERSATION_TITLES,
      );
    } catch (error) {
      this.dependencies.logger?.warn(
        { err: error, conversationId },
        '自动生成对话标题失败，保留默认标题',
      );
    }
  }
}
