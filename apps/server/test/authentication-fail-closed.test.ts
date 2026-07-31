import type { EAgentConfig } from '@e-agent/config';
import { loadConfig } from '@e-agent/config';
import type { UsersRepository } from '@e-agent/database';
import type { RevocableTokenService } from '@e-agent/security';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerAuthentication } from '../src/auth.js';
import { buildServer } from '../src/server.js';

const SECRET = 'test-secret-with-more-than-thirty-two-characters';

function unsafeProductionConfig(): EAgentConfig {
  const safeTestConfig = loadConfig({
    NODE_ENV: 'test',
    E_AGENT_DATABASE_URL: ':memory:',
    E_AGENT_SESSION_SECRET: SECRET,
    E_AGENT_MASTER_KEY: SECRET,
  });
  return {
    ...safeTestConfig,
    environment: 'production',
    server: {
      ...safeTestConfig.server,
      authDisabled: true,
    },
  };
}

describe('生产认证 fail-closed', () => {
  it('服务构建在分配运行资源前拒绝不安全的注入配置', async () => {
    await expect(buildServer({ config: unsafeProductionConfig() })).rejects.toThrow(
      /生产环境禁止 E_AGENT_AUTH_DISABLED=true/,
    );
  });

  it('认证层独立拒绝生产环境关闭认证', async () => {
    const app = Fastify();
    expect(() =>
      registerAuthentication(app, {
        environment: 'production',
        authDisabled: true,
        users: {} as UsersRepository,
        tokens: {} as RevocableTokenService,
      }),
    ).toThrow(/生产环境禁止 E_AGENT_AUTH_DISABLED=true/);
    await app.close();
  });
});
