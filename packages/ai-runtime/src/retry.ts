import { normalizeProviderError } from './errors.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 使用带抖动的指数退避重试瞬时故障。 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('最大重试次数必须是 1 到 10 的整数');
  }
  if (
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < baseDelayMs ||
    !Number.isFinite(jitterRatio) ||
    jitterRatio < 0 ||
    jitterRatio > 1
  ) {
    throw new Error('重试延迟配置无效');
  }
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const normalized = normalizeProviderError(error);
      const shouldRetry =
        attempt < maxAttempts &&
        !options.signal?.aborted &&
        (options.shouldRetry?.(error, attempt) ?? normalized.retryable);
      if (!shouldRetry) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
      const requestedDelay = normalized.retryAfterMs ?? exponential + jitter;
      const delayMs = Math.max(0, Math.min(maxDelayMs, Math.round(requestedDelay)));
      options.onRetry?.(error, attempt, delayMs);
      await wait(delayMs, options.signal);
    }
  }
  throw lastError;
}
