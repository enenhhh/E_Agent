import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';

import { WorkspacePage } from './WorkspacePage';

const testState = vi.hoisted(() => ({
  conversation: {} as Record<string, unknown>,
  extension: {} as Record<string, unknown>,
  model: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  toast: {} as Record<string, unknown>,
}));

vi.mock('../../stores/conversation-store', () => ({
  useConversationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(testState.conversation),
}));

vi.mock('../../stores/extension-store', () => ({
  useExtensionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(testState.extension),
}));

vi.mock('../../stores/model-store', () => ({
  useModelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(testState.model),
}));

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(testState.settings),
}));

vi.mock('../../stores/toast-store', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(testState.toast),
}));

vi.mock('./ChatComposer', () => ({
  ChatComposer: () => <div data-testid="chat-composer" />,
}));

vi.mock('./ContextInspector', () => ({
  ContextInspector: () => <aside data-testid="context-inspector" />,
}));

vi.mock('./MessageCard', () => ({
  MessageCard: ({ message }: { message: { id: string } }) => (
    <article data-testid={`message-${message.id}`} />
  ),
}));

vi.mock('./SnapshotHistoryModal', () => ({
  SnapshotHistoryModal: () => null,
}));

const transport = { kind: 'mock' } as EAgentTransport;

function renderWorkspace(): ReturnType<typeof render> {
  return render(
    <TransportProvider mode="desktop" transport={transport}>
      <WorkspacePage />
    </TransportProvider>,
  );
}

function configureScrollGeometry(element: HTMLElement): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, value: 100, writable: true },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkspacePage conversation viewport', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    testState.conversation = {
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: '第一条消息',
          createdAt: '2026-07-29T00:00:00.000Z',
          status: 'completed',
        },
      ],
      conversations: [{ id: 'conversation-1', title: '会话' }],
      selectedId: 'conversation-1',
      loading: false,
      error: null,
      streaming: false,
      queuedPrompts: [],
      send: vi.fn(),
      sendNextQueued: vi.fn(),
      decideFileChange: vi.fn(),
      createConversation: vi.fn(),
      branchConversation: vi.fn(),
      selectConversation: vi.fn(),
      deleteMessage: vi.fn(),
      setMessageFeedback: vi.fn(),
      retryMessage: vi.fn(),
      editAndResend: vi.fn(),
      createSnapshot: vi.fn(),
      loadSnapshots: vi.fn(),
      restoreSnapshot: vi.fn(),
      snapshots: [],
      snapshotsLoading: false,
      restoringSnapshotId: null,
      snapshotError: null,
    };
    testState.extension = { loadSkills: vi.fn(async () => undefined) };
    testState.model = {
      models: [],
      selectedModel: null,
      routingMode: 'manual',
    };
    testState.settings = {
      settings: {
        defaultModels: {},
      },
    };
    testState.toast = { push: vi.fn() };
  });

  it('离开底部时显示跳转入口，点击后平滑滚动到最新消息', () => {
    renderWorkspace();
    const viewport = document.querySelector<HTMLElement>('.conversation-scroll')!;
    configureScrollGeometry(viewport);
    scrollTo.mockClear();

    fireEvent.scroll(viewport);

    const jump = screen.getByRole('button', { name: '回到最新消息' });
    expect(jump).toBeInTheDocument();
    fireEvent.click(jump);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: '回到最新消息' })).not.toBeInTheDocument();
  });

  it('仅在用户仍跟随底部时随新消息自动滚动', () => {
    const view = renderWorkspace();
    const viewport = document.querySelector<HTMLElement>('.conversation-scroll')!;
    configureScrollGeometry(viewport);
    scrollTo.mockClear();

    fireEvent.scroll(viewport);
    testState.conversation.messages = [
      ...(testState.conversation.messages as object[]),
      {
        id: 'message-2',
        role: 'assistant',
        content: '第二条消息',
        createdAt: '2026-07-29T00:00:01.000Z',
        status: 'completed',
      },
    ];
    view.rerender(
      <TransportProvider mode="desktop" transport={transport}>
        <WorkspacePage />
      </TransportProvider>,
    );
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.scrollTop = 550;
    fireEvent.scroll(viewport);
    expect(screen.queryByRole('button', { name: '回到最新消息' })).not.toBeInTheDocument();

    testState.conversation.messages = [
      ...(testState.conversation.messages as object[]),
      {
        id: 'message-3',
        role: 'assistant',
        content: '第三条消息',
        createdAt: '2026-07-29T00:00:02.000Z',
        status: 'completed',
      },
    ];
    view.rerender(
      <TransportProvider mode="desktop" transport={transport}>
        <WorkspacePage />
      </TransportProvider>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
  });
});
