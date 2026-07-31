import { sampleRuntimeHealth, metrics } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/live', async () => ({
    status: 'ok',
    service: 'e-agent-server',
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      app.eAgent.database.sqlite.prepare('SELECT 1').get();
      return {
        status: 'ready',
        database: 'ok',
        queue: app.eAgent.services.queue.snapshot,
        runtime: await sampleRuntimeHealth(),
        timestamp: new Date().toISOString(),
      };
    } catch {
      reply.code(503);
      return { status: 'not-ready', database: 'error', timestamp: new Date().toISOString() };
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.renderPrometheus();
  });
}
