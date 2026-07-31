import { randomUUID } from 'node:crypto';

import type {
  ChatContentPart,
  ChatMessageInput,
  ChatTool,
  ChatUsage,
  ToolCall,
} from '@e-agent/contracts';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

import { inferContextWindow, inferModelCapabilities } from './capabilities.js';
import { ProviderError, normalizeProviderError } from './errors.js';
import { withRetry } from './retry.js';
import { parseSseStream, SseProtocolError } from './sse.js';
import { isProviderToolRecoveryMessage, recoverProviderToolCall } from './tool-call-recovery.js';
import type {
  ProviderHealth,
  ProviderStreamEvent,
  RuntimeChatRequest,
  RuntimeChatResponse,
  RuntimeModel,
} from './types.js';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface OpenAICompatibleClientOptions {
  baseUrl: string;
  apiKey?: string;
  allowInsecureLoopback?: boolean;
  proxyUrl?: string | null;
  timeoutMs?: number;
  maxAttempts?: number;
  headers?: Readonly<Record<string, string>>;
  fetch?: FetchLike;
}

interface OpenAIErrorPayload {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
  message?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIModelPayload {
  id: string;
  name?: string;
  owned_by?: string;
  context_window?: number;
  context_length?: number;
  [key: string]: unknown;
}

interface OpenAIChatPayload extends OpenAIErrorPayload {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    };
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 4_096;
const SENSITIVE_QUERY_NAME = /(?:api[-_]?key|token|secret|password|authorization)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function providerError(
  payload: OpenAIErrorPayload,
): NonNullable<OpenAIErrorPayload['error']> | undefined {
  return isRecord(payload.error)
    ? (payload.error as NonNullable<OpenAIErrorPayload['error']>)
    : undefined;
}

function providerErrorMessage(payload: OpenAIErrorPayload, fallback: string): string {
  const error = providerError(payload);
  if (typeof error?.message === 'string') return error.message;
  return typeof payload.message === 'string' ? payload.message : fallback;
}

function providerErrorCode(payload: OpenAIErrorPayload, fallback: string): string {
  const error = providerError(payload);
  if (typeof error?.code === 'string') return error.code;
  return typeof error?.type === 'string' ? error.type : fallback;
}

function recoveryErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload) || Object.keys(payload).length !== 1 || !isRecord(payload['error'])) {
    return undefined;
  }
  const error = payload['error'];
  if (
    Object.keys(error).some((key) => !['code', 'message', 'type'].includes(key)) ||
    error['type'] !== 'server_error' ||
    (error['code'] !== 500 && error['code'] !== '500') ||
    typeof error['message'] !== 'string'
  ) {
    return undefined;
  }
  return error['message'];
}

function isIncompleteJson(value: string): boolean {
  if (value === '') return true;
  try {
    JSON.parse(value);
    return false;
  } catch {
    return true;
  }
}

