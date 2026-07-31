import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileChange, ToolCall } from '../../types';

import { summarizeToolCalls, ToolCallGroup } from './ToolCallGroup';

function toolCall(
  id: string,
  name: string,
  status: ToolCall['status'] = 'completed',
  metadata?: Record<string, unknown>,
): ToolCall {
  return {
    arguments: '{}',
    id,
    metadata,
    name,
    status,
  };
}

function renderGroup(
  toolCalls: ToolCall[],
  fileChanges: FileChange[] = [],
  autoExpandRunningTools = true,
): ReturnType<typeof render> {
  return render(
    <ToolCallGroup
      autoExpandRunningTools={autoExpandRunningTools}
      fileChanges={fileChanges}
      toolCalls={toolCalls}
    >
      <span>完整工具明细</span>
    </ToolCallGroup>,
  );
}

describe('ToolCallGroup', () => {
  afterEach(cleanup);

  it('按固定顺序汇总连续工具调用', () => {
    const calls = [
      ...Array.from({ length: 3 }, (_, index) =>
        toolCall(`write-${index}`, 'workspace_propose_write'),
      ),
      toolCall('read-1', 'workspace_read_file'),
      ...Array.from({ length: 4 }, (_, index) =>
        toolCall(`command-${index}`, 'workspace_run_command'),
      ),
    ];

    expect(summarizeToolCalls(calls)).toBe('修改 3 次文件 · 读取 1 个文件 · 执行 4 次命令');
  });

  it('不会把 MCP 或未知工具提供的不可信名称带入摘要', () => {
    expect(
      summarizeToolCalls([
        toolCall('mcp-1', 'mcp_search', 'completed', {
          displayName: '伪造的系统工具',
          kind: 'mcp-request',
        }),
        toolCall('other-1', 'third_party_unknown', 'completed', {
          displayName: '删除全部文件',
        }),
      ]),
    ).toBe('调用 1 次 MCP · 调用 1 次其他工具');
  });

  it('完成态默认折叠，并在首次展开前延迟挂载明细', () => {
    const calls = Array.from({ length: 8 }, (_, index) =>
      toolCall(`command-${index}`, 'workspace_run_command'),
    );
    renderGroup(calls);

    const details = screen.getByText('执行 8 次命令').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.queryByText('完整工具明细')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('执行 8 次命令'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('完整工具明细')).toBeInTheDocument();

    const summary = screen.getByText('执行 8 次命令').closest('summary');
    fireEvent.keyDown(summary as HTMLElement, { key: 'Enter' });
    expect(details).not.toHaveAttribute('open');
    expect(screen.queryByText('完整工具明细')).not.toBeInTheDocument();

    fireEvent.keyDown(summary as HTMLElement, { key: ' ' });
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('完整工具明细')).toBeInTheDocument();
  });

  it('等待审批、失败和待处理文件变更会自动展开', () => {
    const approval = renderGroup([
      toolCall('approval-1', 'workspace_run_command', 'approval-required'),
      toolCall('read-1', 'workspace_read_file'),
      toolCall('read-2', 'workspace_read_file'),
    ]);
    expect(screen.getByText('等待确认').closest('details')).toHaveAttribute('open');
    approval.unmount();

    const failed = renderGroup([
      toolCall('failed-1', 'workspace_run_command', 'failed'),
      toolCall('read-1', 'workspace_read_file'),
      toolCall('read-2', 'workspace_read_file'),
    ]);
    expect(screen.getByText('1 项失败').closest('details')).toHaveAttribute('open');
    failed.unmount();

    renderGroup(
      [
        toolCall('write-1', 'workspace_propose_write'),
        toolCall('read-1', 'workspace_read_file'),
        toolCall('read-2', 'workspace_read_file'),
      ],
      [
        {
          diff: '@@ -1 +1 @@\n-old\n+new',
          id: 'change-1',
          path: 'src/index.ts',
          status: 'pending',
        },
      ],
    );
    expect(screen.getByText('等待确认').closest('details')).toHaveAttribute('open');
  });

  it('自动展开运行态，并在全部完成后自动折叠', async () => {
    const runningCalls = [
      toolCall('command-1', 'workspace_run_command', 'running'),
      toolCall('read-1', 'workspace_read_file'),
      toolCall('read-2', 'workspace_read_file'),
    ];
    const view = renderGroup(runningCalls);
    const details = screen.getByText('1 项进行中').closest('details');
    expect(details).toHaveAttribute('open');

    view.rerender(
      <ToolCallGroup
        autoExpandRunningTools
        fileChanges={[]}
        toolCalls={runningCalls.map((call) => ({ ...call, status: 'completed' as const }))}
      >
        <span>完整工具明细</span>
      </ToolCallGroup>,
    );

    await waitFor(() => expect(details).not.toHaveAttribute('open'));
  });

  it('关闭运行态自动展开时保持折叠，超时则仍会展开', () => {
    const running = renderGroup(
      [
        toolCall('command-1', 'workspace_run_command', 'running'),
        toolCall('read-1', 'workspace_read_file'),
        toolCall('read-2', 'workspace_read_file'),
      ],
      [],
      false,
    );
    expect(screen.getByText('1 项进行中').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByText('完整工具明细')).not.toBeInTheDocument();
    running.unmount();

    renderGroup([
      toolCall('command-1', 'workspace_run_command', 'timed-out'),
      toolCall('read-1', 'workspace_read_file'),
      toolCall('read-2', 'workspace_read_file'),
    ]);
    expect(screen.getByText('1 项失败').closest('details')).toHaveAttribute('open');
  });

  it('手动折叠运行组后，普通状态更新不会再次展开', async () => {
    const view = renderGroup([
      toolCall('command-1', 'workspace_run_command', 'running'),
      toolCall('read-1', 'workspace_read_file'),
      toolCall('read-2', 'workspace_read_file'),
    ]);
    const details = screen.getByText('1 项进行中').closest('details');
    fireEvent.click(screen.getByText('读取 2 个文件 · 执行 1 次命令'));
    expect(details).not.toHaveAttribute('open');

    view.rerender(
      <ToolCallGroup
        autoExpandRunningTools
        fileChanges={[]}
        toolCalls={[
          toolCall('command-1', 'workspace_run_command'),
          toolCall('read-1', 'workspace_read_file', 'running'),
          toolCall('read-2', 'workspace_read_file'),
        ]}
      >
        <span>完整工具明细</span>
      </ToolCallGroup>,
    );

    await waitFor(() => expect(details).not.toHaveAttribute('open'));
  });

  it('同数量的新审批项到达时会重新展开', async () => {
    const initialCalls = [
      toolCall('approval-1', 'workspace_run_command', 'approval-required'),
      toolCall('read-1', 'workspace_read_file', 'running'),
      toolCall('read-2', 'workspace_read_file'),
    ];
    const view = renderGroup(initialCalls);
    const details = screen.getByText(/共 3 次工具调用/).closest('details');

    fireEvent.click(screen.getByText('读取 2 个文件 · 执行 1 次命令'));
    expect(details).not.toHaveAttribute('open');

    view.rerender(
      <ToolCallGroup
        autoExpandRunningTools
        fileChanges={[]}
        toolCalls={[
          toolCall('approval-1', 'workspace_run_command', 'approval-required'),
          toolCall('read-1', 'workspace_read_file'),
          toolCall('read-2', 'workspace_read_file'),
        ]}
      >
        <span>完整工具明细</span>
      </ToolCallGroup>,
    );
    await waitFor(() => expect(details).not.toHaveAttribute('open'));

    view.rerender(
      <ToolCallGroup
        autoExpandRunningTools
        fileChanges={[]}
        toolCalls={[
          toolCall('approval-2', 'workspace_run_command', 'approval-required'),
          toolCall('read-1', 'workspace_read_file'),
          toolCall('read-2', 'workspace_read_file'),
        ]}
      >
        <span>完整工具明细</span>
      </ToolCallGroup>,
    );

    await waitFor(() => expect(details).toHaveAttribute('open'));
  });
});
