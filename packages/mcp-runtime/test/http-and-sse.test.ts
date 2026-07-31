import { describe, expect, it, vi } from 'vitest';

import {
  StreamableHttpMcpTransport,
  consumeSseStream,
  parseMcpServerConfig,
  type JsonRpcRequest,
} from '../src/index.js';

function httpConfig(openEventStream = false) {
  const config = parseMcpServerConfig({
    id: 'remote.tools',
    displayName: 'Remote Tools',
    transport: {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer test-token-secret' },
      openEventStream,
    },
  });
  if (config.transport.type !== 'streamable-http') throw new Error('unexpected config');
  return config.transport;
}

describe('StreamableHttpMcpTransport', () => {
  it('处理 JSON、SSE、会话头和关闭生命周期', async () => {
    const requests: Array<{ method: string; headers: Headers; body?: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body)) as JsonRpcRequest;
      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'remote', version: '1.0.0' },
            },
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': 'session-123',
            },
          },
        );
      }
      return new Response(
        `event: message\r\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [] },
        })}\r\n\r\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const transport = new StreamableHttpMcpTransport({
      serverId: 'remote.tools',
      config: httpConfig(),
      fetch: fetchMock,
    });
    await transport.connect();
    await transport.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    transport.setProtocolVersion('2025-11-25');
    await expect(
      transport.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ).resolves.toMatchObject({ id: 2, result: { tools: [] } });

    expect(requests[1]?.headers.get('mcp-session-id')).toBe('session-123');
    expect(requests[1]?.headers.get('mcp-protocol-version')).toBe('2025-11-25');
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer test-token-secret');
    await transport.close();
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('区分超时和调用方取消，且不暴露远端正文', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const transport = new StreamableHttpMcpTransport({
      serverId: 'remote.tools',
      config: httpConfig(),
      fetch: fetchMock,
      requestTimeoutMs: 20,
    });
    await transport.connect();
    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    const controller = new AbortController();
    const pending = transport.request(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    await transport.close();
  });

  it('消费后台 GET 事件流，并接受不支持 GET 的服务', async () => {
    const messages: string[] = [];
    const streamTransport = new StreamableHttpMcpTransport({
      serverId: 'remote.tools',
      config: httpConfig(true),
      fetch: vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.method === 'GET') {
          return new Response(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/tools/list_changed',
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        return new Response(null, { status: 202 });
      }),
    });
    streamTransport.subscribe((message) => {
      if ('method' in message) messages.push(message.method);
    });
    await streamTransport.connect();
    await streamTransport.startServerStream();
    await vi.waitFor(() => expect(messages).toContain('notifications/tools/list_changed'));
    await streamTransport.notify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    await streamTransport.close();

    const noGet = new StreamableHttpMcpTransport({
      serverId: 'remote.tools',
      config: httpConfig(true),
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 405 })),
    });
    await noGet.connect();
    await expect(noGet.startServerStream()).resolves.toBeUndefined();
    await noGet.close();
  });

  it('等待 GET 事件流响应头时按连接上限超时', async () => {
    const transport = new StreamableHttpMcpTransport({
      serverId: 'remote.timeout',
      config: httpConfig(true),
      fetch: vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
      connectTimeoutMs: 20,
    });
    await transport.connect();
    await expect(transport.startServerStream()).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
    await transport.close();
  });

  it('处理会话过期、HTTP 错误、响应类型和大小限制', async () => {
    let mode: 'initialize' | 'expired' | 'status' | 'type' | 'large' = 'initialize';
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (mode === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'session-one',
          },
        });
      }
      if (mode === 'expired') return new Response(null, { status: 404 });
      if (mode === 'status') return new Response('secret body', { status: 503 });
      if (mode === 'type') {
        return new Response('not json', { headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 5, result: 'x'.repeat(200) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const transport = new StreamableHttpMcpTransport({
      serverId: 'remote.tools',
      config: httpConfig(),
      fetch: fetchMock,
      maxMessageBytes: 100,
    });
    await transport.connect();
    await transport.request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    mode = 'expired';
    await expect(
      transport.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED', retryable: true });
    mode = 'status';
    await expect(
      transport.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
    mode = 'type';
    await expect(
      transport.request({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
    mode = 'large';
    await expect(
      transport.request({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await transport.close();
    await expect(
      transport.request({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
  });
});

describe('SSE parser', () => {
  it('支持 CRLF、多 data 行和主动结束', async () => {
    const values: string[] = [];
    const body = new Response('id: one\r\ndata: first\r\ndata: second\r\n\r\ndata: ignored\r\n\r\n')
      .body;
    if (body === null) throw new Error('missing body');
    await expect(
      consumeSseStream(body, {
        maxEventBytes: 1_024,
        onData: (data, id) => {
          values.push(`${id ?? ''}:${data}`);
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(values).toEqual(['one:first\nsecond']);
  });

  it('拒绝超大事件', async () => {
    const body = new Response(`data: ${'x'.repeat(100)}\n\n`).body;
    if (body === null) throw new Error('missing body');
    await expect(
      consumeSseStream(body, {
        maxEventBytes: 32,
        onData: () => false,
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});