function compatiblePartialToolCall(
  calls: ReadonlyMap<number, { id: string; name: string; arguments: string }>,
  recovered: { name: string; arguments: string },
  snapshotSeen: boolean,
): { id: string } | undefined {
  if (snapshotSeen || calls.size > 1) return undefined;
  if (calls.size === 0) return { id: `recovered-${randomUUID()}` };
  const partial = calls.get(0);
  if (
    partial === undefined ||
    (partial.name !== '' && partial.name !== recovered.name) ||
    (partial.arguments !== '' &&
      (!isIncompleteJson(partial.arguments) || !recovered.arguments.startsWith(partial.arguments)))
  ) {
    return undefined;
  }
  return { id: partial.id || `recovered-${randomUUID()}` };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function normalizeHttpUrl(
  value: string,
  kind: 'base' | 'proxy',
  allowInsecureLoopback = false,
): URL {
  if (value === '' || value.length > MAX_URL_LENGTH) {
    throw new ProviderError(`${kind === 'base' ? '提供商地址' : '代理地址'}无效`, {
      code: 'INVALID_PROVIDER_CONFIGURATION',
      retryable: false,
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderError(`${kind === 'base' ? '提供商地址' : '代理地址'}无效`, {
      code: 'INVALID_PROVIDER_CONFIGURATION',
      retryable: false,
      cause: error,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash !== '') {
    throw new ProviderError(`${kind === 'base' ? '提供商地址' : '代理地址'}仅支持 HTTP(S)`, {
      code: 'INVALID_PROVIDER_CONFIGURATION',
      retryable: false,
    });
  }
  if (kind === 'base') {
    if (
      url.protocol !== 'https:' &&
      (!allowInsecureLoopback || !isLoopbackHostname(url.hostname))
    ) {
      throw new ProviderError('云端提供商必须使用 HTTPS；HTTP 仅允许本机回环地址', {
        code: 'INVALID_PROVIDER_CONFIGURATION',
        retryable: false,
      });
    }
    if (url.username !== '' || url.password !== '') {
      throw new ProviderError('提供商地址不能包含明文凭据', {
        code: 'INVALID_PROVIDER_CONFIGURATION',
        retryable: false,
      });
    }
    for (const name of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_NAME.test(name)) {
        throw new ProviderError('提供商地址不能在查询参数中包含凭据', {
          code: 'INVALID_PROVIDER_CONFIGURATION',
          retryable: false,
        });
      }
    }
  } else if (url.pathname !== '/' || url.search !== '') {
    throw new ProviderError('代理地址不能包含路径或查询参数', {
      code: 'INVALID_PROVIDER_CONFIGURATION',
      retryable: false,
    });
  }
  return url;
}

function endpointUrl(baseUrl: URL, path: string): URL {
  const base = new URL(baseUrl);
  const search = base.search;
  base.search = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const endpoint = new URL(path.replace(/^\/+/, ''), base);
  endpoint.search = search;
  return endpoint;
}

async function readJsonResponse<T>(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError('上游 JSON 响应超过大小上限', {
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
      retryable: false,
    });
  }
  if (response.body === null) {
    throw new ProviderError('上游响应缺少响应体', {
      code: 'INVALID_PROVIDER_RESPONSE',
      retryable: false,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let completed = false;
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ProviderError('上游 JSON 响应超过大小上限', {
          code: 'PROVIDER_RESPONSE_TOO_LARGE',
          retryable: false,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProviderError('上游返回无效 JSON', {
      code: 'INVALID_PROVIDER_RESPONSE',
      retryable: false,
      cause: error,
    });
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function toUsage(usage: OpenAIUsage | undefined): ChatUsage {
  const inputTokens = tokenCount(usage?.prompt_tokens);
  const outputTokens = tokenCount(usage?.completion_tokens);
  const calculatedTotal = inputTokens + outputTokens;
  const reportedTotal = tokenCount(usage?.total_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(calculatedTotal, reportedTotal),
    cachedTokens: Math.min(inputTokens, tokenCount(usage?.prompt_tokens_details?.cached_tokens)),
    estimatedCostUsd: 0,
  };
}

function serializeContentPart(part: ChatContentPart): unknown {
  if (part.type === 'text') return part;
  return {
    type: 'image_url',
    image_url: {
      url: part.imageUrl.url,
      ...(part.imageUrl.detail === undefined ? {} : { detail: part.imageUrl.detail }),
    },
  };
}

function serializeMessage(message: ChatMessageInput): Record<string, unknown> {
  return {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(serializeContentPart),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls }),
  };
}

function serializeTool(tool: ChatTool): unknown {
  return tool;
}

function composeSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new DOMException('请求超时', 'AbortError')),
    timeoutMs,
  );
  timer.unref?.();
  if (caller === undefined) {
    return { signal: timeoutController.signal, cleanup: () => clearTimeout(timer) };
  }
  return {
    signal: AbortSignal.any([caller, timeoutController.signal]),
    cleanup: () => clearTimeout(timer),
  };
}

function mergeToolCalls(
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  delta: Extract<ProviderStreamEvent, { type: 'tool_call_delta' }>,
): void {
  const current = toolCalls.get(delta.index) ?? { id: '', name: '', arguments: '' };
  if (delta.snapshot === true) {
    if (delta.id !== undefined) current.id = delta.id;
    if (delta.name !== undefined) current.name = delta.name;
    if (delta.arguments !== undefined) current.arguments = delta.arguments;
    toolCalls.set(delta.index, current);
    return;
  }
  if (delta.id !== undefined) current.id = delta.id;
  if (delta.name !== undefined) current.name += delta.name;
  if (delta.arguments !== undefined) current.arguments += delta.arguments;
  toolCalls.set(delta.index, current);
}

/** OpenAI-compatible REST/SSE 客户端，可注入 fetch 以便离线测试。 */
export class OpenAICompatibleClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string | undefined;
  readonly #proxyAgent: ProxyAgent | undefined;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: FetchLike;
  #closed = false;

  public constructor(options: OpenAICompatibleClientOptions) {
    this.#baseUrl = normalizeHttpUrl(
      options.baseUrl,
      'base',
      options.allowInsecureLoopback ?? false,
    );
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 10 * 60 * 1_000 ||
      !Number.isInteger(this.#maxAttempts) ||
      this.#maxAttempts < 1 ||
      this.#maxAttempts > 10
    ) {
      throw new ProviderError('上游请求超时或重试配置无效', {
        code: 'INVALID_PROVIDER_CONFIGURATION',
        retryable: false,
      });
    }
    if (options.apiKey !== undefined && options.apiKey.length > 16 * 1024) {
      throw new ProviderError('API Key 超过大小上限', {
        code: 'INVALID_PROVIDER_CONFIGURATION',
        retryable: false,
      });
    }
    if (options.proxyUrl !== undefined && options.proxyUrl !== null) {
      const proxyUrl = normalizeHttpUrl(options.proxyUrl, 'proxy');
      try {
        this.#proxyAgent = new ProxyAgent(proxyUrl.toString());
      } catch (error) {
        throw new ProviderError('代理配置无效', {
          code: 'INVALID_PROVIDER_CONFIGURATION',
          retryable: false,
          cause: error,
        });
      }
    }
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? (undiciFetch as unknown as FetchLike);
  }

  /** 释放代理连接池；使用代理时必须在客户端生命周期结束后调用。 */
  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#proxyAgent?.close();
  }

  async #request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (this.#closed) {
      throw new ProviderError('客户端已关闭', {
        code: 'PROVIDER_CLIENT_CLOSED',
        retryable: false,
      });
    }
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await this.#fetch(endpointUrl(this.#baseUrl, path), {
            ...init,
            redirect: 'error',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
              ...this.#headers,
              ...init.headers,
            },
            signal,
            ...(this.#proxyAgent === undefined ? {} : { dispatcher: this.#proxyAgent }),
          });
        } catch (error) {
          throw normalizeProviderError(error);
        }
        if (!response.ok) {
          let payload: OpenAIErrorPayload | undefined;
          try {
            payload = await readJsonResponse<OpenAIErrorPayload>(
              response,
              MAX_ERROR_RESPONSE_BYTES,
            );
          } catch {
            payload = undefined;
          }
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          throw new ProviderError(
            payload === undefined
              ? `上游返回 HTTP ${response.status}`
              : providerErrorMessage(payload, `上游返回 HTTP ${response.status}`),
            {
              status: response.status,
              code:
                payload === undefined
                  ? `HTTP_${response.status}`
                  : providerErrorCode(payload, `HTTP_${response.status}`),
              ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              ...(payload === undefined ? {} : { providerBody: payload }),
            },
          );
        }
        return response;
      },
      { maxAttempts: this.#maxAttempts, ...(signal === undefined ? {} : { signal }) },
    );
  }

  public async listModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const lifetime = composeSignal(signal, this.#timeoutMs);
    try {
      const response = await this.#request('/models', { method: 'GET' }, lifetime.signal);
      const payload = await readJsonResponse<
        { data?: OpenAIModelPayload[]; models?: OpenAIModelPayload[] } | OpenAIModelPayload[]
      >(response);
      if (!Array.isArray(payload) && !isRecord(payload)) {
        throw new ProviderError('上游模型列表格式无效', {
          code: 'INVALID_PROVIDER_RESPONSE',
          retryable: false,
        });
      }
      const models = Array.isArray(payload) ? payload : (payload.data ?? payload.models ?? []);
      if (!Array.isArray(models)) {
        throw new ProviderError('上游模型列表格式无效', {
          code: 'INVALID_PROVIDER_RESPONSE',
          retryable: false,
        });
      }
      return models
        .filter(
          (model): model is OpenAIModelPayload =>
            model !== null &&
            typeof model === 'object' &&
            typeof model.id === 'string' &&
            model.id !== '',
        )
        .map((model) => ({
          id: model.id,
          displayName: typeof model.name === 'string' ? model.name : model.id,
          capabilities: inferModelCapabilities(model.id, model),
          contextWindow: inferContextWindow(model.id, model),
          metadata: { ...model },
        }));
    } catch (error) {
      throw normalizeProviderError(error);
    } finally {
      lifetime.cleanup();
    }
  }

  public async checkHealth(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(signal);
      return {
        healthy: true,
        latencyMs: Math.round(performance.now() - startedAt),
        status: 200,
        error: null,
      };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return {
        healthy: false,
        latencyMs: Math.round(performance.now() - startedAt),
        status: normalized.status ?? null,
        error: normalized.message,
      };
    }
  }

  public async completeChat(request: RuntimeChatRequest): Promise<RuntimeChatResponse> {
    const lifetime = composeSignal(request.signal, this.#timeoutMs);
    try {
      const response = await this.#request(
        '/chat/completions',
        {
          method: 'POST',
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(serializeMessage),
            ...(request.tools === undefined ? {} : { tools: request.tools.map(serializeTool) }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
            stream: false,
          }),
        },
        lifetime.signal,
      );
      const rawPayload = await readJsonResponse<unknown>(response);
      if (!isRecord(rawPayload)) {
        throw new ProviderError('上游聊天响应格式无效', {
          code: 'INVALID_PROVIDER_RESPONSE',
          retryable: false,
        });
      }
      const payload = rawPayload as OpenAIChatPayload;
      const upstreamError = providerError(payload);
      if (upstreamError !== undefined) {
        throw new ProviderError(providerErrorMessage(payload, '上游返回错误'), {
          code: providerErrorCode(payload, 'PROVIDER_ERROR'),
          retryable: false,
          providerBody: payload,
        });
      }
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      return {
        model: typeof payload.model === 'string' ? payload.model : request.model,
        content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
        reasoning:
          typeof choice?.message?.reasoning_content === 'string'
            ? choice.message.reasoning_content
            : '',
        toolCalls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [],
        finishReason: choice?.finish_reason ?? null,
        usage: toUsage(payload.usage),
      };
    } catch (error) {
      throw normalizeProviderError(error);
    } finally {
      lifetime.cleanup();
    }
  }

  public async *streamChat(request: RuntimeChatRequest): AsyncGenerator<ProviderStreamEvent> {
    const lifetime = composeSignal(request.signal, this.#timeoutMs);
    try {
      const response = await this.#request(
        '/chat/completions',
        {
          method: 'POST',
          headers: { accept: 'text/event-stream' },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(serializeMessage),
            ...(request.tools === undefined ? {} : { tools: request.tools.map(serializeTool) }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
            stream: true,
            stream_options: { include_usage: true },
          }),
        },
        lifetime.signal,
      );
      if (response.body === null) {
        throw new ProviderError('上游流式响应缺少响应体', { retryable: false });
      }
      let finishReason: string | null = null;
      let emittedUsage = false;
      let emittedContent = false;
      let nativeSnapshotSeen = false;
      const nativeToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const event of parseSseStream(response.body, lifetime.signal)) {
        if (event.data.trim() === '[DONE]') break;
        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(event.data) as unknown;
        } catch (error) {
          throw new ProviderError('上游 SSE 包含无效 JSON', {
            code: 'INVALID_PROVIDER_STREAM',
            retryable: false,
            cause: error,
          });
        }
        if (!isRecord(rawPayload)) {
          throw new ProviderError('上游 SSE 数据格式无效', {
            code: 'INVALID_PROVIDER_STREAM',
            retryable: false,
          });
        }
        const payload = rawPayload as OpenAIChatPayload;
        const upstreamError = providerError(payload);
        if (upstreamError !== undefined) {
          const recoveryMessage = recoveryErrorMessage(rawPayload);
          const recovered =
            recoveryMessage === undefined
              ? undefined
              : recoverProviderToolCall(recoveryMessage, request.tools);
          const compatible =
            recovered === undefined || emittedContent || emittedUsage
              ? undefined
              : compatiblePartialToolCall(nativeToolCalls, recovered, nativeSnapshotSeen);
          if (recovered !== undefined && compatible !== undefined) {
            const recoveredEvent = {
              type: 'tool_call_delta' as const,
              index: 0,
              id: compatible.id,
              name: recovered.name,
              arguments: recovered.arguments,
              snapshot: true,
            };
            mergeToolCalls(nativeToolCalls, recoveredEvent);
            nativeSnapshotSeen = true;
            yield recoveredEvent;
            finishReason = 'tool_calls';
            break;
          }
          if (isProviderToolRecoveryMessage(providerErrorMessage(payload, ''))) {
            throw new ProviderError('上游返回的工具调用无法安全恢复', {
              code: 'INVALID_PROVIDER_TOOL_CALL',
              retryable: false,
            });
          }
          throw new ProviderError(providerErrorMessage(payload, '上游流返回错误'), {
            code: providerErrorCode(payload, 'PROVIDER_STREAM_ERROR'),
            retryable: false,
            providerBody: payload,
          });
        }
        const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
        const content = choice?.delta?.content;
        if (typeof content === 'string' && content !== '') {
          emittedContent = true;
          yield { type: 'delta', content };
        }
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoning === 'string' && reasoning !== '') {
          yield { type: 'reasoning_delta', content: reasoning };
        }
        for (const toolCall of Array.isArray(choice?.delta?.tool_calls)
          ? choice.delta.tool_calls
          : []) {
          const toolEvent = {
            type: 'tool_call_delta' as const,
            index:
              typeof toolCall.index === 'number' &&
              Number.isInteger(toolCall.index) &&
              toolCall.index >= 0
                ? toolCall.index
                : 0,
            ...(toolCall.id === undefined ? {} : { id: toolCall.id }),
            ...(toolCall.function?.name === undefined ? {} : { name: toolCall.function.name }),
            ...(toolCall.function?.arguments === undefined
              ? {}
              : { arguments: toolCall.function.arguments }),
          };
          mergeToolCalls(nativeToolCalls, toolEvent);
          yield toolEvent;
        }
        const messageToolCalls: unknown[] = Array.isArray(choice?.message?.tool_calls)
          ? choice.message.tool_calls
          : [];
        for (const [index, rawToolCall] of messageToolCalls.entries()) {
          if (!isRecord(rawToolCall) || !isRecord(rawToolCall['function'])) continue;
          const rawFunction = rawToolCall['function'];
          const id = typeof rawToolCall['id'] === 'string' ? rawToolCall['id'] : undefined;
          const name = typeof rawFunction['name'] === 'string' ? rawFunction['name'] : undefined;
          const arguments_ =
            typeof rawFunction['arguments'] === 'string' ? rawFunction['arguments'] : undefined;
          if (id === undefined && name === undefined && arguments_ === undefined) continue;
          const snapshotEvent = {
            type: 'tool_call_delta' as const,
            index,
            snapshot: true,
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
            ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
          };
          mergeToolCalls(nativeToolCalls, snapshotEvent);
          nativeSnapshotSeen = true;
          yield snapshotEvent;
        }
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = choice.finish_reason;
        }
        if (payload.usage !== undefined) {
          emittedUsage = true;
          yield { type: 'usage', usage: toUsage(payload.usage) };
        }
      }
      if (!emittedUsage) yield { type: 'usage', usage: toUsage(undefined) };
      yield { type: 'done', finishReason };
    } catch (error) {
      if (error instanceof SseProtocolError) {
        throw new ProviderError(error.message, {
          code: error.code,
          retryable: false,
          cause: error,
        });
      }
      throw normalizeProviderError(error);
    } finally {
      lifetime.cleanup();
    }
  }

  public async collectStream(request: RuntimeChatRequest): Promise<RuntimeChatResponse> {
    let content = '';
    let reasoning = '';
    let usage = toUsage(undefined);
    let finishReason: string | null = null;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const event of this.streamChat(request)) {
      if (event.type === 'delta') content += event.content;
      else if (event.type === 'reasoning_delta') reasoning += event.content;
      else if (event.type === 'tool_call_delta') mergeToolCalls(toolCalls, event);
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'done') finishReason = event.finishReason;
    }
    return {
      model: request.model,
      content,
      reasoning,
      toolCalls: [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      finishReason,
      usage,
    };
  }
}
