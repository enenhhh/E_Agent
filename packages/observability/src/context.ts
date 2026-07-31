import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  userId?: string;
  conversationId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** 在异步调用链中传播请求标识，便于日志与用量记录关联。 */
export function withRequestContext<T>(context: Partial<RequestContext>, callback: () => T): T {
  return requestContextStorage.run(
    {
      requestId: context.requestId ?? randomUUID(),
      ...(context.userId === undefined ? {} : { userId: context.userId }),
      ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
    },
    callback,
  );
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getRequestId(): string {
  return requestContextStorage.getStore()?.requestId ?? randomUUID();
}
