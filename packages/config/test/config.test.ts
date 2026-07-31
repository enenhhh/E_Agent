import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/index.js';

describe('loadConfig', () => {
  it('生成可运行的开发配置', () => {
    const config = loadConfig(
      { NODE_ENV: 'test', E_AGENT_DATABASE_URL: ':memory:' },
      'C:\\workspace',
    );
    expect(config.server.port).toBe(4318);
    expect(config.database.url).toBe(':memory:');
    expect(config.server.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(config.security.bootstrapToken).toBeNull();
  });

  it('只接受空值或至少 32 字符的首启令牌', () => {
    expect(
      loadConfig({
        NODE_ENV: 'test',
        E_AGENT_BOOTSTRAP_TOKEN: 'a-bootstrap-token-that-is-long-enough',
      }).security.bootstrapToken,
    ).toBe('a-bootstrap-token-that-is-long-enough');
    expect(() => loadConfig({ NODE_ENV: 'test', E_AGENT_BOOTSTRAP_TOKEN: 'too-short' })).toThrow(
      /32/,
    );
  });

  it('拒绝缺少主密钥的生产配置', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        E_AGENT_SESSION_SECRET: 'a-secure-session-secret-that-is-long-enough',
      }),
    ).toThrow(/MASTER_KEY/);
  });

  it('拒绝在生产环境关闭认证', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        E_AGENT_SESSION_SECRET: 'a-secure-session-secret-that-is-long-enough',
        E_AGENT_MASTER_KEY: 'a-separate-master-key-that-is-long-enough',
        E_AGENT_AUTH_DISABLED: 'true',
      }),
    ).toThrow(/E_AGENT_AUTH_DISABLED|生产环境禁止关闭认证/);
  });
});
