import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleClient, ProviderError, parseSseStream, withRetry } from '../src/index.js';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenAI-compatible 客户端', () => {
  it('发现并推断模型能力', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-only-key',
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'deepseek-coder', context_window: 64000 }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    });
    const models = await client.listModels();
    expect(models[0]?.capabilities).toContain('code');
    expect(models[0]?.contextWindow).toBe(64_000);
  });

  it('解析流式文本、工具调用和用量', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"p\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    });
    const result = await client.collectStream({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.content).toBe('你好');
    expect(result.toolCalls[0]?.function.arguments).toBe('{"p":"a"}');
    expect(result.usage.totalTokens).toBe(5);
  });

  it('处理跨分块 SSE 与重试', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\ndata: tw'));
        controller.enqueue(encoder.encode('o\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events[0]?.data).toBe('one\ntwo');

    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('temporary');
        return 'ok';
      },
      { baseDelayMs: 1, jitterRatio: 0 },
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('正确处理跨分块 CRLF，且提前停止消费时取消上游流', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\r'));
        controller.enqueue(encoder.encode('\n\r\ndata: second\r\n\r\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of parseSseStream(stream)) {
      expect(event.data).toBe('first');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('拒绝超大 SSE 事件并限制恶意 Retry-After', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: 123456789'));
        controller.close();
      },
    });
    await expect(async () => {
      for await (const _event of parseSseStream(stream, undefined, {
        maxBufferCharacters: 8,
      })) {
        // 不应产生事件。
      }
    }).rejects.toThrow(/大小上限/);

    const startedAt = performance.now();
    await expect(
      withRetry(
        async () => {
          throw new ProviderError('busy', {
            retryAfterMs: 60_000,
            retryable: true,
          });
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      ),
    ).rejects.toThrow('busy');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('清洗异常用量并把 SSE 错误信封转为 ProviderError', async () => {
    const usageClient = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":10.9,"completion_tokens":-2,"total_tokens":1,"prompt_tokens_details":{"cached_tokens":999}}}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    });
    const usage = await usageClient.collectStream({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(usage.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
      cachedTokens: 10,
    });

    const errorClient = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse([
          'data: {"error":{"message":"Bearer abcdefghijklmnop rejected","code":"bad_auth"}}\n\n',
        ]),
      ),
    });
    await expect(
      errorClient.collectStream({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({
      code: 'bad_auth',
      message: 'Bearer [REDACTED] rejected',
    });
  });

  it('仅允许安全的 HTTP(S) 地址，并禁止跟随重定向', async () => {
    expect(() => new OpenAICompatibleClient({ baseUrl: 'file:///etc/passwd' })).toThrow(/HTTP/);
    expect(() => new OpenAICompatibleClient({ baseUrl: 'http://api.example.test/v1' })).toThrow(
      /HTTPS/,
    );
    expect(
      () =>
        new OpenAICompatibleClient({
          baseUrl: 'http://192.168.1.20:11434/v1',
          allowInsecureLoopback: true,
        }),
    ).toThrow(/回环/);
    const localClient = new OpenAICompatibleClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowInsecureLoopback: true,
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    });
    await expect(localClient.listModels()).resolves.toEqual([]);
    await localClient.close();
    expect(
      () =>
        new OpenAICompatibleClient({
          baseUrl: 'https://user:pass@example.test/v1',
        }),
    ).toThrow(/明文凭据/);
    expect(
      () =>
        new OpenAICompatibleClient({
          baseUrl: 'https://example.test/v1?api_key=secret',
        }),
    ).toThrow(/查询参数/);

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: fetchMock,
    });
    await client.listModels();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://example.test/v1/models'),
      expect.objectContaining({ redirect: 'error' }),
    );
    await client.close();
    await expect(client.listModels()).rejects.toMatchObject({
      code: 'PROVIDER_CLIENT_CLOSED',
    });
  });

  it('响应头到达后仍对 JSON 响应体执行超时约束', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      timeoutMs: 20,
      maxAttempts: 1,
      fetch: vi.fn(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        });
        return new Response(body, { status: 200 });
      }),
    });
    await expect(client.listModels()).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
  });
});
