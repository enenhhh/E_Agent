import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '../../types';

import { ToolResultCard } from './ToolResultCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function toolCall(input: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    name: 'workspace_run_command',
    arguments: '{"executable":"pnpm","args":["test"]}',
    status: 'approval-required',
    ...input,
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('ToolResultCard', () => {
  it('展示所有工具状态和工具图标，包括未知扩展工具', () => {
    const statuses: ToolCall['status'][] = [
      'pending',
      'running',
      'completed',
      'failed',
      'approval-required',
      'cancelled',
      'rejected',
      'timed-out',
    ];
    const { container, rerender } = render(
      <ToolResultCard toolCall={toolCall({ status: statuses[0], result: 'ok' })} />,
    );

    for (const status of statuses) {
      rerender(<ToolResultCard toolCall={toolCall({ status, result: 'ok' })} />);
      expect(container.querySelector(`.tool-result-card__status--${status}`)).not.toBeNull();
    }

    const toolNames = [
      'workspace_read_file',
      'workspace_list_files',
      'workspace_find_files',
      'workspace_search_text',
      'workspace_propose_write',
      'workspace_run_command',
      'computer_system_info',
      'computer_list_processes',
      'browser_open',
      'browser_navigate',
      'browser_extract',
      'browser_screenshot',
      'mcp_project_search',
      'third_party_tool',
    ];
    for (const name of toolNames) {
      rerender(
        <ToolResultCard
          toolCall={toolCall({
            name,
            status: 'completed',
            arguments: '',
            result: 'ok',
          })}
        />,
      );
      expect(container.querySelector('.tool-result-card__tool-icon svg')).not.toBeNull();
    }
    expect(screen.getByText('third_party_tool')).toBeInTheDocument();
    expect(screen.getByText('工具调用')).toBeInTheDocument();
  });

  it('用 MCP 元数据展示服务和原始工具名称', () => {
    render(
      <ToolResultCard
        toolCall={toolCall({
          name: 'mcp_project_search',
          status: 'completed',
          result: '{"matches":[]}',
          metadata: {
            kind: 'mcp-result',
            originalToolName: 'search',
            serverName: '项目知识库',
          },
        })}
      />,
    );

    expect(screen.getByText('MCP · search')).toBeInTheDocument();
    expect(screen.getByText('Server · 项目知识库')).toBeInTheDocument();
  });

  it('把浏览器截图作为受限 data URL 预览，而不是展示 Base64 正文', () => {
    render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          name: 'browser_screenshot',
          status: 'completed',
          result: JSON.stringify({
            kind: 'browser-screenshot',
            mimeType: 'image/jpeg',
            width: 800,
            height: 600,
            bytes: 5,
            base64: 'aGVsbG8=',
          }),
        })}
      />,
    );

    expect(screen.getByRole('img', { name: '浏览器截图结果' })).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,aGVsbG8=',
    );
    expect(screen.getByText(/800 × 600/)).toBeInTheDocument();
    expect(screen.queryByText(/aGVsbG8=/)).not.toBeInTheDocument();
  });

  it('直接显示网页提取和 MCP 文本内容', () => {
    const { rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          name: 'browser_extract',
          status: 'completed',
          result: JSON.stringify({
            kind: 'browser-extract',
            content: '可见网页正文',
          }),
        })}
      />,
    );
    expect(screen.getByText('可见网页正文')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          name: 'mcp_project_search',
          status: 'completed',
          result: JSON.stringify({
            kind: 'mcp-result',
            content: [{ type: 'text', text: '知识库命中结果' }],
          }),
        })}
      />,
    );
    expect(screen.getByText('知识库命中结果')).toBeInTheDocument();
  });

  it('按优先级展示摘要、路径、工具说明和耗时', () => {
    const { rerender } = render(
      <ToolResultCard
        toolCall={toolCall({
          status: 'completed',
          summary: '来自服务端的摘要',
          durationMs: 1_250,
          result: 'ok',
        })}
      />,
    );
    expect(screen.getByText('来自服务端的摘要')).toBeInTheDocument();
    expect(screen.getByText('1.25 s')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        toolCall={toolCall({
          name: 'workspace_read_file',
          status: 'completed',
          summary: undefined,
          durationMs: undefined,
          result: 'ok',
          metadata: { kind: 'read-file', path: 'src/index.ts', durationMs: 25 },
        })}
      />,
    );
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    expect(screen.getByText('25 ms')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        toolCall={toolCall({
          name: 'workspace_read_file',
          status: 'completed',
          arguments: '',
          result: 'ok',
        })}
      />,
    );
    expect(screen.getByText('工作区只读工具')).toBeInTheDocument();
  });

  it('格式化 JSON 参数和 JSON 结果，并在非法 JSON 时保留原文', () => {
    const { container, rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          arguments: '{"path":"src/index.ts","line":2}',
          result: '{"ok":true,"count":2}',
          metadata: { format: 'json' },
        })}
      />,
    );

    expect(container.textContent).toContain('"path": "src/index.ts"');
    expect(container.textContent).toContain('"ok": true');

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          arguments: '{invalid',
          result: '{also-invalid',
          metadata: { format: 'json' },
        })}
      />,
    );
    expect(container.textContent).toContain('{invalid');
    expect(container.textContent).toContain('{also-invalid');
  });

  it('自动识别 JSON，并分别渲染 Markdown、Diff 和纯文本', () => {
    const { container, rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: '{"nested":{"value":1}}',
          metadata: {},
        })}
      />,
    );
    expect(container.textContent).toContain('"nested": {');

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: '## 完成\n\n- 第一项',
          metadata: { format: 'markdown' },
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: '完成' })).toBeInTheDocument();
    expect(screen.getByText('第一项')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: '@@ -1 +1 @@\n-old\n+new',
          metadata: { format: 'diff' },
        })}
      />,
    );
    expect(container.querySelector('.tool-result-card__diff')).not.toBeNull();
    expect(container.querySelector('.tool-result-card__diff svg')).not.toBeNull();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: 'plain output',
          metadata: {},
        })}
      />,
    );
    expect(screen.getByText('plain output')).toBeInTheDocument();
  });

  it.each([
    {
      name: '读取文件',
      call: toolCall({
        name: 'workspace_read_file',
        status: 'completed',
        result: undefined,
        metadata: { kind: 'read-file', content: 'const answer = 42;' },
      }),
      expected: 'const answer = 42;',
    },
    {
      name: '文件列表',
      call: toolCall({
        name: 'workspace_list_files',
        status: 'completed',
        result: undefined,
        metadata: {
          kind: 'file-list',
          entries: [
            { type: 'directory', path: 'src' },
            { type: 'file', name: 'README.md' },
            'literal-entry',
            null,
          ],
        },
      }),
      expected: 'README.md',
    },
    {
      name: '搜索结果',
      call: toolCall({
        name: 'workspace_search_text',
        status: 'completed',
        result: undefined,
        metadata: {
          kind: 'search-results',
          matches: [{ path: 'src/a.ts', line: 3, column: 8, preview: 'needle' }, 'raw-match'],
        },
      }),
      expected: 'src/a.ts:3:8',
    },
    {
      name: '通用输出',
      call: toolCall({
        name: 'extension_tool',
        status: 'completed',
        result: undefined,
        metadata: { output: 'extension output' },
      }),
      expected: 'extension output',
    },
  ])('从元数据恢复$name结果', ({ call, expected }) => {
    render(<ToolResultCard defaultExpanded toolCall={call} />);
    expect(
      screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeInTheDocument();
  });

  it('合并命令标准输出和错误输出，并展示退出码与信号', () => {
    const { rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: undefined,
          metadata: {
            kind: 'command',
            stdout: 'build ok',
            stderr: 'one warning',
            exitCode: 0,
            signal: 'SIGTERM',
          },
        })}
      />,
    );
    expect(screen.getByText(/build ok/)).toHaveTextContent('[stderr]');
    expect(screen.getByText('退出码 0')).toBeInTheDocument();
    expect(screen.getByText('信号 SIGTERM')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'failed',
          result: undefined,
          metadata: { kind: 'command', stderr: 'stderr only' },
        })}
      />,
    );
    expect(screen.getByText('stderr only')).toBeInTheDocument();
  });

  it('按规范化 metadata 展示文件 Diff，并用路径兜底文件变更结果', () => {
    const { rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          name: 'workspace_propose_write',
          status: 'completed',
          result: undefined,
          metadata: {
            kind: 'file-change',
            path: 'src/index.ts',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        })}
      />,
    );
    expect(screen.getByText(/@@ -1 \+1 @@/)).toBeInTheDocument();
    expect(screen.getByText('执行完成')).toBeInTheDocument();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          name: 'workspace_propose_write',
          status: 'completed',
          result: undefined,
          metadata: { kind: 'file-change', path: 'src/new.ts' },
        })}
      />,
    );
    expect(screen.getAllByText(/src\/new\.ts/)).toHaveLength(2);
  });

  it('完成但没有可展示结果时显示空状态，包括无效元数据', () => {
    const { rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: undefined,
          metadata: { kind: 'read-file', content: 123 },
        })}
      />,
    );
    expect(screen.getByText(/没有返回可显示的内容/)).toBeInTheDocument();

    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: undefined,
          metadata: { kind: 'file-list', entries: 'not-an-array' },
        })}
      />,
    );
    expect(screen.getByText(/没有返回可显示的内容/)).toBeInTheDocument();
  });

  it('审批成功期间锁定两个操作，并支持拒绝决策', async () => {
    let finishApproval: (() => void) | undefined;
    const onDecision = vi
      .fn<(decision: 'approve' | 'reject') => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishApproval = resolve;
          }),
      )
      .mockResolvedValueOnce();
    render(<ToolResultCard onDecision={onDecision} toolCall={toolCall()} />);

    expect(screen.getByText(/这不是 OS 沙箱/)).toHaveTextContent(
      '进程拥有当前系统用户权限，可能访问网络或工作区外资源',
    );
    const approveButton = screen.getByRole('button', { name: /允许执行/ });
    const rejectButton = screen.getByRole('button', { name: /拒绝/ });
    fireEvent.click(approveButton);

    expect(onDecision).toHaveBeenCalledWith('approve');
    expect(approveButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();

    await act(async () => {
      finishApproval?.();
    });
    await waitFor(() => expect(approveButton).toBeEnabled());

    fireEvent.click(rejectButton);
    await waitFor(() => {
      expect(onDecision).toHaveBeenLastCalledWith('reject');
      expect(onDecision).toHaveBeenCalledTimes(2);
    });
  });

  it('审批失败时展示 Error 信息和非 Error 的友好兜底', async () => {
    const onDecision = vi
      .fn<(decision: 'approve' | 'reject') => Promise<void>>()
      .mockRejectedValueOnce(new Error('操作被策略阻止'))
      .mockRejectedValueOnce('unknown failure');
    render(<ToolResultCard onDecision={onDecision} toolCall={toolCall()} />);

    fireEvent.click(screen.getByRole('button', { name: /允许执行/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作被策略阻止');

    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('工具操作失败，请重试。');
    });
  });

  it('没有决策回调时禁用审批按钮', () => {
    render(<ToolResultCard toolCall={toolCall()} />);
    expect(screen.getByRole('button', { name: /允许执行/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeDisabled();
  });

  it('执行环境不可用时展示原因并隐藏无效审批动作', () => {
    render(
      <ToolResultCard
        executionUnavailableReason="本地命令仅可在桌面端执行。"
        toolCall={toolCall()}
      />,
    );

    expect(screen.getByText('本地命令仅可在桌面端执行。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /允许执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝/ })).not.toBeInTheDocument();
  });

  it('文件修改只引导用户在下方 Diff 审阅，不显示命令审批按钮或待审 Diff', () => {
    const onDecision = vi.fn();
    render(
      <ToolResultCard
        onDecision={onDecision}
        toolCall={toolCall({
          name: 'workspace_propose_write',
          status: 'approval-required',
          metadata: {
            kind: 'file-change',
            path: 'src/index.ts',
            diff: '@@ -1 +1 @@\n-old\n+new',
          },
        })}
      />,
    );

    expect(screen.getByText('请在下方 Diff 审阅')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /允许执行/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/@@ -1 \+1 @@/)).not.toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('复制原始工具结果并在写入失败时保持复制图标', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const { rerender } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: '{"raw":true}',
          metadata: { format: 'json' },
        })}
      />,
    );

    const copyButton = screen.getByRole('button', { name: '复制工具输出' });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{"raw":true}');
      expect(copyButton.querySelector('.lucide-check')).not.toBeNull();
    });

    const failingWrite = vi.fn().mockRejectedValue(new Error('clipboard unavailable'));
    installClipboard(failingWrite);
    rerender(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({ status: 'completed', result: 'second output' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制工具输出' }));
    await waitFor(() => expect(failingWrite).toHaveBeenCalledWith('second output'));
  });

  it('对界面预览和服务端输出分别显示截断信息，复制仍使用完整原始内容', async () => {
    const originalResult = 'x'.repeat(200_001);
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const { container } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'completed',
          result: originalResult,
          truncated: true,
          metadata: { originalBytes: 345_678 },
        })}
      />,
    );

    expect(container.textContent).toContain('界面预览已截断');
    expect(container.textContent).toContain('输出已按安全上限截断');
    expect(container.textContent).toMatch(/345.?678/);

    fireEvent.click(screen.getByRole('button', { name: '复制工具输出' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(originalResult));
  });

  it('失败状态会自动展开，用户仍可通过 summary 折叠和展开', async () => {
    const { container, rerender } = render(
      <ToolResultCard toolCall={toolCall({ status: 'pending', result: 'pending result' })} />,
    );
    const details = container.querySelector('details');
    const summary = container.querySelector('summary');
    expect(details).not.toHaveAttribute('open');

    fireEvent.click(summary!);
    expect(details).toHaveAttribute('open');
    fireEvent.click(summary!);
    expect(details).not.toHaveAttribute('open');

    rerender(<ToolResultCard toolCall={toolCall({ status: 'failed', result: 'failed result' })} />);
    await waitFor(() => expect(details).toHaveAttribute('open'));
  });

  it('安全地按纯文本展示疑似 HTML 的命令输出', () => {
    const { container } = render(
      <ToolResultCard
        defaultExpanded
        toolCall={toolCall({
          status: 'timed-out',
          result: '<img src=x onerror=alert(1)>',
          durationMs: 60_000,
          metadata: { kind: 'command', exitCode: 124 },
        })}
      />,
    );

    expect(screen.getByText('已超时')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('退出码 124')).toBeInTheDocument();
  });
});
