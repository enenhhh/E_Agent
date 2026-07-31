import { randomUUID } from 'node:crypto';

import {
  cancelChatStreamResponseSchema,
  resourceIdSchema,
  sendChatRequestSchema,
  type ChatStreamEvent,
  type SendChatRequest,
} from '@e-agent/contracts';
import { DomainError } from '@e-agent/core';
import type { FastifyInstance } from 'fastify';

import { requireActor } from '../auth.js';
import { prepareChatInput } from '../chat-input.js';
import { encodeSseEvent, idParam, writeSse } from '../http.js';
import type { ServerHookPayloadMap } from '../plugin-hooks.js';

type ChatRequestMetadata = ServerHookPayloadMap['request:before']['request'];
type ChatResponseMetadata = ServerHookPayloadMap['request:after']['response'];

interface ActiveChatStream {
  actorId: string;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
}

const preCancellationTtlMs = 10 * 60_000;
const maximumPreCancellations = 10_000;

function preCancellationKey(actorId: string, cancellationId: string): string {
  return JSON.stringify([actorId, cancellationId]);
}

function prunePreCancellations(preCancellations: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of preCancellations) {
    if (expiresAt <= now) preCancellations.delete(key);
  }
  while (preCancellations.size >= maximumPreCancellations) {
    const oldest = preCancellations.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    preCancellations.delete(oldest);
  }
}

function createActiveChatStream(actorId: string, controller: AbortController): ActiveChatStream {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { actorId, controller, settled, settle };
}

function countRequestMetadata(input: SendChatRequest): ChatRequestMetadata {
  let textCharacterCount = 0;
  let imageCount = 0;
  for (const message of input.messages) {
    if (typeof message.content === 'string') {
      textCharacterCount += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') textCharacterCount += part.text.length;
      else imageCount += 1;
    }
  }
  return {
    stream: input.stream,
    messageCount: input.messages.length,
    textCharacterCount,
    imageCount,
    toolCount: input.tools?.length ?? 0,
    contextMentionCount: input.contextMentions?.length ?? 0,
    hasConversation: input.conversationId !== undefined,
    hasProject: input.projectId !== undefined,
    hasExplicitModel: input.modelId !== undefined || input.model !== undefined,
    hasProvider: input.providerId !== undefined,
    hasSkill: input.skill !== undefined,
  };
}

function normalizeRequestId(value: unknown): string {
  const normalized = String(value).slice(0, 128);
  return normalized === '' ? randomUUID() : normalized;
}

function routeErrorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
}

function providerErrorCode(value: string): string {
  if (
    [
      'CHAT_FAILED',
      'INVALID_PROVIDER_STREAM',
      'PROVIDER_ERROR',
      'PROVIDER_NETWORK_ERROR',
      'PROVIDER_TIMEOUT',
    ].includes(value)
  ) {
    return value;
  }
  return /^HTTP_[1-5]\d{2}$/.test(value) ? 'PROVIDER_HTTP_ERROR' : 'PROVIDER_ERROR';
}

function emptyResponseMetadata(): ChatResponseMetadata {
  return {
    conversationId: null,
    messageId: null,
    cacheHit: null,
  };
}

