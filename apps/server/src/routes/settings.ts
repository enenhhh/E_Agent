import { updateSettingsRequestSchema } from '@e-agent/contracts';
import type { FastifyInstance } from 'fastify';

import { requireActor, requireRole } from '../auth.js';

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/v1/settings', async (request) => {
    requireActor(request);
    return app.eAgent.services.settings.get();
  });

  app.patch('/api/v1/settings', async (request) => {
    const actor = requireRole(request, ['owner', 'admin']);
    return app.eAgent.services.settings.update(
      updateSettingsRequestSchema.parse(request.body),
      'global',
      actor.id,
    );
  });
}
