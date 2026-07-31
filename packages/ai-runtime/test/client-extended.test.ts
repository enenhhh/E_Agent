import type { ChatTool } from '@e-agent/contracts';
import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleClient, type FetchLike } from '../src/index.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function sseResponse(...events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenAI-compatible client edge cases', () => {
  it('serializes rich requests and maps a non-streaming completion', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: 'served-model',
        choices: [
          {
            message: {
              content: 'answer',
              reasoning_content: 'reasoning',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      });
    });
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1?organization=demo',
      apiKey: 'test-key',
      headers: { 'x-client': 'test' },
      fetch,
    });

    const result = await client.completeChat({
      model: 'requested-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image_url',
              imageUrl: { url: 'https://images.test/example.png', detail: 'high' },
            },
          ],
          name: 'developer',
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'prior-call',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'done', toolCallId: 'prior-call' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
        },
      ],
      temperature: 0.2,
      maxTokens: 128,
    });

    expect(result).toMatchObject({
      model: 'served-model',
      content: 'answer',
      reasoning: 'reasoning',
      finishReason: 'tool_calls',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedTokens: 1 },
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(requestBody).toMatchObject({
      model: 'requested-model',
      temperature: 0.2,
      max_tokens: 128,
      stream: false,
    });
    expect(requestBody?.['messages']).toEqual([
      {
        role: 'user',
        name: 'developer',
        content: [
          { type: 'text', text: 'inspect' },
          {
            type: 'image_url',
            image_url: { url: 'https://images.test/example.png', detail: 'high' },
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'prior-call',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'done', tool_call_id: 'prior-call' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://example.test/v1/chat/completions?organization=demo'),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
          'x-client': 'test',
        }),
      }),
    );
  });

  it('returns healthy and unhealthy health-check results', async () => {
    const healthy = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () => jsonResponse({ data: [] })),
    });
    await expect(healthy.checkHealth()).resolves.toMatchObject({
      healthy: true,
      status: 200,
      error: null,
    });

    const unhealthy = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: { message: 'unavailable', type: 'upstream_error' } },
          { status: 503 },
        ),
      ),
    });
    await expect(unhealthy.checkHealth()).resolves.toMatchObject({
      healthy: false,
      status: 503,
      error: 'unavailable',
    });
  });

  it('accepts model arrays and filters invalid model entries', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        jsonResponse([{ id: 'valid', name: 'Display name' }, null, {}, { id: '' }, { id: 42 }]),
      ),
    });

    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'valid', displayName: 'Display name' }),
    ]);
  });

  it.each([
    ['primitive model response', 'invalid'],
    ['invalid models property', { models: {} }],
    ['invalid JSON response', undefined],
  ])('rejects %s', async (_name, value) => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(async () =>
        value === undefined ? new Response('{broken', { status: 200 }) : jsonResponse(value),
      ),
    });

    await expect(client.listModels()).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      retryable: false,
    });
  });

  it('rejects declared oversized JSON before reading the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-length': String(17 * 1024 * 1024) },
          }),
      ),
    });

    await expect(client.listModels()).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('maps HTTP payload codes and Retry-After headers', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(async () =>
        jsonResponse(
          { error: { message: 'rate limited', code: 'rate_limit' } },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      ),
    });

    await expect(client.listModels()).rejects.toMatchObject({
      status: 429,
      code: 'rate_limit',
      retryAfterMs: 2_000,
      retryable: true,
    });
  });

  it('uses HTTP status fallback when an error body is invalid', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(async () => new Response('not-json', { status: 400 })),
    });

    await expect(client.listModels()).rejects.toMatchObject({
      status: 400,
      code: 'HTTP_400',
      retryable: false,
    });
  });

  it('emits reasoning aliases, fallback usage and normalized tool-call indexes', async () => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse(
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning: 'thought',
                  tool_calls: [
                    {
                      index: -1,
                      function: { name: 'tool', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'stop',
              },
            ],
          }),
          '[DONE]',
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamChat({
      model: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'reasoning_delta', content: 'thought' },
      { type: 'tool_call_delta', index: 0, name: 'tool', arguments: '{}' },
      {
        type: 'usage',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          estimatedCostUsd: 0,
        },
      },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('reconciles a partial tool delta with a complete tool call in the final choice message', async () => {
    const completeArguments = JSON.stringify({
      path: 'smoke.txt',
      content: 'stream reconciliation passed',
    });
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-qwen-compatible',
                      function: {
                        name: 'workspace_propose_write',
                        arguments: '{',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {},
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call-qwen-compatible',
                      type: 'function',
                      function: {
                        name: 'workspace_propose_write',
                        arguments: completeArguments,
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          '[DONE]',
        ),
      ),
    });

    const result = await client.collectStream({
      model: 'qwen-compatible',
      messages: [{ role: 'user', content: 'create a file' }],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      {
        id: 'call-qwen-compatible',
        type: 'function',
        function: {
          name: 'workspace_propose_write',
          arguments: completeArguments,
        },
      },
    ]);
  });

  it('strictly recovers the compatible provider error after one matching partial tool call', async () => {
    const tool: ChatTool = {
      type: 'function',
      function: {
        name: 'workspace_propose_write',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', maxLength: 1_024 },
            content: { type: 'string', maxLength: 750_000 },
          },
        },
      },
    };
    const recoveryMessage = [
      'Failed to parse input at pos 939: <tool_call>',
      '<function=workspace_propose_write>',
      '<parameter=path>',
      'generated.txt',
      '</parameter>',
      '<parameter=content>',
      'recovered safely',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse(
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'I should use the declared file proposal tool.',
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-partial',
                      function: {
                        name: 'workspace_propose_write',
                        arguments: '{',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            error: {
              code: 500,
              message: recoveryMessage,
              type: 'server_error',
            },
          }),
          '[DONE]',
        ),
      ),
    });

    const result = await client.collectStream({
      model: 'qwen-compatible',
      messages: [{ role: 'user', content: 'create a file' }],
      tools: [tool],
    });

    expect(result.finishReason).toBe('tool_calls');
    expect(result.reasoning).toBe('I should use the declared file proposal tool.');
    expect(result.toolCalls).toEqual([
      {
        id: 'call-partial',
        type: 'function',
        function: {
          name: 'workspace_propose_write',
          arguments: JSON.stringify({
            path: 'generated.txt',
            content: 'recovered safely',
          }),
        },
      },
    ]);
  });

  it.each([
    {
      name: 'no declared tools',
      tools: undefined,
      partialName: 'workspace_propose_write',
    },
    {
      name: 'a conflicting native tool',
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'workspace_propose_write',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'content'],
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
        },
      ],
      partialName: 'workspace_run_command',
    },
  ])('fails closed for recovery with $name', async ({ tools, partialName }) => {
    const message = [
      'Failed to parse input at pos 12: <tool_call>',
      '<function=workspace_propose_write>',
      '<parameter=path>',
      'generated.txt',
      '</parameter>',
      '<parameter=content>',
      'safe',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      fetch: vi.fn(async () =>
        sseResponse(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-conflict',
                      function: { name: partialName, arguments: '{' },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            error: { code: 500, message, type: 'server_error' },
          }),
        ),
      ),
    });

    await expect(
      client.collectStream({
        model: 'qwen-compatible',
        messages: [{ role: 'user', content: 'create a file' }],
        ...(tools === undefined ? {} : { tools }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_TOOL_CALL' });
  });

  it.each([
    ['missing stream body', () => new Response(null)],
    ['invalid stream JSON', () => sseResponse('{broken')],
    ['non-object stream payload', () => sseResponse('[]')],
  ])('rejects %s', async (_name, response) => {
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://example.test/v1',
      maxAttempts: 1,
      fetch: vi.fn(async () => response()),
    });

    await expect(
      client.collectStream({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toBeTruthy();
  });

  it.each([
    { baseUrl: '' },
    { baseUrl: 'not a url' },
    { baseUrl: 'https://example.test/v1#fragment' },
    { baseUrl: 'https://example.test', timeoutMs: 0 },
    { baseUrl: 'https://example.test', maxAttempts: 20 },
    { baseUrl: 'https://example.test', apiKey: 'x'.repeat(16 * 1024 + 1) },
    { baseUrl: 'https://example.test', proxyUrl: 'https://proxy.test/path' },
  ])('rejects invalid client configuration %#', (options) => {
    expect(() => new OpenAICompatibleClient(options)).toThrow();
  });
});
