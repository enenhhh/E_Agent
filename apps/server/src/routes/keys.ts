import {
  createApiKeyRequestSchema,
  createProviderRequestSchema,
  resourceIdSchema,
  updateApiKeyRequestSchema,
  updateProviderRequestSchema,
} from '@e-agent/contracts';
import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.js';

function idParam(value: unknown): string {
  return resourceIdSchema.parse((value as { id?: unknown }).id);
}

export function registerKeyRoutes(app: FastifyInstance): void {
  app.get('/api/v1/keys', async (request) => {
    requireRole(request, ['owner', 'admin']);
    return app.eAgent.services.keys.list();
  });

  app.get('/api/v1/providers', async (request) => {
    requireRole(request, ['owner', 'admin', 'member', 'viewer']);
    return { providers: app.eAgent.services.keys.list().providers };
  });

  app.post('/api/v1/providers', async (request, reply) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const provider = app.eAgent.services.keys.createProvider(
      createProviderRequestSchema.parse(request.body),
      actor.id,
    );
    reply.code(201);
    return provider;
  });

  app.patch('/api/v1/providers/:id', async (request) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const providerId = idParam(request.params);
    const before = app.eAgent.services.keys
      .list()
      .providers.find((provider) => provider.id === providerId);
    const provider = app.eAgent.services.keys.updateProvider(
      providerId,
      updateProviderRequestSchema.parse(request.body),
      actor.id,
    );
    const endpointChanged =
      before !== undefined &&
      (before.type !== provider.type || before.baseUrl !== provider.baseUrl);
    const reenabled = before !== undefined && !before.enabled && provider.enabled;
    let modelDiscoveryError: string | null = null;
    if (endpointChanged || reenabled) {
      app.eAgent.services.models.invalidateProvider(providerId);
      if (provider.enabled) {
        const [result] = await app.eAgent.services.models.discover(providerId);
        modelDiscoveryError = result?.error ?? null;
      }
    }
    return {
      ...provider,
      ...(modelDiscoveryError === null ? {} : { modelDiscoveryError }),
    };
  });

  app.post('/api/v1/keys', async (request, reply) => {
    const actor = requireRole(request, ['owner', 'admin']);
    const key = app.eAgent.services.keys.create(
      createApiKeyRequestSchema.parse(request.body),
      actor.id,
    );
    reply.code(201);
    return key;
  });

  app.patch('/api/v1/keys/:id', async (request) => {
    const actor = requireRole(request, ['owner', 'admin']);
    return app.eAgent.services.keys.update(
      idParam(request.params),
      updateApiKeyRequestSchema.parse(request.body),
      actor.id,
    );
  });

  app.delete('/api/v1/keys/:id', async (request, reply) => {
    const actor = requireRole(request, ['owner', 'admin']);
    app.eAgent.services.keys.delete(idParam(request.params), actor.id);
    reply.code(204).send();
  });

  app.post('/api/v1/keys/:id/check', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const id = idParam(request.params);
    const result = await app.eAgent.services.keys.check(id);
    const key = app.eAgent.services.keys.list().keys.find((candidate) => candidate.id === id);
    return key === undefined ? result : { ...key, ...result };
  });

  app.post('/api/v1/keys/check-all', async (request) => {
    requireRole(request, ['owner', 'admin']);
    const results = await app.eAgent.services.keys.checkAll();
    return { results, keys: app.eAgent.services.keys.list().keys };
  });
}
