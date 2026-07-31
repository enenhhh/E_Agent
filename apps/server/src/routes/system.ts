import { auditQuerySchema, chatMessageInputSchema } from '@e-agent/contracts';
import { ContextManager } from '@e-agent/core';
import { DATABASE_SCHEMA_VERSION } from '@e-agent/database';
import { sampleRuntimeHealth } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireActor, requireRole } from '../auth.js';

const contextEstimateSchema = z.object({
  messages: z.array(chatMessageInputSchema).max(500),
  contextWindow: z.number().int().min(256).max(2_000_000),
  maxOutputTokens: z.number().int().positive().optional(),
  threshold: z.number().min(0.5).max(0.9).default(0.7),
  sources: z
    .array(
      z.object({
        source: z.enum(['system', 'history', 'file', 'folder', 'web', 'memory']),
        content: z.string(),
      }),
    )
    .max(100)
    .default([]),
});

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/api/v1/system/status', async (request) => {
    requireActor(request);
    app.eAgent.database.sqlite.prepare('SELECT 1').get();
    return {
      status: 'ok',
      version: process.env['npm_package_version'] ?? '0.1.2',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      queue: app.eAgent.services.queue.snapshot,
      runtime: await sampleRuntimeHealth(),
      extensionsReady: app.eAgent.extensions !== null,
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/api/v1/queue/status', async (request) => {
    requireActor(request);
    return app.eAgent.services.queue.snapshot;
  });

  app.post('/api/v1/context/estimate', async (request) => {
    requireActor(request);
    const input = contextEstimateSchema.parse(request.body);
    return new ContextManager({ threshold: input.threshold }).prepare({
      messages: input.messages,
      contextWindow: input.contextWindow,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      sources: input.sources,
    });
  });

  app.get('/api/v1/audit', async (request) => {
    requireRole(request, ['owner', 'admin']);
    return app.eAgent.services.audit.list(auditQuerySchema.parse(request.query));
  });
}
