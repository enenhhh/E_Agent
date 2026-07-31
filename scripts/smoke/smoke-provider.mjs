#!/usr/bin/env node

import { OpenAICompatibleClient } from '../../packages/ai-runtime/dist/index.js';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

function elapsedMilliseconds(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function safeErrorMessage(error, apiKey) {
  const message = error instanceof Error ? error.message : '未知 Provider 错误';
  const sanitized = apiKey === '' ? message : message.replaceAll(apiKey, '[REDACTED_API_KEY]');
  return sanitized.replace(/sk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED_API_KEY]').slice(0, 1_024);
}

let apiKey = '';
let client;
let phase = 'configuration';
const completed = {};

try {
  const baseUrl = requiredEnvironment('E_AGENT_PROVIDER_SMOKE_BASE_URL');
  apiKey = requiredEnvironment('E_AGENT_PROVIDER_SMOKE_API_KEY');
  const model = requiredEnvironment('E_AGENT_PROVIDER_SMOKE_MODEL');
  const requestedPhase = process.env.E_AGENT_PROVIDER_SMOKE_PHASE?.trim() || 'all';
  if (!['all', 'models', 'stream', 'tool_call'].includes(requestedPhase)) {
    throw new Error('E_AGENT_PROVIDER_SMOKE_PHASE 仅支持 all/models/stream/tool_call');
  }
  const toolMaxTokens = Number(process.env.E_AGENT_PROVIDER_SMOKE_TOOL_MAX_TOKENS ?? '256');
  if (!Number.isInteger(toolMaxTokens) || toolMaxTokens < 32 || toolMaxTokens > 1_024) {
    throw new Error('E_AGENT_PROVIDER_SMOKE_TOOL_MAX_TOKENS 必须是 32–1024 的整数');
  }
  delete process.env.E_AGENT_PROVIDER_SMOKE_API_KEY;
  client = new OpenAICompatibleClient({
    baseUrl,
    apiKey,
    timeoutMs: 45_000,
    maxAttempts: 1,
  });

  if (requestedPhase === 'all' || requestedPhase === 'models') {
    phase = 'models';
    const modelsStartedAt = performance.now();
    const models = await client.listModels();
    if (!models.some((candidate) => candidate.id === model)) {
      throw new Error('模型列表中没有找到指定的冒烟测试模型');
    }
    completed.models = {
      count: models.length,
      selectedModelFound: true,
      durationMs: elapsedMilliseconds(modelsStartedAt),
    };
  }

  if (requestedPhase === 'all' || requestedPhase === 'stream') {
    phase = 'stream';
    const streamStartedAt = performance.now();
    let streamCharacters = 0;
    let reasoningCharacters = 0;
    let streamEvents = 0;
    let streamFinished = false;
    let streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for await (const event of client.streamChat({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      temperature: 0,
      maxTokens: 8,
    })) {
      streamEvents += 1;
      if (event.type === 'delta') streamCharacters += event.content.length;
      if (event.type === 'reasoning_delta') reasoningCharacters += event.content.length;
      if (event.type === 'usage') streamUsage = event.usage;
      if (event.type === 'done') streamFinished = true;
    }
    if (!streamFinished || streamCharacters + reasoningCharacters === 0) {
      throw new Error('流式响应没有产生有效增量或完成事件');
    }
    completed.stream = {
      events: streamEvents,
      contentCharacters: streamCharacters,
      reasoningCharacters,
      usage: streamUsage,
      durationMs: elapsedMilliseconds(streamStartedAt),
    };
  }

  if (requestedPhase === 'all' || requestedPhase === 'tool_call') {
    phase = 'tool_call';
    const toolStartedAt = performance.now();
    const toolResult = await client.completeChat({
      model,
      messages: [
        {
          role: 'user',
          content:
            'Call echo_for_smoke_test exactly once with the JSON argument {"text":"OK"}. Do not answer with prose.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo_for_smoke_test',
            description: 'Return the supplied text for a compatibility smoke test.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        },
      ],
      temperature: 0,
      maxTokens: toolMaxTokens,
    });
    const expectedToolCall = toolResult.toolCalls.find(
      (toolCall) => toolCall.function.name === 'echo_for_smoke_test',
    );
    if (expectedToolCall === undefined) {
      completed.toolCall = {
        nameMatched: false,
        returnedToolCalls: toolResult.toolCalls.length,
        finishReason: toolResult.finishReason,
        contentCharacters: toolResult.content.length,
        reasoningCharacters: toolResult.reasoning.length,
        usage: toolResult.usage,
        durationMs: elapsedMilliseconds(toolStartedAt),
      };
      throw new Error('Provider 没有返回预期的工具调用');
    }
    let toolArguments;
    try {
      toolArguments = JSON.parse(expectedToolCall.function.arguments);
    } catch {
      throw new Error('Provider 返回的工具调用参数不是有效 JSON');
    }
    if (toolArguments?.text !== 'OK') {
      throw new Error('Provider 返回的工具调用参数与请求不一致');
    }
    completed.toolCall = {
      nameMatched: true,
      argumentsMatched: true,
      finishReason: toolResult.finishReason,
      usage: toolResult.usage,
      durationMs: elapsedMilliseconds(toolStartedAt),
    };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        ...completed,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      phase,
      completed,
      error: safeErrorMessage(error, apiKey),
    }),
  );
  process.exitCode = 1;
} finally {
  await client?.close();
}
