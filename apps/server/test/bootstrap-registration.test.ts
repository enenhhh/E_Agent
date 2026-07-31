import { Writable } from 'node:stream';

import { loadConfig } from '@e-agent/config';
import { createCoreServices, type CoreServices } from '@e-agent/core';
import { openDatabase, type DatabaseContext } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';

const SESSION_SECRET = 'bootstrap-session-secret-more-than-thirty-two-characters';
const MASTER_KEY = 'bootstrap-master-key-more-than-thirty-two-characters';
const BOOTSTRAP_TOKEN = 'bootstrap-owner-proof-more-than-thirty-two-characters';
const AUTHORIZATION_TOKEN = 'authorization-proof-more-than-thirty-two-characters';
const COOKIE_TOKEN = 'cookie-proof-more-than-thirty-two-characters';
const PROVIDER_KEY = ['sk', 'provider-proof-more-than-thirty-two-characters'].join('-');
const OWNER_PASSWORD = 'correct horse battery staple';

interface TestApplication {
  app: FastifyInstance;
  database: DatabaseContext;
  services: CoreServices;
  logs: string[];
}

describe('Production bootstrap registration', () => {
  const applications: TestApplication[] = [];

  afterEach(async () => {
    for (const application of applications.splice(0)) {
      await application.app.close();
      application.database.close();
    }
  });

  async function createApplication(options: {
    bootstrapToken?: string;
    runHook?: ReturnType<typeof vi.fn>;
  }): Promise<TestApplication> {
    const database = openDatabase({ url: ':memory:' });
    const services = createCoreServices({
      database,
      masterKey: MASTER_KEY,
      sessionSecret: SESSION_SECRET,
    });
    const logs: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    });
    const app = await buildServer({
      config: loadConfig({
        NODE_ENV: 'production',
        E_AGENT_DATABASE_URL: ':memory:',
        E_AGENT_SESSION_SECRET: SESSION_SECRET,
        E_AGENT_MASTER_KEY: MASTER_KEY,
        ...(options.bootstrapToken === undefined
          ? {}
          : { E_AGENT_BOOTSTRAP_TOKEN: options.bootstrapToken }),
      }),
      database,
      services,
      logger: createLogger({ level: 'info' }, destination),
      ...(options.runHook === undefined
        ? {}
        : {
            extensions: {
              runHook: options.runHook,
              shutdown: vi.fn(async () => undefined),
            } as never,
          }),
    });
    const application = { app, database, services, logs };
    applications.push(application);
    return application;
  }

  function registrationPayload(index = 0) {
    return {
      email: `owner-${index}@example.com`,
      displayName: `Owner ${index}`,
      password: OWNER_PASSWORD,
    };
  }

  it('生产环境缺失或错误的首启凭据均拒绝注册', async () => {
    const missing = await createApplication({});
    const missingResponse = await missing.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: registrationPayload(),
    });
    expect(missingResponse.statusCode).toBe(403);
    expect(missing.services.repositories.users.count()).toBe(0);

    const configured = await createApplication({ bootstrapToken: BOOTSTRAP_TOKEN });
    const wrongResponse = await configured.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        'x-e-agent-bootstrap-token': 'incorrect-owner-proof-more-than-thirty-two-characters',
      },
      payload: registrationPayload(1),
    });
    expect(wrongResponse.statusCode).toBe(403);
    expect(configured.services.repositories.users.count()).toBe(0);
  });

  it('正确凭据仅创建一次 Owner，且不会进入 Hook、响应或日志', async () => {
    const runHook = vi.fn(async () => []);
    const application = await createApplication({
      bootstrapToken: BOOTSTRAP_TOKEN,
      runHook,
    });
    expect(
      (await application.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json(),
    ).toEqual({
      initialized: false,
      bootstrapTokenRequired: true,
    });
    const first = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        'x-e-agent-bootstrap-token': BOOTSTRAP_TOKEN,
        authorization: `Bearer ${AUTHORIZATION_TOKEN}`,
        cookie: `e-agent-session=${COOKIE_TOKEN}`,
        'x-provider-api-key': PROVIDER_KEY,
      },
      payload: registrationPayload(),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ user: { role: 'owner' } });
    expect(application.services.repositories.users.count()).toBe(1);
    expect(
      (await application.app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json(),
    ).toEqual({
      initialized: true,
      bootstrapTokenRequired: false,
    });

    const second = await application.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'x-e-agent-bootstrap-token': BOOTSTRAP_TOKEN },
      payload: registrationPayload(1),
    });
    expect(second.statusCode).toBe(403);
    expect(application.services.repositories.users.count()).toBe(1);
    expect(runHook).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runHook.mock.calls)).not.toContain(BOOTSTRAP_TOKEN);
    expect(first.body).not.toContain(BOOTSTRAP_TOKEN);
    expect(second.body).not.toContain(BOOTSTRAP_TOKEN);
    const serializedLogs = application.logs.join('');
    expect(serializedLogs).not.toContain(BOOTSTRAP_TOKEN);
    expect(serializedLogs).not.toContain(AUTHORIZATION_TOKEN);
    expect(serializedLogs).not.toContain(COOKIE_TOKEN);
    expect(serializedLogs).not.toContain(PROVIDER_KEY);
    expect(serializedLogs).not.toContain(OWNER_PASSWORD);
    expect(serializedLogs).not.toContain(first.json<{ accessToken: string }>().accessToken);
    expect(serializedLogs).not.toContain('rawHeaders');
    expect(serializedLogs).not.toContain('payloadChunks');
  });

  it('并发首启注册通过数据库条件写入只产生一个 Owner', async () => {
    const runHook = vi.fn(async () => []);
    const application = await createApplication({
      bootstrapToken: BOOTSTRAP_TOKEN,
      runHook,
    });
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        application.app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: { 'x-e-agent-bootstrap-token': BOOTSTRAP_TOKEN },
          payload: registrationPayload(index),
        }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 403)).toHaveLength(3);
    expect(application.services.repositories.users.count()).toBe(1);
    expect(application.services.repositories.users.list()).toEqual([
      expect.objectContaining({ role: 'owner' }),
    ]);
    expect(runHook).toHaveBeenCalledTimes(1);
  });

  it('首启注册使用独立的低频率限制', async () => {
    const application = await createApplication({ bootstrapToken: BOOTSTRAP_TOKEN });
    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(
        await application.app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          headers: {
            'x-e-agent-bootstrap-token': 'incorrect-owner-proof-more-than-thirty-two-characters',
          },
          payload: registrationPayload(index),
        }),
      );
    }

    expect(responses.slice(0, 5).every((response) => response.statusCode === 403)).toBe(true);
    expect(responses[5]?.statusCode).toBe(429);
    expect(application.services.repositories.users.count()).toBe(0);
  });
});
