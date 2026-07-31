import { describe, expect, it } from 'vitest';

import {
  McpRuntimeError,
  parseMcpServerConfig,
  parseMcpServerConfigs,
  redactMcpValue,
  sanitizeMcpErrorMessage,
} from '../src/index.js';

describe('MCP 配置与错误安全', () => {
  it('填充 stdio 安全默认值', () => {
    const config = parseMcpServerConfig({
      id: 'local.files',
      displayName: 'Local Files',
      transport: { type: 'stdio', command: 'node' },
    });

    expect(config).toMatchObject({
      enabled: true,
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      maxMessageBytes: 4 * 1_024 * 1_024,
      maxConcurrentCalls: 4,
      transport: {
        type: 'stdio',
        args: [],
        env: {},
        inheritEnv: [],
        shutdownGraceMs: 1_000,
      },
    });
  });

  it('拒绝远程明文 HTTP、URL 凭据、保留请求头和重复 ID', () => {
    expect(() =>
      parseMcpServerConfig({
        id: 'remote.mcp',
        displayName: 'Remote',
        transport: { type: 'streamable-http', url: 'http://example.com/mcp' },
      }),
    ).toThrow(McpRuntimeError);
    expect(() =>
      parseMcpServerConfig({
        id: 'remote.mcp',
        displayName: 'Remote',
        transport: {
          type: 'streamable-http',
          url: 'https://user:secret@example.com/mcp',
        },
      }),
    ).toThrow('不能内嵌');
    expect(() =>
      parseMcpServerConfig({
        id: 'remote.mcp',
        displayName: 'Remote',
        transport: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { 'Mcp-Session-Id': 'forged' },
        },
      }),
    ).toThrow('运行时管理');
    expect(() =>
      parseMcpServerConfigs([
        {
          id: 'same.id',
          displayName: 'One',
          transport: { type: 'stdio', command: 'node' },
        },
        {
          id: 'same.id',
          displayName: 'Two',
          transport: { type: 'stdio', command: 'node' },
        },
      ]),
    ).toThrow('重复');
  });

  it('允许 localhost HTTP，并支持显式远程开发例外', () => {
    expect(
      parseMcpServerConfig({
        id: 'local.http',
        displayName: 'Local',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:8787/mcp' },
      }).transport.type,
    ).toBe('streamable-http');
    expect(
      parseMcpServerConfig({
        id: 'dev.remote',
        displayName: 'Dev',
        transport: {
          type: 'streamable-http',
          url: 'http://dev.example.com/mcp',
          allowInsecureHttp: true,
        },
      }).transport.type,
    ).toBe('streamable-http');
  });

  it('错误和日志字段不会泄漏 Token、URL 查询凭据或 Authorization', () => {
    const secret = 'sk-exampleSECRET123456';
    const message = sanitizeMcpErrorMessage(
      `request https://user:pass@example.com/mcp?token=${secret} failed Authorization: Bearer ${secret}`,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain('user:pass');

    const fields = redactMcpValue({
      authorization: `Bearer ${secret}`,
      nested: { apiKey: secret, safe: 'ok' },
    });
    expect(fields).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'ok' },
    });
  });
});
