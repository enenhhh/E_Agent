import {
  discoverModelsRequestSchema,
  resourceIdSchema,
  updateProviderModelSelectionRequestSchema,
} from '@e-agent/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireActor, requireRole } from '../auth.js';

const modelListQuery = z.object({ providerId: z.string().uuid().optional() });

export function registerModelRoutes(app: FastifyInstance): void {
  app.get('/api/v1/models', async (request) => {
    requireActor(request);
    const query = modelListQuery.parse(request.query);
    return app.eAgent.services.models.list(query.providerId);
  });

  app.post('/api/v1/models/discover', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const input = discoverModelsRequestSchema.parse(request.body ?? {});
    return {
      results: await app.eAgent.services.models.discover(input.providerId),
      models: app.eAgent.services.models.list(input.providerId).models,
    };
  });

  app.patch('/api/v1/providers/:id/models', async (request) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const providerId = resourceIdSchema.parse((request.params as { id?: unknown }).id);
    const input = updateProviderModelSelectionRequestSchema.parse(request.body);
    return app.eAgent.services.models.updateEnabledSelection(
      providerId,
      input.enabledModelIds,
      actor.id,
    );
  });
}
