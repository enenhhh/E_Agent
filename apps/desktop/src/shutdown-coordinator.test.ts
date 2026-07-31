import { describe, expect, it, vi } from 'vitest';

import { createShutdownCoordinator, type ShutdownFailure } from './shutdown-coordinator.js';

describe('createShutdownCoordinator', () => {
  it('单个步骤失败时继续按顺序执行后续清理', async () => {
    const executionOrder: string[] = [];
    const failures: ShutdownFailure[] = [];
    const shutdown = createShutdownCoordinator(
      [
        {
          name: 'ipc',
          run: () => {
            executionOrder.push('ipc');
            throw new Error('ipc failed');
          },
        },
        {
          name: 'runtime',
          run: async () => {
            executionOrder.push('runtime');
            await Promise.resolve();
          },
        },
        {
          name: 'logger',
          run: () => {
            executionOrder.push('logger');
          },
        },
      ],
      (failure) => failures.push(failure),
    );

    await expect(shutdown()).resolves.toBeUndefined();
    expect(executionOrder).toEqual(['ipc', 'runtime', 'logger']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.name).toBe('ipc');
  });

  it('并发和重复调用共享同一次清理，失败上报器抛错也不会中断', async () => {
    let releaseStep: (() => void) | undefined;
    const blockedStep = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    const firstStep = vi.fn(async () => {
      await blockedStep;
      throw new Error('expected failure');
    });
    const finalStep = vi.fn();
    const shutdown = createShutdownCoordinator(
      [
        { name: 'runtime', run: firstStep },
        { name: 'plugins', run: finalStep },
      ],
      () => {
        throw new Error('reporter failed');
      },
    );

    const firstCall = shutdown();
    const secondCall = shutdown();

    expect(secondCall).toBe(firstCall);
    expect(firstStep).toHaveBeenCalledOnce();
    releaseStep?.();
    await expect(Promise.all([firstCall, secondCall])).resolves.toEqual([undefined, undefined]);
    await shutdown();

    expect(firstStep).toHaveBeenCalledOnce();
    expect(finalStep).toHaveBeenCalledOnce();
  });

  it('未提供失败上报器时也会吸收清理异常并完成退出', async () => {
    const finalStep = vi.fn();
    const shutdown = createShutdownCoordinator([
      {
        name: 'runtime',
        run: () => {
          throw new Error('expected failure');
        },
      },
      { name: 'logger', run: finalStep },
    ]);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(finalStep).toHaveBeenCalledOnce();
  });
});
