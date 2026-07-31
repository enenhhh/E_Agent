import type { StreamableHttpMcpTransportConfig } from './config.js';
import { McpRuntimeError, toSafeMcpError } from './errors.js';
import {
  isJsonRpcResponse,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SupportedMcpProtocolVersion,
} from './protocol.js';
import { redactMcpValue } from './redaction.js';
import { consumeSseStream } from './sse.js';
import {
  createTimeoutSignal,
  requestKey,
  type McpRequestOptions,
  type McpRuntimeLogger,
  type McpTransport,
  type McpTransportMessageListener,
} from './transport.js';

export interface StreamableHttpMcpTransportOptions {
  serverId: string;
  config: StreamableHttpMcpTransportConfig;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  logger?: McpRuntimeLogger;
  fetch?: typeof fetch;
}

/** MCP Streamable HTTP 传输，支持 JSON 响应、POST SSE 响应和后台 GET 事件流。 */
export class StreamableHttpMcpTransport implements McpTransport {
  public readonly kind = 'streamable-http' as const;
  private readonly listeners = new Set<McpTransportMessageListener>();
  private active = false;
  private sessionId: string | undefined;
  private protocolVersion: SupportedMcpProtocolVersion | undefined;
  private streamController: AbortController | undefined;
  private streamTask: Promise<void> | undefined;

  public constructor(private readonly options: StreamableHttpMcpTransportOptions) {}

  public get connected(): boolean {
    return this.active;
  }

  public async connect(_options: McpRequestOptions = {}): Promise<void> {
    this.active = true;
  }

  public setProtocolVersion(version: SupportedMcpProtocolVersion): void {
    this.protocolVersion = version;
  }

