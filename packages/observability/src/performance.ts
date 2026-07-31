import { performance } from 'node:perf_hooks';

import type { AppLogger } from './logger.js';
import { metrics, type MetricsRegistry } from './metrics.js';

export interface OperationResult<T> {
  value: T;
  durationMs: number;
}

/** 统一记录异步操作耗时和失败计数。 */
export async function measureOperation<T>(
  name: string,
  operation: () => Promise<T>,
  options: {
    logger?: AppLogger;
    registry?: MetricsRegistry;
    labels?: Readonly<Record<string, string>>;
  } = {},
): Promise<OperationResult<T>> {
  const startedAt = performance.now();
  const registry = options.registry ?? metrics;
  try {
    const value = await operation();
    const durationMs = performance.now() - startedAt;
    registry.observe('e_agent_operation_duration_ms', durationMs, {
      operation: name,
      outcome: 'success',
      ...options.labels,
    });
    return { value, durationMs };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    registry.observe('e_agent_operation_duration_ms', durationMs, {
      operation: name,
      outcome: 'error',
      ...options.labels,
    });
    registry.increment('e_agent_operation_errors_total', { operation: name, ...options.labels });
    options.logger?.warn({ err: error, operation: name, durationMs }, '操作执行失败');
    throw error;
  }
}

export interface RuntimeHealth {
  uptimeSeconds: number;
  residentMemoryBytes: number;
  heapUsedBytes: number;
  eventLoopDelayMs: number;
}

/** 采样进程资源占用和事件循环延迟。 */
export async function sampleRuntimeHealth(): Promise<RuntimeHealth> {
  const startedAt = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const eventLoopDelayMs = performance.now() - startedAt;
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    residentMemoryBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopDelayMs,
  };
}
