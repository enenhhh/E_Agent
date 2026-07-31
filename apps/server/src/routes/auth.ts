import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  createMemberRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  updateMemberRequestSchema,
} from '@e-agent/contracts';
import { DomainError } from '@e-agent/core';
import type { Actor } from '@e-agent/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { requireActor, requireRole } from '../auth.js';
import { idParam } from '../http.js';

const BOOTSTRAP_TOKEN_HEADER = 'x-e-agent-bootstrap-token';

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bootstrapTokenMatches(expected: string, provided: string): boolean {
  const expectedDigest = tokenDigest(expected);
  const providedDigest = tokenDigest(provided);
  try {
    return timingSafeEqual(expectedDigest, providedDigest);
  } finally {
    expectedDigest.fill(0);
    providedDigest.fill(0);
  }
}

function assertBootstrapRegistrationAllowed(
  app: FastifyInstance,
  request: FastifyRequest,
  options: { environment: 'development' | 'test' | 'production'; bootstrapToken: string | null },
): void {
  if (options.environment !== 'production' || app.eAgent.services.auth.isInitialized()) return;
  const header = request.headers[BOOTSTRAP_TOKEN_HEADER];
  const provided = typeof header === 'string' ? header : undefined;
  if (
    options.bootstrapToken === null ||
    provided === undefined ||
    !bootstrapTokenMatches(options.bootstrapToken, provided)
  ) {
    throw new DomainError('FORBIDDEN', '生产环境首个 Owner 注册凭据无效');
  }
}

function hookRequestId(request: FastifyRequest): string {
  const value = String(request.id).slice(0, 128);
  return value === '' ? randomUUID() : value;
}

async function emitSessionCreated(
  app: FastifyInstance,
  request: FastifyRequest,
  actor: Actor,
  flow: 'login' | 'register',
): Promise<void> {
  await app.eAgent.extensions?.runHook(
    'session:created',
    {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      requestId: hookRequestId(request),
      actor,
      operation: 'session.created',
      flow,
    },
    { actorId: actor.id },
  );
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: { environment: 'development' | 'test' | 'production'; bootstrapToken: string | null },
): void {
  app.get('/api/v1/auth/status', async () => {
    const initialized = app.eAgent.services.auth.isInitialized();
    return {
      initialized,
      bootstrapTokenRequired: !initialized && options.environment === 'production',
    };
  });

  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertBootstrapRegistrationAllowed(app, request, options);
      const response = await app.eAgent.services.auth.register(
        registerRequestSchema.parse(request.body),
      );
      await emitSessionCreated(
        app,
        request,
        { id: response.user.id, role: response.user.role },
        'register',
      );
      reply.code(201);
      return response;
    },
  );

  app.post('/api/v1/auth/login', async (request) => {
    const response = await app.eAgent.services.auth.login(loginRequestSchema.parse(request.body));
    await emitSessionCreated(
      app,
      request,
      { id: response.user.id, role: response.user.role },
      'login',
    );
    return response;
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const actor = requireActor(request);
    if (request.accessTokenClaims !== null) {
      app.eAgent.authTokens.revokeVerified(request.accessTokenClaims);
    }
    await app.eAgent.extensions?.runHook(
      'session:closed',
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        requestId: hookRequestId(request),
        actor,
        operation: 'session.closed',
        reason: 'logout',
      },
      { actorId: actor.id },
    );
    reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (request) =>
    app.eAgent.services.auth.getUser(requireActor(request).id),
  );

  app.get('/api/v1/users', async (request) =>
    app.eAgent.services.auth.listUsers(requireRole(request, ['owner', 'admin'])),
  );

  app.post('/api/v1/users', async (request, reply) => {
    const user = await app.eAgent.services.auth.createUser(
      createMemberRequestSchema.parse(request.body),
      requireRole(request, ['owner', 'admin']),
    );
    reply.code(201);
    return user;
  });

  app.patch('/api/v1/users/:id', async (request) =>
    app.eAgent.services.auth.updateUser(
      idParam(request.params),
      updateMemberRequestSchema.parse(request.body),
      requireRole(request, ['owner', 'admin']),
    ),
  );

  app.delete('/api/v1/users/:id', async (request, reply) => {
    app.eAgent.services.auth.deleteUser(
      idParam(request.params),
      requireRole(request, ['owner', 'admin']),
    );
    reply.code(204).send();
  });
}