  public async request(
    request: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    this.assertConnected();
    const response = await this.post(request, options);
    if (response === undefined || !isJsonRpcResponse(response)) {
      throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP HTTP 响应缺少 JSON-RPC 结果。', {
        serverId: this.options.serverId,
      });
    }
    if (requestKey(response.id ?? 'null') !== requestKey(request.id)) {
      throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP HTTP 响应 ID 与请求不匹配。', {
        serverId: this.options.serverId,
      });
    }
    return response;
  }

  public async notify(
    notification: JsonRpcNotification,
    options: McpRequestOptions = {},
  ): Promise<void> {
    this.assertConnected();
    await this.post(notification, options);
  }

  public async respond(
    id: JsonRpcId,
    result: unknown,
    error?: { code: number; message: string },
  ): Promise<void> {
    this.assertConnected();
    await this.post(
      error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error },
      {},
    );
  }

  public subscribe(listener: McpTransportMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async startServerStream(options: McpRequestOptions = {}): Promise<void> {
    if (
      !this.active ||
      this.options.config.openEventStream === false ||
      this.streamTask !== undefined
    ) {
      return;
    }
    const controller = new AbortController();
    this.streamController = controller;
    const fetchImplementation = this.options.fetch ?? fetch;
    const startup = createTimeoutSignal(
      options.timeoutMs ?? this.options.connectTimeoutMs ?? 10_000,
      controller.signal,
    );
    try {
      const response = await settleWithSignal(
        fetchImplementation(this.options.config.url, {
          method: 'GET',
          headers: this.headers(),
          redirect: 'error',
          signal: startup.signal,
        }),
        startup.signal,
      );
      startup.dispose();
      if ([400, 404, 405].includes(response.status)) {
        this.streamController = undefined;
        return;
      }
      if (!response.ok || response.body === null) {
        throw new McpRuntimeError(
          'TRANSPORT_ERROR',
          `MCP 事件流连接失败（HTTP ${response.status}）。`,
          { serverId: this.options.serverId, retryable: response.status >= 500 },
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP GET 响应不是 SSE 事件流。', {
          serverId: this.options.serverId,
        });
      }
      this.streamTask = consumeSseStream(response.body, {
        maxEventBytes: this.maximumMessageBytes,
        signal: controller.signal,
        onData: async (data) => {
          const message = this.parsePayload(data);
          await this.dispatch(message);
          return false;
        },
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          if (!controller.signal.aborted && this.active) {
            const safe = toSafeMcpError(error, 'TRANSPORT_ERROR', this.options.serverId);
            this.log('warn', 'MCP HTTP 事件流已中断', {
              serverId: this.options.serverId,
              code: safe.code,
              message: safe.message,
            });
          }
        })
        .finally(() => {
          this.streamTask = undefined;
          if (this.streamController === controller) this.streamController = undefined;
        });
    } catch (error) {
      startup.dispose();
      this.streamController = undefined;
      if (startup.timedOut()) {
        controller.abort();
        throw new McpRuntimeError('REQUEST_TIMEOUT', 'MCP 事件流握手超时。', {
          serverId: this.options.serverId,
          retryable: true,
        });
      }
      if (controller.signal.aborted) return;
      throw toSafeMcpError(error, 'CONNECT_FAILED', this.options.serverId);
    }
  }

  public async close(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.streamController?.abort();
    await this.streamTask?.catch(() => undefined);
    this.streamTask = undefined;
    this.streamController = undefined;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    if (sessionId === undefined) return;
    const timeout = createTimeoutSignal(2_000);
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.config.url, {
        method: 'DELETE',
        headers: this.headers(sessionId),
        redirect: 'error',
        signal: timeout.signal,
      });
      if (!response.ok && response.status !== 405 && response.status !== 404) {
        this.log('warn', 'MCP HTTP 会话关闭失败', {
          serverId: this.options.serverId,
          status: response.status,
        });
      }
    } catch {
      // 关闭是尽力而为；此处不覆盖业务请求结果。
    } finally {
      timeout.dispose();
    }
  }

  private async post(
    message: JsonRpcMessage,
    requestOptions: McpRequestOptions,
  ): Promise<JsonRpcMessage | undefined> {
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, 'utf8') > this.maximumMessageBytes) {
      throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP HTTP 请求超过大小限制。', {
        serverId: this.options.serverId,
      });
    }
    const timeout = createTimeoutSignal(
      requestOptions.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
      requestOptions.signal,
    );
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.config.url, {
        method: 'POST',
        headers: this.headers(),
        body: serialized,
        redirect: 'error',
        signal: timeout.signal,
      });
      const assignedSession = response.headers.get('mcp-session-id');
      if (assignedSession !== null) {
        if (!/^[\x21-\x7e]+$/u.test(assignedSession) || assignedSession.length > 1_024) {
          throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP 会话 ID 无效。', {
            serverId: this.options.serverId,
          });
        }
        this.sessionId = assignedSession;
      }
      if (response.status === 404 && this.sessionId !== undefined) {
        this.sessionId = undefined;
        throw new McpRuntimeError('SESSION_EXPIRED', 'MCP HTTP 会话已过期，请重新连接。', {
          serverId: this.options.serverId,
          retryable: true,
        });
      }
      if (response.status === 202) return undefined;
      if (!response.ok) {
        throw new McpRuntimeError(
          'TRANSPORT_ERROR',
          `MCP HTTP 请求失败（HTTP ${response.status}）。`,
          { serverId: this.options.serverId, retryable: response.status >= 500 },
        );
      }
      if (response.body === null) return undefined;
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('text/event-stream')) {
        let matching: JsonRpcMessage | undefined;
        const expectedId = 'id' in message ? message.id : undefined;
        await consumeSseStream(response.body, {
          maxEventBytes: this.maximumMessageBytes,
          signal: timeout.signal,
          onData: async (data) => {
            const parsed = this.parsePayload(data);
            if (
              expectedId !== undefined &&
              expectedId !== null &&
              isJsonRpcResponse(parsed) &&
              requestKey(parsed.id ?? 'null') === requestKey(expectedId)
            ) {
              matching = parsed;
              return true;
            }
            await this.dispatch(parsed);
            return false;
          },
        });
        return matching;
      }
      if (!contentType.includes('application/json')) {
        throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP HTTP 响应类型不受支持。', {
          serverId: this.options.serverId,
        });
      }
      return this.parsePayload(await readBodyWithLimit(response.body, this.maximumMessageBytes));
    } catch (error) {
      if (timeout.timedOut()) {
        throw new McpRuntimeError('REQUEST_TIMEOUT', 'MCP HTTP 请求超时。', {
          serverId: this.options.serverId,
          retryable: true,
        });
      }
      if (requestOptions.signal?.aborted === true) {
        throw new McpRuntimeError('REQUEST_ABORTED', 'MCP HTTP 请求已取消。', {
          serverId: this.options.serverId,
        });
      }
      throw toSafeMcpError(error, 'TRANSPORT_ERROR', this.options.serverId);
    } finally {
      timeout.dispose();
    }
  }

  private headers(sessionOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...this.options.config.headers,
    };
    const sessionId = sessionOverride ?? this.sessionId;
    if (sessionId !== undefined) headers['Mcp-Session-Id'] = sessionId;
    if (this.protocolVersion !== undefined) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    return headers;
  }

  private parsePayload(payload: string): JsonRpcMessage {
    if (Buffer.byteLength(payload, 'utf8') > this.maximumMessageBytes) {
      throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP HTTP 响应超过大小限制。', {
        serverId: this.options.serverId,
      });
    }
    try {
      return parseJsonRpcMessage(JSON.parse(payload) as unknown);
    } catch {
      throw new McpRuntimeError('PROTOCOL_INVALID', 'MCP HTTP 响应不是有效 JSON-RPC。', {
        serverId: this.options.serverId,
      });
    }
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    for (const listener of this.listeners) await listener(message);
  }

  private assertConnected(): void {
    if (!this.active) {
      throw new McpRuntimeError('CONNECTION_CLOSED', 'MCP HTTP 服务未连接。', {
        serverId: this.options.serverId,
      });
    }
  }

  private get maximumMessageBytes(): number {
    return this.options.maxMessageBytes ?? 4 * 1_024 * 1_024;
  }

  private log(
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.options.logger?.(level, message, redactMcpValue(fields ?? {}));
  }
}

function settleWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    let finished = false;
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        continue;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new McpRuntimeError('LIMIT_EXCEEDED', 'MCP HTTP 响应超过大小限制。');
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
