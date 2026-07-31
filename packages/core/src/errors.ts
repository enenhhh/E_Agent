import type { ErrorCode } from '@e-agent/contracts';

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_ERROR: 502,
  QUOTA_EXCEEDED: 429,
  QUEUE_FULL: 503,
  INTERNAL_ERROR: 500,
};

export interface DomainErrorOptions {
  cause?: unknown;
  statusCode?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** 可安全映射到 API 响应的领域错误。 */
export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = options.statusCode ?? STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new DomainError('NOT_FOUND', message);
  return value;
}
