import { describe, expect, it, vi } from 'vitest';

import {
  createLogger,
  getRequestContext,
  getRequestId,
  measureOperation,
  MetricsRegistry,
  recordHttpRequest,
  sampleRuntimeHealth,
  withRequestContext,
} from '../src/index.js';

const loggerProviderFixture = ['sk', 'provider-logger-secret'].join('-');
const nestedResponseFixture = ['sk', 'nested-response-secret'].join('-');

describe('可观测性', () => {
  it('日志脱敏路径可被 Pino 安全初始化', () => {
    expect(() => {
      const logger = createLogger({ level: 'silent', service: 'test' });
      logger.error({ err: new Error('Bearer test-only-secret-token') }, 'expected test error');
    }).not.toThrow();
  });

  it('请求与响应日志只输出固定诊断字段，绝不序列化 Header、正文或内部缓冲区', () => {
    const output: string[] = [];
    const logger = createLogger(
      { level: 'info', service: 'test' },
      {
        write(line) {
          output.push(line);
        },
      },
    );
    const secrets = {
      bootstrap: 'bootstrap-proof-that-must-never-enter-the-log',
      authorization: 'Bearer authorization-proof-that-must-never-enter-the-log',
      cookie: 'session=cookie-proof-that-must-never-enter-the-log',
      password: 'plain-password-that-must-never-enter-the-log',
      providerKey: ['sk', 'provider-key-that-must-never-enter-the-log'].join('-'),
      accessToken: 'signed-access-token-that-must-never-enter-the-log',
      queryToken: 'query-token-that-must-never-enter-the-log',
    };
    const rawRequest = {
      method: 'POST',
      url: '/api/v1/auth/register',
      rawHeaders: [
        'x-e-agent-bootstrap-token',
        secrets.bootstrap,
        'authorization',
        secrets.authorization,
        'cookie',
        secrets.cookie,
        'x-provider-api-key',
        secrets.providerKey,
      ],
      socket: { remoteAddress: '127.0.0.1', remotePort: 4318, secret: secrets.providerKey },
      _lightMyRequest: {
        payload: JSON.stringify({ password: secrets.password, apiKey: secrets.providerKey }),
      },
    };
    const rawResponse = {
      statusCode: 201,
      req: rawRequest,
      _lightMyRequest: {
        payloadChunks: [Buffer.from(JSON.stringify({ accessToken: secrets.accessToken }))],
      },
    };

    logger.info(
      {
        req: {
          id: 'request-safe-id',
          method: 'POST',
          url: `/api/v1/auth/register?token=${secrets.queryToken}#private`,
          ip: '127.0.0.1',
          raw: rawRequest,
          headers: rawRequest.rawHeaders,
          body: { password: secrets.password },
        },
        res: { statusCode: 201, raw: rawResponse },
      },
      'request completed',
    );

    expect(output).toHaveLength(1);
    const event = JSON.parse(output[0]!) as {
      req: Record<string, unknown>;
      res: Record<string, unknown>;
    };
    expect(event.req).toEqual({
      requestId: 'request-safe-id',
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: '127.0.0.1',
      remotePort: 4318,
    });
    expect(event.res).toEqual({ statusCode: 201 });
    const serialized = JSON.stringify(event);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('rawHeaders');
    expect(serialized).not.toContain('payloadChunks');
  });

  it('结构化日志整体屏蔽上游响应体并保留 ProviderError 诊断字段', () => {
    const output: string[] = [];
    const logger = createLogger(
      { level: 'error', service: 'test' },
      {
        write(line) {
          output.push(line);
        },
      },
    );
    const error = Object.assign(new Error('上游响应无效'), {
      code: 'PROVIDER_BAD_RESPONSE',
      status: 400,
      retryable: false,
      providerBody: {
        error: {
          message: 'D:\\private-project\\agent.ts 包含 tool-generated-secret',
        },
        apiKey: loggerProviderFixture,
      },
    });

    logger.error(
      {
        err: error,
        responseBody: 'raw tool output: tool-generated-secret',
        response: {
          status: 502,
          body: { apiKey: nestedResponseFixture, content: 'private tool content' },
        },
      },
      '上游调用失败',
    );

    expect(output).toHaveLength(1);
    const event = JSON.parse(output[0]!) as {
      err: Record<string, unknown>;
      response: Record<string, unknown>;
      responseBody: unknown;
    };
    expect(event.err).toMatchObject({
      code: 'PROVIDER_BAD_RESPONSE',
      status: 400,
      retryable: false,
      providerBody: '[REDACTED]',
    });
    expect(event.responseBody).toBe('[REDACTED]');
    expect(event.response).toEqual({ status: 502, body: '[REDACTED]' });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('private-project');
    expect(serialized).not.toContain('tool-generated-secret');
    expect(serialized).not.toContain(loggerProviderFixture);
    expect(serialized).not.toContain(nestedResponseFixture);
    expect(serialized).not.toContain('private tool content');
  });

  it('传播请求上下文', async () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    await withRequestContext({ requestId: 'req-1', userId: 'user-1' }, async () => {
      await Promise.resolve();
      expect(getRequestContext()).toEqual({ requestId: 'req-1', userId: 'user-1' });
      expect(getRequestId()).toBe('req-1');
    });
    await withRequestContext({ conversationId: 'conversation-1' }, async () => {
      expect(getRequestContext()).toMatchObject({ conversationId: 'conversation-1' });
    });
  });

  it('输出 Prometheus 指标并测量操作', async () => {
    const registry = new MetricsRegistry();
    registry.increment('jobs_total', { outcome: 'ok' });
    registry.observe('latency_ms', 42);
    const result = await measureOperation('test', async () => 'done', { registry });
    expect(result.value).toBe('done');
    expect(registry.renderPrometheus()).toContain('jobs_total{outcome="ok"} 1');
    expect(registry.renderPrometheus()).toContain('e_agent_operation_duration_ms_count');
  });

  it('渲染计数器、Gauge、自定义直方图和转义标签', () => {
    const registry = new MetricsRegistry();
    registry.increment('jobs_total', { label: 'a"b\\c' }, 2);
    registry.increment('jobs_total', { label: 'a"b\\c' }, 3);
    registry.gauge('workers_active', 4);
    registry.observe('small_latency', 6, { route: '/api' }, [5, 10]);
    recordHttpRequest(
      { method: 'GET', route: '/health', statusCode: 200, durationMs: 3 },
      registry,
    );

    const rendered = registry.renderPrometheus();
    expect(rendered).toContain('jobs_total{label="a\\"b\\\\c"} 5');
    expect(rendered).toContain('workers_active 4');
    expect(rendered).toContain('small_latency_bucket{route="/api",le="5"} 0');
    expect(rendered).toContain('small_latency_bucket{route="/api",le="10"} 1');
    expect(rendered).toContain('small_latency_bucket{route="/api",le="+Inf"} 1');
    expect(rendered).toContain('e_agent_http_requests_total');

    registry.reset();
    expect(registry.renderPrometheus()).toBe('\n');
  });

  it('记录失败操作、脱敏日志上下文并重新抛出原错误', async () => {
    const registry = new MetricsRegistry();
    const logger = { warn: vi.fn() };
    const expected = new Error('expected failure');
    await expect(
      measureOperation(
        'failure',
        async () => {
          throw expected;
        },
        {
          registry,
          logger: logger as never,
          labels: { component: 'test' },
        },
      ),
    ).rejects.toBe(expected);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'failure' }),
      '操作执行失败',
    );
    expect(registry.renderPrometheus()).toContain('e_agent_operation_errors_total');
  });

  it('采样运行时健康指标', async () => {
    const health = await sampleRuntimeHealth();
    expect(health.uptimeSeconds).toBeGreaterThan(0);
    expect(health.residentMemoryBytes).toBeGreaterThan(0);
    expect(health.heapUsedBytes).toBeGreaterThan(0);
    expect(health.eventLoopDelayMs).toBeGreaterThanOrEqual(0);
  });
});