export function registerChatRoutes(app: FastifyInstance): void {
  const activeStreams = new Map<string, ActiveChatStream>();
  const preCancellations = new Map<string, number>();

  app.post('/api/v1/chat/completions/:cancellationId/cancel', async (request) => {
    const actor = requireActor(request);
    const cancellationId = resourceIdSchema.parse(idParam(request.params, 'cancellationId'));
    const active = activeStreams.get(cancellationId);
    if (active === undefined) {
      const now = Date.now();
      prunePreCancellations(preCancellations, now);
      preCancellations.set(
        preCancellationKey(actor.id, cancellationId),
        now + preCancellationTtlMs,
      );
      return cancelChatStreamResponseSchema.parse({ cancellationId, settled: true });
    }
    if (active.actorId !== actor.id) {
      throw new DomainError('NOT_FOUND', '流式请求不存在');
    }

    active.controller.abort(new Error('用户已停止生成'));
    await active.settled;
    return cancelChatStreamResponseSchema.parse({ cancellationId, settled: true });
  });

  app.post('/api/v1/chat/completions', async (request, reply) => {
    const actor = requireActor(request);
    if (actor.role === 'viewer') {
      throw new DomainError('FORBIDDEN', '只读成员不能发送消息');
    }
    const parsed = sendChatRequestSchema.parse(request.body);
    const hookRequest = countRequestMetadata(parsed);
    const hookRequestId = normalizeRequestId(request.id);
    const hookStartedAt = performance.now();
    const extensions = app.eAgent.extensions;
    const hookContext = { actorId: actor.id };
    let activeStream: ActiveChatStream | undefined;
    await extensions?.runHook(
      'request:before',
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        requestId: hookRequestId,
        actor,
        operation: 'chat.completion',
        request: hookRequest,
      },
      hookContext,
    );

    let afterHookFinished = false;
    const finishHook = async (input: {
      success: boolean;
      errorCode: string | null;
      response: ChatResponseMetadata;
    }): Promise<void> => {
      if (afterHookFinished) return;
      afterHookFinished = true;
      await extensions?.runHook(
        'request:after',
        {
          schemaVersion: 1,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          requestId: hookRequestId,
          actor,
          operation: 'chat.completion',
          request: hookRequest,
          outcome: {
            success: input.success,
            durationMs: Math.max(0, Math.round(performance.now() - hookStartedAt)),
            errorCode: input.errorCode,
          },
          response: input.response,
        },
        hookContext,
      );
    };

    try {
      const input = await prepareChatInput(
        app,
        parsed,
        typeof request.headers['accept-language'] === 'string'
          ? request.headers['accept-language']
          : undefined,
      );
      if (!input.stream) {
        const completion = await app.eAgent.services.chat.complete(input, actor);
        await finishHook({
          success: true,
          errorCode: null,
          response: {
            conversationId: completion.conversationId,
            messageId: completion.messageId,
            cacheHit: completion.cacheHit,
          },
        });
        return completion;
      }

      const controller = new AbortController();
      if (input.cancellationId !== undefined) {
        if (activeStreams.has(input.cancellationId)) {
          throw new DomainError('CONFLICT', '流式请求取消标识正在使用');
        }
        activeStream = createActiveChatStream(actor.id, controller);
        activeStreams.set(input.cancellationId, activeStream);
        const preCancellationId = preCancellationKey(actor.id, input.cancellationId);
        const preCancellationExpiresAt = preCancellations.get(preCancellationId);
        preCancellations.delete(preCancellationId);
        if (preCancellationExpiresAt !== undefined && preCancellationExpiresAt > Date.now()) {
          controller.abort(new Error('用户已停止生成'));
        }
      }
      request.raw.once('aborted', () => controller.abort(new Error('客户端已断开')));
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) controller.abort(new Error('客户端已断开'));
      });
      const generator = app.eAgent.services.chat.stream(input, actor, {
        signal: controller.signal,
      });
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await generator.next();
      } catch (error) {
        try {
          await generator.return(undefined);
        } finally {
          await finishHook({
            success: false,
            errorCode: routeErrorCode(error),
            response: emptyResponseMetadata(),
          });
        }
        throw error;
      }

      const streamResponse = emptyResponseMetadata();
      let streamErrorCode: string | null = null;
      const observe = (event: ChatStreamEvent): void => {
        if (event.type === 'start') {
          streamResponse.conversationId = event.conversationId;
          streamResponse.messageId = event.messageId;
        } else if (event.type === 'usage') {
          streamResponse.cacheHit = event.cacheHit;
        } else if (event.type === 'done') {
          streamResponse.messageId = event.messageId;
        } else if (event.type === 'error') {
          streamErrorCode = providerErrorCode(event.code);
        }
      };

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders();
      try {
        if (!first.done) {
          observe(first.value);
          await writeSse(reply, encodeSseEvent(first.value));
        }
        let next = await generator.next();
        while (!next.done) {
          observe(next.value);
          await writeSse(reply, encodeSseEvent(next.value));
          next = await generator.next();
        }
      } catch (error) {
        streamErrorCode = routeErrorCode(error);
        const event: ChatStreamEvent = {
          type: 'error',
          code: streamErrorCode,
          message: error instanceof Error ? error.message : '流式响应失败',
          retryable: error instanceof DomainError ? error.retryable : false,
        };
        if (!reply.raw.destroyed) await writeSse(reply, encodeSseEvent(event));
      } finally {
        try {
          await generator.return(undefined);
        } catch {
          streamErrorCode ??= 'STREAM_CLEANUP_FAILED';
        }
        if (!reply.raw.destroyed) reply.raw.end();
        await finishHook({
          success: streamErrorCode === null,
          errorCode: streamErrorCode,
          response: streamResponse,
        });
      }
      return undefined;
    } catch (error) {
      await finishHook({
        success: false,
        errorCode: routeErrorCode(error),
        response: emptyResponseMetadata(),
      });
      throw error;
    } finally {
      if (activeStream !== undefined && parsed.cancellationId !== undefined) {
        if (activeStreams.get(parsed.cancellationId) === activeStream) {
          activeStreams.delete(parsed.cancellationId);
        }
        activeStream.settle();
      }
    }
  });
}
