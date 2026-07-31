import { redactMcpText } from './redaction.js';

export type McpErrorCode =
  | 'CONFIG_INVALID'
  | 'CONNECT_FAILED'
  | 'CONNECTION_CLOSED'
  | 'LIMIT_EXCEEDED'
  | 'PROTOCOL_INVALID'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'SERVER_DISABLED'
  | 'SERVER_ERROR'
  | 'SERVER_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'TOOL_NOT_FOUND'
  | 'TRANSPORT_ERROR';

export interface McpRuntimeErrorOptions {
  retryable?: boolean;
  serverId?: string;
  cause?: unknown;
}

/** 可安全穿过 IPC/API 边界的 MCP 错误，不携带响应体、凭据或子进程堆栈。 */
export class McpRuntimeError extends Error {
  public readonly code: McpErrorCode;
  public readonly retryable: boolean;
  public readonly serverId: string | undefined;

  public constructor(code: McpErrorCode, message: string, options: McpRuntimeErrorOptions = {}) {
    super(sanitizeMcpErrorMessage(message), { cause: options.cause });
    this.name = 'McpRuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.serverId = options.serverId;
  }
}

/** 将任意异常收敛为固定长度、脱敏且不含远端响应正文的用户错误。 */
export function toSafeMcpError(
  error: unknown,
  fallbackCode: McpErrorCode = 'TRANSPORT_ERROR',
  serverId?: string,
): McpRuntimeError {
  if (error instanceof McpRuntimeError) return error;
  if (isAbortError(error)) {
    return new McpRuntimeError('REQUEST_ABORTED', 'MCP 请求已取消。', { serverId });
  }
  const message = error instanceof Error ? error.message : 'MCP 操作失败。';
  return new McpRuntimeError(fallbackCode, message, {
    serverId,
    retryable: fallbackCode === 'CONNECT_FAILED' || fallbackCode === 'TRANSPORT_ERROR',
    cause: error,
  });
}

export function sanitizeMcpErrorMessage(message: string): string {
  const withoutUrls = message.replace(/\bhttps?:\/\/[^\s]+/giu, (value) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[远端地址]';
    }
  });
  return [...redactMcpText(withoutUrls)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .slice(0, 2_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}
