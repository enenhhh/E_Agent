import { DomainError } from './errors.js';

export interface ConversationExecutionQueueSnapshot {
  activeConversations: number;
  pending: number;
}

export interface ConversationExecutionLease {
  release(): void;
}

interface PendingExecution {
  resolve: (lease: ConversationExecutionLease) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface ConversationLane {
  readonly pending: PendingExecution[];
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('聊天生成已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 按会话串行化聊天生成，避免多个客户端把同一会话写成 U1/U2/A2/A1。
 *
 * 每个 key 同时只有一个持有者，不同 key 仍可并行。等待队列有全局和单会话双重上限，
 * 防止恶意或失控客户端在全局请求队列之前无限占用内存。
 */
export class ConversationExecutionQueue {
  readonly #maxPending: number;
  readonly #maxPendingPerConversation: number;
  readonly #lanes = new Map<string, ConversationLane>();
  #pending = 0;

  public constructor(
    options: {
      maxPending?: number;
      maxPendingPerConversation?: number;
    } = {},
  ) {
    this.#maxPending = options.maxPending ?? 200;
    this.#maxPendingPerConversation = options.maxPendingPerConversation ?? 50;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 0 || this.#maxPending > 10_000) {
      throw new Error('会话执行等待总数上限必须是 0 到 10000 的整数');
    }
    if (
      !Number.isInteger(this.#maxPendingPerConversation) ||
      this.#maxPendingPerConversation < 0 ||
      this.#maxPendingPerConversation > 10_000
    ) {
      throw new Error('单会话执行等待数上限必须是 0 到 10000 的整数');
    }
  }

  public get snapshot(): ConversationExecutionQueueSnapshot {
    return {
      activeConversations: this.#lanes.size,
      pending: this.#pending,
    };
  }

  public acquire(
    key: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConversationExecutionLease> {
    if (options.signal?.aborted === true) return Promise.reject(abortReason(options.signal));
    const lane = this.#lanes.get(key);
    if (lane === undefined) {
      const createdLane: ConversationLane = { pending: [] };
      this.#lanes.set(key, createdLane);
      return Promise.resolve(this.#createLease(key, createdLane));
    }
    if (
      this.#pending >= this.#maxPending ||
      lane.pending.length >= this.#maxPendingPerConversation
    ) {
      return Promise.reject(
        new DomainError('QUEUE_FULL', '该会话的生成请求正在排队，请稍后重试', {
          retryable: true,
        }),
      );
    }

    return new Promise<ConversationExecutionLease>((resolve, reject) => {
      const pending: PendingExecution = {
        resolve,
        reject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      lane.pending.push(pending);
      this.#pending += 1;
      if (options.signal !== undefined) {
        pending.abortHandler = () => {
          const index = lane.pending.indexOf(pending);
          if (index < 0) return;
          lane.pending.splice(index, 1);
          this.#pending = Math.max(0, this.#pending - 1);
          reject(abortReason(options.signal!));
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
    });
  }

  #createLease(key: string, lane: ConversationLane): ConversationExecutionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#grantNext(key, lane);
      },
    };
  }

  #grantNext(key: string, lane: ConversationLane): void {
    while (lane.pending.length > 0) {
      const next = lane.pending.shift();
      if (next === undefined) break;
      this.#pending = Math.max(0, this.#pending - 1);
      if (next.signal !== undefined && next.abortHandler !== undefined) {
        next.signal.removeEventListener('abort', next.abortHandler);
      }
      if (next.signal?.aborted === true) {
        next.reject(abortReason(next.signal));
        continue;
      }
      next.resolve(this.#createLease(key, lane));
      return;
    }
    if (this.#lanes.get(key) === lane) this.#lanes.delete(key);
  }
}
