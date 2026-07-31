import {
  branchConversationRequestSchema,
  conversationListQuerySchema,
  createConversationRequestSchema,
  createFileChangeRequestSchema,
  decideFileChangeRequestSchema,
  deleteMessageQuerySchema,
  messageFeedbackRequestSchema,
  resourceIdSchema,
  updateConversationRequestSchema,
  updateFileChangeRequestSchema,
} from '@e-agent/contracts';
import { ContextManager } from '@e-agent/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireActor } from '../auth.js';

function idParam(value: unknown, field = 'id'): string {
  return resourceIdSchema.parse((value as Record<string, unknown>)[field]);
}

const contextQuerySchema = z.object({
  contextWindow: z.coerce.number().int().min(256).max(2_000_000).default(32_000),
  maxOutputTokens: z.coerce.number().int().positive().optional(),
});

export function registerConversationRoutes(app: FastifyInstance): void {
  app.get('/api/v1/conversations', async (request) =>
    app.eAgent.services.conversations.list(
      conversationListQuerySchema.parse(request.query),
      requireActor(request),
    ),
  );

  app.post('/api/v1/conversations', async (request, reply) => {
    const conversation = app.eAgent.services.conversations.create(
      createConversationRequestSchema.parse(request.body ?? {}),
      requireActor(request),
    );
    reply.code(201);
    return conversation;
  });

  app.get('/api/v1/conversations/:id', async (request) =>
    app.eAgent.services.conversations.get(idParam(request.params), requireActor(request)),
  );

  app.patch('/api/v1/conversations/:id', async (request) =>
    app.eAgent.services.conversations.update(
      idParam(request.params),
      updateConversationRequestSchema.parse(request.body),
      requireActor(request),
    ),
  );

  app.delete('/api/v1/conversations/:id', async (request, reply) => {
    app.eAgent.services.conversations.delete(idParam(request.params), requireActor(request));
    reply.code(204).send();
  });

  app.post('/api/v1/conversations/:id/branch', async (request, reply) => {
    const branch = app.eAgent.services.conversations.branch(
      idParam(request.params),
      branchConversationRequestSchema.parse(request.body),
      requireActor(request),
    );
    reply.code(201);
    return branch;
  });

  app.delete('/api/v1/conversations/:id/messages/:messageId', async (request) =>
    app.eAgent.services.conversations.deleteMessage(
      idParam(request.params),
      idParam(request.params, 'messageId'),
      deleteMessageQuerySchema.parse(request.query ?? {}),
      requireActor(request),
    ),
  );

  app.patch('/api/v1/conversations/:id/messages/:messageId/feedback', async (request) =>
    app.eAgent.services.conversations.updateMessageFeedback(
      idParam(request.params),
      idParam(request.params, 'messageId'),
      messageFeedbackRequestSchema.parse(request.body),
      requireActor(request),
    ),
  );

  app.get('/api/v1/conversations/:id/snapshots', async (request) =>
    app.eAgent.services.conversations.listSnapshots(idParam(request.params), requireActor(request)),
  );

  app.post('/api/v1/conversations/:id/snapshots', async (request, reply) => {
    const snapshot = app.eAgent.services.conversations.createSnapshot(
      idParam(request.params),
      requireActor(request),
    );
    reply.code(201);
    return snapshot;
  });

  app.post('/api/v1/conversations/:id/snapshots/:snapshotId/restore', async (request) =>
    app.eAgent.services.conversations.restoreSnapshot(
      idParam(request.params),
      idParam(request.params, 'snapshotId'),
      requireActor(request),
    ),
  );

  app.get('/api/v1/conversations/:id/context', async (request) => {
    const actor = requireActor(request);
    const detail = app.eAgent.services.conversations.get(idParam(request.params), actor);
    const query = contextQuerySchema.parse(request.query);
    const prepared = await new ContextManager({
      threshold: app.eAgent.services.settings.get().contextCompressionThreshold,
    }).prepare({
      messages: detail.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCalls.length === 0 ? {} : { toolCalls: message.toolCalls }),
      })),
      contextWindow: query.contextWindow,
      ...(query.maxOutputTokens === undefined ? {} : { maxOutputTokens: query.maxOutputTokens }),
    });
    return {
      conversationId: detail.conversation.id,
      messageCount: detail.messages.length,
      preparedMessageCount: prepared.messages.length,
      breakdown: prepared.breakdown,
    };
  });

  app.get('/api/v1/conversations/:id/file-changes', async (request) =>
    app.eAgent.services.conversations.listFileChanges(
      idParam(request.params),
      requireActor(request),
    ),
  );

  app.post('/api/v1/conversations/:id/file-changes', async (request, reply) => {
    const change = app.eAgent.services.conversations.createFileChange(
      idParam(request.params),
      createFileChangeRequestSchema.parse(request.body),
      requireActor(request),
    );
    reply.code(201);
    return change;
  });

  app.patch('/api/v1/conversations/:id/file-changes/:changeId', async (request) =>
    app.eAgent.services.conversations.decideFileChange(
      idParam(request.params),
      idParam(request.params, 'changeId'),
      updateFileChangeRequestSchema.parse(request.body),
      requireActor(request),
    ),
  );

  app.post('/api/v1/conversations/:id/file-changes/:changeId', async (request) => {
    const input = decideFileChangeRequestSchema.parse(request.body);
    return app.eAgent.services.conversations.decideFileChange(
      idParam(request.params),
      idParam(request.params, 'changeId'),
      {
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        ...(input.acceptedLines === undefined ? {} : { acceptedLines: input.acceptedLines }),
      },
      requireActor(request),
    );
  });
}
