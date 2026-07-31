export interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export interface ShutdownFailure {
  readonly name: string;
  readonly error: unknown;
}

/**
 * 创建只执行一次的退出协调器。
 *
 * 清理步骤按声明顺序执行；单个步骤或失败上报器抛错时，后续步骤仍会继续。
 * 并发调用会共享同一个 Promise，避免资源被重复关闭。
 */
export function createShutdownCoordinator(
  steps: readonly ShutdownStep[],
  reportFailure: (failure: ShutdownFailure) => void = () => undefined,
): () => Promise<void> {
  const stableSteps = [...steps];
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= runShutdown(stableSteps, reportFailure);
    return shutdownPromise;
  };
}

async function runShutdown(
  steps: readonly ShutdownStep[],
  reportFailure: (failure: ShutdownFailure) => void,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      try {
        reportFailure({ name: step.name, error });
      } catch {
        // 失败上报不能中断后续资源清理。
      }
    }
  }
}
