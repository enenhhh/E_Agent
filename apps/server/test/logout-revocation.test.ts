import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '@e-agent/config';
import { createCoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

const SECRET = 'test-secret-with-more-than-thirty-two-characters';
const temporaryDirectories: string[] = [];

async function createApplication(databasePath: string): Promise<{
  app: FastifyInstance;
  database: DatabaseContext;
}> {
  const config = loadConfig({
    NODE_ENV: 'test',
    E_AGENT_DATABASE_URL: databasePath,
    E_AGENT_SESSION_SECRET: SECRET,
    E_AGENT_MASTER_KEY: SECRET,
  });
  const database = openDatabase({ url: databasePath });
  const services = createCoreServices({
    database,
    masterKey: SECRET,
    sessionSecret: SECRET,
  });
  const app = await buildServer({
    config,
    database,
    services,
    logger: createLogger({ level: 'silent' }),
  });
  return { app, database };
}

async function closeApplication(application: {
  app: FastifyInstance;
  database: DatabaseContext;
}): Promise<void> {
  await application.app.close();
  application.database.close();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('持久化会话撤销', () => {
  it('logout 只撤销当前令牌，且服务重启后仍然生效', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'e-agent-session-revocation-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'e-agent.db');
    const firstApplication = await createApplication(databasePath);

    const registered = await firstApplication.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'owner@example.com',
        displayName: 'Owner',
        password: 'correct horse battery staple',
      },
    });
    const revokedToken = (registered.json() as { accessToken: string }).accessToken;
    const login = await firstApplication.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'owner@example.com',
        password: 'correct horse battery staple',
      },
    });
    const activeToken = (login.json() as { accessToken: string }).accessToken;

    const logout = await firstApplication.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${revokedToken}` },
    });
    expect(logout.statusCode).toBe(204);
    expect(
      (
        await firstApplication.app.inject({
          method: 'GET',
          url: '/api/v1/models',
          headers: { authorization: `Bearer ${revokedToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await firstApplication.app.inject({
          method: 'GET',
          url: '/api/v1/models',
          headers: { authorization: `Bearer ${activeToken}` },
        })
      ).statusCode,
    ).toBe(200);
    await closeApplication(firstApplication);

    const restartedApplication = await createApplication(databasePath);
    try {
      expect(
        (
          await restartedApplication.app.inject({
            method: 'GET',
            url: '/api/v1/models',
            headers: { authorization: `Bearer ${revokedToken}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await restartedApplication.app.inject({
            method: 'GET',
            url: '/api/v1/models',
            headers: { authorization: `Bearer ${activeToken}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await closeApplication(restartedApplication);
    }
  });
});
