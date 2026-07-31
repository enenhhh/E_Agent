import { redactSensitive, redactText } from '@e-agent/security';

export interface ProviderErrorOptions {
  status?: number;
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  providerBody?: unknown;
  cause?: unknown;
}

/** 统一封装上游模型错误，响应体必须在日志层再次脱敏。 */
export class ProviderError extends Error {
  public readonly status: number | undefined;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | undefined;
  public readonly providerBody: unknown;

  public constructor(message: string, options: ProviderErrorOptions = {}) {
    super(redactText(message), { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.code = options.code ?? 'PROVIDER_ERROR';
    this.retryable =
      options.retryable ??
      (options.status === undefined ||
        options.status === 408 ||
        options.status === 409 ||
        options.status === 429 ||
        options.status >= 500);
    this.retryAfterMs = options.retryAfterMs;
    this.providerBody = redactSensitive(options.providerBody);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAbortError(error)) {
    return new ProviderError('上游请求已取消或超时', {
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
      cause: error,
    });
  }
  return new ProviderError(error instanceof Error ? error.message : '未知上游错误', {
    code: 'PROVIDER_NETWORK_ERROR',
    retryable: true,
    cause: error,
  });
}
