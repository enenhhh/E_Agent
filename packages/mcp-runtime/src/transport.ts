import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  SupportedMcpProtocolVersion,
} from './protocol.js';

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpTransportMessageListener = (message: JsonRpcMessage) => void | Promise<void>;

export interface McpTransport {
  readonly kind: 'stdio' | 'streamable-http';
  readonly connected: boolean;
  connect(options?: McpRequestOptions): Promise<void>;
  request(request: JsonRpcRequest, options?: McpRequestOptions): Promise<JsonRpcResponse>;
  notify(notification: JsonRpcNotification, options?: McpRequestOptions): Promise<void>;
  respond(id: JsonRpcId, result: unknown, error?: { code: number; message: string }): Promise<void>;
  setProtocolVersion(version: SupportedMcpProtocolVersion): void;
  startServerStream?(options?: McpRequestOptions): Promise<void>;
  subscribe(listener: McpTransportMessageListener): () => void;
  close(): Promise<void>;
}

export interface McpRuntimeLogger {
  (
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

export function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function createTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException('请求超时', 'TimeoutError'));
  }, timeoutMs);
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}
