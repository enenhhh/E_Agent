import { usageQuerySchema } from '@e-agent/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireActor, requireRole } from '../auth.js';

const exportQuerySchema = usageQuerySchema.extend({
  format: z.enum(['csv', 'json', 'pdf']).default('csv'),
});

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get('/api/v1/usage/records', async (request) => {
    const actor = requireActor(request);
    return {
      records: app.eAgent.services.usage.records(usageQuerySchema.parse(request.query), actor),
    };
  });

  app.get('/api/v1/usage/summary', async (request) => {
    const actor = requireActor(request);
    return app.eAgent.services.usage.summary(usageQuerySchema.parse(request.query), actor);
  });

  app.get('/api/v1/usage/export', async (request, reply) => {
    requireRole(request, ['owner', 'admin']);
    const { format, ...query } = exportQuerySchema.parse(request.query);
    const report = await app.eAgent.services.usage.export(query, format);
    reply.header('content-type', report.contentType);
    reply.header('content-disposition', `attachment; filename="${report.filename}"`);
    return reply.send(Buffer.from(report.data));
  });
}
