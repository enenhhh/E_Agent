import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderError, withRetry } from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('retry policy', () => {
  it.each([
    { maxAttempts: 0 },
    { maxAttempts: 11 },
    { maxAttempts: 1.5 },
    { baseDelayMs: -1 },
    { baseDelayMs: Number.NaN },
    { baseDelayMs: 2, maxDelayMs: 1 },
    { jitterRatio: -0.1 },
    { jitterRatio: 1.1 },
  ])('rejects invalid options: %o', async (options) => {
    await expect(withRetry(async () => 'unused', options)).rejects.toBeInstanceOf(Error);
  });

  it('stops immediately for a non-retryable failure', async () => {
    const operation = vi.fn(async () => {
      throw new ProviderError('invalid', { retryable: false });
    });

    await expect(withRetry(operation)).rejects.toThrow('invalid');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('allows a custom policy to override retryability', async () => {
    const operation = vi.fn(async () => {
      throw new ProviderError('invalid', { retryable: false });
    });

    await expect(
      withRetry(operation, {
        maxAttempts: 2,
        baseDelayMs: 0,
        shouldRetry: (_error, attempt) => attempt === 1,
      }),
    ).rejects.toThrow('invalid');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('reports clamped exponential jitter delays', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const onRetry = vi.fn();
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue('ok');

    await expect(
      withRetry(operation, {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 1,
        onRetry,
      }),
    ).resolves.toBe('ok');
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 1);
  });

  it('cancels a pending backoff when the caller aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = withRetry(
      async () => {
        throw new Error('temporary');
      },
      {
        maxAttempts: 2,
        baseDelayMs: 1_000,
        jitterRatio: 0,
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    const reason = new DOMException('cancelled', 'AbortError');
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });

  it('does not retry when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const operation = vi.fn(async () => {
      throw new Error('temporary');
    });

    await expect(withRetry(operation, { signal: controller.signal })).rejects.toThrow('temporary');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
