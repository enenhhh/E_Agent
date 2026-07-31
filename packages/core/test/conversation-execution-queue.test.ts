import { describe, expect, it } from 'vitest';

import { ConversationExecutionQueue } from '../src/index.js';

describe('ConversationExecutionQueue', () => {
  it('同一会话按 FIFO 授予租约，不同会话可同时执行', async () => {
    const queue = new ConversationExecutionQueue();
    const first = await queue.acquire('conversation-a');
    const secondPromise = queue.acquire('conversation-a');
    const other = await queue.acquire('conversation-b');

    expect(queue.snapshot).toEqual({ activeConversations: 2, pending: 1 });
    first.release();
    const second = await secondPromise;
    expect(queue.snapshot).toEqual({ activeConversations: 2, pending: 0 });

    second.release();
    other.release();
    expect(queue.snapshot).toEqual({ activeConversations: 0, pending: 0 });
  });

  it('等待者中止后会从队列移除，且不会阻塞后续请求', async () => {
    const queue = new ConversationExecutionQueue();
    const active = await queue.acquire('conversation-a');
    const controller = new AbortController();
    const abortReason = new Error('cancel waiting execution');
    const waiting = queue.acquire('conversation-a', { signal: controller.signal });

    controller.abort(abortReason);
    await expect(waiting).rejects.toBe(abortReason);
    expect(queue.snapshot).toEqual({ activeConversations: 1, pending: 0 });

    active.release();
    const next = await queue.acquire('conversation-a');
    next.release();
    expect(queue.snapshot).toEqual({ activeConversations: 0, pending: 0 });
  });

  it('限制全局和单会话等待数，且租约重复释放无副作用', async () => {
    const queue = new ConversationExecutionQueue({
      maxPending: 2,
      maxPendingPerConversation: 1,
    });
    const first = await queue.acquire('conversation-a');
    const secondPromise = queue.acquire('conversation-a');

    await expect(queue.acquire('conversation-a')).rejects.toMatchObject({
      code: 'QUEUE_FULL',
      retryable: true,
    });
    const other = await queue.acquire('conversation-b');
    const otherWaiting = queue.acquire('conversation-b');
    const third = await queue.acquire('conversation-c');
    await expect(queue.acquire('conversation-c')).rejects.toMatchObject({
      code: 'QUEUE_FULL',
      retryable: true,
    });

    first.release();
    first.release();
    const second = await secondPromise;
    second.release();
    other.release();
    (await otherWaiting).release();
    third.release();
    expect(queue.snapshot).toEqual({ activeConversations: 0, pending: 0 });
  });

  it('拒绝无效的等待上限', () => {
    expect(() => new ConversationExecutionQueue({ maxPending: -1 })).toThrow(/0 到 10000/);
    expect(() => new ConversationExecutionQueue({ maxPending: 10_001 })).toThrow(/0 到 10000/);
    expect(() => new ConversationExecutionQueue({ maxPendingPerConversation: 1.5 })).toThrow(
      /0 到 10000/,
    );
  });

  it('中止原因缺失时返回可诊断的 AbortError', async () => {
    const queue = new ConversationExecutionQueue();
    const signal = { aborted: true, reason: undefined } as AbortSignal;

    await expect(queue.acquire('conversation-a', { signal })).rejects.toMatchObject({
      name: 'AbortError',
      message: '聊天生成已取消',
    });
  });
});
