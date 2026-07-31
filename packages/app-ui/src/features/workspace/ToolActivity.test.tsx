import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportProvider } from '../../context/TransportContext';
import type { EAgentTransport } from '../../lib/transport';
import { useAuthStore } from '../../stores/auth-store';
import { useConversationStore } from '../../stores/conversation-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { ToolCall } from '../../types';

import { ToolActivity } from './ToolActivity';

const originalDecideToolCall = useConversationStore.getState().decideToolCall;

function toolCall(id: string, name: string, status: ToolCall['status'] = 'completed'): ToolCall {
  return {
    arguments: '{}',
    id,
    name,
    status,
  };
}

describe('ToolActivity', () => {
  beforeEach(() => {
    useAuthStore.setState({ error: null, session: null, status: 'idle' });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        autoExpandRunningTools: true,
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useConversationStore.setState({ decideToolCall: originalDecideToolCall });
  });

  it('折叠组内仍保留桌面工具审批和文件变更操作', async () => {
    const decideToolCall = vi.fn<typeof originalDecideToolCall>().mockResolvedValue(undefined);
    const onFileDecision = vi.fn();
    useConversationStore.setState({ decideToolCall });

    const view = render(
      <TransportProvider mode="desktop" transport={{} as EAgentTransport}>
        <ToolActivity
          conversationId="conversation-1"
          fileChanges={[
            {
              diff: '@@ -1 +1 @@\n-old\n+new',
              id: 'change-1',
              path: 'src/index.ts',
              status: 'pending',
            },
          ]}
          onFileDecision={onFileDecision}
          order={[
            { id: 'command-1', kind: 'tool-call' },
            { id: 'tool-message-1', kind: 'tool-message' },
            { id: 'read-1', kind: 'tool-call' },
            { id: 'read-2', kind: 'tool-call' },
          ]}
          toolCalls={[
            toolCall('command-1', 'workspace_run_command', 'approval-required'),
            toolCall('read-1', 'workspace_read_file'),
            toolCall('read-2', 'workspace_read_file'),
          ]}
          toolMessages={[
            {
              content: '原始工具输出',
              conversationId: 'conversation-1',
              createdAt: '2026-07-31T08:00:00.000Z',
              id: 'tool-message-1',
              role: 'tool',
              status: 'completed',
            },
          ]}
        />
      </TransportProvider>,
    );

    expect(screen.getByText(/共 3 次工具调用/).closest('details')).toHaveAttribute('open');
    expect(screen.getByText('工具返回 #1')).toBeInTheDocument();
    expect(
      Array.from(view.container.querySelectorAll('.tool-result-card__title strong')).map(
        (element) => element.textContent,
      ),
    ).toEqual(['#1 · 执行命令', '工具返回 #1', '#2 · 读取文件', '#3 · 读取文件']);
    fireEvent.click(screen.getByRole('button', { name: /允许执行/ }));
    await waitFor(() => {
      expect(decideToolCall).toHaveBeenCalledWith(
        expect.any(Object),
        'conversation-1',
        'command-1',
        'approve',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '接受更改' }));
    expect(onFileDecision).toHaveBeenCalledWith('change-1', 'accept');
  });
});
