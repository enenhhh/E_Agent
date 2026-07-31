import { DomainError } from './errors.js';

export interface QueueSnapshot {
  active: number;
  pending: number;
  concurrency: number;
}

interface PendingLease {
  id: number;
  priority: number;
  resolve: (lease: QueueLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  onPosition?: (position: number, snapshot: QueueSnapshot) => void;
  lastNotifiedPosition?: number;
}

export interface QueueLease {
  release(): void;
}

/** 并发请求队列。租约在整个 SSE 生命周期内持有，防止只限制建连阶段。 */
export class RequestQueue {
  #concurrency: number;
  readonly #maxPending: number;
  #active = 0;
  #sequence = 0;
  readonly #pending: PendingLease[] = [];

  public constructor(options: { concurrency?: number; maxPending?: number } = {}) {
    this.#concurrency = options.concurrency ?? 5;
    this.#maxPending = options.maxPending ?? 200;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 32) {
      throw new Error('并发数必须是 1 到 32 的整数');
    }
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 0 || this.#maxPending > 10_000) {
      throw new Error('排队上限必须是 0 到 10000 的整数');
    }
  }

  public get snapshot(): QueueSnapshot {
    return { active: this.#active, pending: this.#pending.length, concurrency: this.#concurrency };
  }

  public setConcurrency(concurrency: number): void {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error('并发数必须在 1 到 32 之间');
    }
    this.#concurrency = concurrency;
    this.#drain();
  }

  public acquire(
    options: {
      signal?: AbortSignal;
      priority?: number;
      onPosition?: (position: number, snapshot: QueueSnapshot) => void;
    } = {},
  ): Promise<QueueLease> {
    if (options.signal?.aborted === true) return Promise.reject(options.signal.reason);
    if (
      options.priority !== undefined &&
      (!Number.isFinite(options.priority) || Math.abs(options.priority) > 1_000_000)
    ) {
      return Promise.reject(new DomainError('BAD_REQUEST', '队列优先级无效'));
    }
    if (this.#active < this.#concurrency && this.#pending.length === 0) {
      this.#active += 1;
      return Promise.resolve(this.#createLease());
    }
    if (this.#pending.length >= this.#maxPending) {
      return Promise.reject(
        new DomainError('QUEUE_FULL', '请求队列已满，请稍后重试', { retryable: true }),
      );
    }
    return new Promise<QueueLease>((resolve, reject) => {
      const pending: PendingLease = {
        id: this.#sequence,
        priority: options.priority ?? 0,
        resolve,
        reject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onPosition === undefined ? {} : { onPosition: options.onPosition }),
      };
      this.#sequence += 1;
      this.#pending.push(pending);
      this.#pending.sort((left, right) => right.priority - left.priority || left.id - right.id);
      if (options.signal !== undefined) {
        pending.abortHandler = () => {
          const index = this.#pending.indexOf(pending);
          if (index >= 0) {
            this.#pending.splice(index, 1);
            reject(options.signal?.reason);
            this.#notifyPositions();
          }
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.#notifyPositions();
    });
  }

  public async run<T>(
    task: () => Promise<T>,
    options: Parameters<RequestQueue['acquire']>[0] = {},
  ): Promise<T> {
    const lease = await this.acquire(options);
    try {
      return await task();
    } finally {
      lease.release();
    }
  }

  #createLease(): QueueLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active = Math.max(0, this.#active - 1);
        this.#drain();
      },
    };
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const next = this.#pending.shift();
      if (next === undefined) break;
      if (next.signal !== undefined && next.abortHandler !== undefined) {
        next.signal.removeEventListener('abort', next.abortHandler);
      }
      if (next.signal?.aborted === true) {
        next.reject(next.signal.reason);
        continue;
      }
      this.#active += 1;
      next.resolve(this.#createLease());
    }
    this.#notifyPositions();
  }

  #notifyPositions(): void {
    const snapshot = this.snapshot;
    this.#pending.forEach((pending, index) => {
      const position = index + 1;
      if (pending.lastNotifiedPosition === position) return;
      try {
        pending.onPosition?.(position, snapshot);
        pending.lastNotifiedPosition = position;
      } catch {
        // 位置通知属于观测回调，不能破坏队列状态。
      }
    });
  }
}
