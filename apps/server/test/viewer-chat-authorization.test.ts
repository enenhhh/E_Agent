import { loadConfig } from '@e-agent/config';
import { createCoreServices } from '@e-agent/core';
import { openDatabase } from '@e-agent/database';
import { createLogger } from '@e-agent/observability';
import { TokenService } from '@e-agent/security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chatInputMocks = vi.hoisted(() => ({
  prepareChatInput: vi.fn(),
}));

vi.mock('../src/chat-input.js', () => ({
  prepareChatInput: chatInputMocks.prepareChatInput,
}));

import { buildServer } from '../src/server.js';

const SECRET = 'viewer-chat-test-secret-more-than-thirty-two-characters';

describe('Viewer chat authorization', () => {
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    chatInputMocks.prepareChatInput.mockReset();
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('在插件 Hook 与 Web 上下文解析前拒绝 Viewer', async () => {
    const database = openDatabase({ url: ':memory:' });
    const services = createCoreServices({
      database,
      masterKey: SECRET,
      sessionSecret: SECRET,
    });
    const viewer = services.repositories.users.create({
      email: 'viewer@example.com',
      displayName: 'Viewer',
      passwordHash: 'not-used-in-this-test',
      role: 'viewer',
    });
    const token = new TokenService(SECRET).issue({
      sub: viewer.id,
      email: viewer.email,
      role: viewer.role,
    }).token;
    const runHook = vi.fn(async () => []);
    const shutdown = vi.fn(async () => undefined);
    const app = await buildServer({
      config: loadConfig({
        NODE_ENV: 'test',
        E_AGENT_DATABASE_URL: ':memory:',
        E_AGENT_SESSION_SECRET: SECRET,
        E_AGENT_MASTER_KEY: SECRET,
      }),
      database,
      services,
      logger: createLogger({ level: 'silent' }),
      extensions: {
        runHook,
        shutdown,
      } as never,
    });
    close = async () => {
      await app.close();
      database.close();
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        messages: [{ role: 'user', content: '读取这个网页' }],
        contextMentions: ['@web:https://example.com/private'],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(runHook).not.toHaveBeenCalled();
    expect(chatInputMocks.prepareChatInput).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
