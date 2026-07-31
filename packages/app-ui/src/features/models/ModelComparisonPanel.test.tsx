import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useConversationStore } from '../../stores/conversation-store';
import { useModelStore } from '../../stores/model-store';
import type { Conversation, Model } from '../../types';

import { ModelComparisonPanel } from './ModelComparisonPanel';

const originalConversationActions = {
  createConversation: useConversationStore.getState().createConversation,
  refreshConversationSummary: useConversationStore.getState().refreshConversationSummary,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function model(id: string): Model {
  return {
    id,
    providerId: 'provider-1',
    providerName: 'Provider',
    provider: 'custom',
    displayName: id,
    contextWindow: 64_000,
    capabilities: ['chat'],
    available: true,
  };
}

function conversation(id: string, title = '新会话'): Conversation {
  return {
    id,
    title,
    pinned: false,
    archived: false,
    updatedAt: '2026-07-30T10:00:00.000Z',
    branchCount: 0,
    messageCount: 0,
  };
}

function renderPanel(transport: EAgentTransport): void {
  render(
    <TransportProvider mode="web" transport={transport}>
      <ModelComparisonPanel />
    </TransportProvider>,
  );
}

afterEach(cleanup);

describe('ModelComparisonPanel', () => {
  beforeEach(() => {
    useModelStore.setState({
      models: [model('model-a'), model('model-b')],
      compareModels: ['model-a', 'model-b'],
    });
    useConversationStore.setState({
      conversations: [],
      selectedId: null,
      messages: [],
      streaming: false,
      loading: false,
      messageMutationId: null,
      conversationRevision: 0,
      createConversation: originalConversationActions.createConversation,
      refreshConversationSummary: originalConversationActions.refreshConversationSummary,
    });
  });

  it('并排模型完成后刷新当前会话的自动标题', async () => {
    const current = conversation('comparison-current');
    const refreshed = { ...current, title: '模型对比结果标题', messageCount: 4 };
    useConversationStore.setState({
      conversations: [current],
      selectedId: current.id,
    });
    const streamChat = vi.fn(async function* () {
      yield { type: 'done' as const, requestId: crypto.randomUUID() };
    });
    const getConversation = vi.fn().mockResolvedValue(refreshed);
    const transport = { streamChat, getConversation } as unknown as EAgentTransport;
    renderPanel(transport);

    fireEvent.change(document.querySelector('.model-comparison__prompt textarea')!, {
      target: { value: '比较两个实现' },
    });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-comparison__prompt button')!);

    await waitFor(() =>
      expect(useConversationStore.getState().conversations[0]?.title).toBe(refreshed.title),
    );
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(getConversation).toHaveBeenCalledOnce();
    expect(getConversation).toHaveBeenCalledWith(current.id);
  });

  it('没有当前会话时创建会话，并在对比完成后刷新其自动标题', async () => {
    const created = conversation('comparison-created');
    const refreshed = { ...created, title: '新建对比会话标题', messageCount: 4 };
    const createConversation = vi.fn().mockResolvedValue(created);
    const streamChat = vi.fn(async function* () {
      yield { type: 'done' as const, requestId: crypto.randomUUID() };
    });
    const getConversation = vi.fn().mockResolvedValue(refreshed);
    const transport = {
      createConversation,
      streamChat,
      getConversation,
    } as unknown as EAgentTransport;
    renderPanel(transport);

    fireEvent.change(document.querySelector('.model-comparison__prompt textarea')!, {
      target: { value: '为新会话执行模型对比' },
    });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-comparison__prompt button')!);

    await waitFor(() =>
      expect(useConversationStore.getState().conversations[0]?.title).toBe(refreshed.title),
    );
    expect(createConversation).toHaveBeenCalledOnce();
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(getConversation).toHaveBeenCalledWith(created.id);
  });

  it('用户停止新建会话的模型对比后仍刷新自动标题', async () => {
    const created = conversation('comparison-cancelled');
    const refreshed = { ...created, title: '已停止对比的会话标题', messageCount: 2 };
    const createConversation = vi.fn().mockResolvedValue(created);
    const streamChat = vi.fn(async function* (_input: unknown, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      yield { type: 'done' as const, requestId: 'never' };
    });
    const summaryRefresh = deferred<typeof refreshed>();
    const getConversation = vi.fn(() => summaryRefresh.promise);
    const transport = {
      createConversation,
      streamChat,
      getConversation,
    } as unknown as EAgentTransport;
    renderPanel(transport);

    fireEvent.change(document.querySelector('.model-comparison__prompt textarea')!, {
      target: { value: '启动后停止模型对比' },
    });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-comparison__prompt button')!);
    await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
    fireEvent.click(document.querySelector<HTMLButtonElement>('.model-comparison__prompt button')!);

    await waitFor(() => expect(getConversation).toHaveBeenCalledWith(created.id));
    await waitFor(() =>
      expect(document.querySelectorAll('.model-comparison__grid article header span')).toHaveLength(
        0,
      ),
    );
    expect(useConversationStore.getState().conversations[0]?.title).toBe(created.title);
    summaryRefresh.resolve(refreshed);
    await waitFor(() =>
      expect(useConversationStore.getState().conversations[0]?.title).toBe(refreshed.title),
    );
  });
});
