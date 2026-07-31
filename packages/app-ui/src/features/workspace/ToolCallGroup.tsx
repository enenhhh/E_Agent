import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleOff,
  LoaderCircle,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { FileChange, ToolCall } from '../../types';

type ToolCategory =
  | 'write'
  | 'read'
  | 'search'
  | 'command'
  | 'browser'
  | 'computer'
  | 'mcp'
  | 'other';

interface ToolGroupState {
  activeCount: number;
  attentionCount: number;
  failedCount: number;
  status: 'active' | 'attention' | 'completed' | 'failed' | 'stopped';
  stoppedCount: number;
}

const categoryOrder: ToolCategory[] = [
  'write',
  'read',
  'search',
  'command',
  'browser',
  'computer',
  'mcp',
  'other',
];

const categoryCopy: Record<ToolCategory, (count: number) => string> = {
  write: (count) => `修改 ${count} 次文件`,
  read: (count) => `读取 ${count} 个文件`,
  search: (count) => `检索项目 ${count} 次`,
  command: (count) => `执行 ${count} 次命令`,
  browser: (count) => `使用 ${count} 次浏览器`,
  computer: (count) => `操作 ${count} 次电脑`,
  mcp: (count) => `调用 ${count} 次 MCP`,
  other: (count) => `调用 ${count} 次其他工具`,
};

function metadataKind(toolCall: ToolCall): string {
  return typeof toolCall.metadata?.kind === 'string' ? toolCall.metadata.kind : '';
}

export function classifyToolCall(toolCall: ToolCall): ToolCategory {
  const kind = metadataKind(toolCall);

  if (toolCall.name === 'workspace_propose_write' || kind === 'file-change') return 'write';
  if (toolCall.name === 'workspace_read_file' || kind === 'read-file') return 'read';
  if (
    toolCall.name === 'workspace_list_files' ||
    toolCall.name === 'workspace_find_files' ||
    toolCall.name === 'workspace_search_text' ||
    kind === 'file-list' ||
    kind === 'search-results'
  ) {
    return 'search';
  }
  if (toolCall.name === 'workspace_run_command' || kind === 'command') return 'command';
  if (toolCall.name.startsWith('browser_') || kind.startsWith('browser-')) return 'browser';
  if (toolCall.name.startsWith('computer_') || kind.startsWith('computer-')) return 'computer';
  if (toolCall.name.startsWith('mcp_') || kind.startsWith('mcp-')) return 'mcp';
  return 'other';
}

export function summarizeToolCalls(toolCalls: ToolCall[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const toolCall of toolCalls) {
    const category = classifyToolCall(toolCall);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const summary = categoryOrder.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [categoryCopy[category](count)] : [];
  });
  return summary.join(' · ');
}

function resolveGroupState(toolCalls: ToolCall[], fileChanges: FileChange[]): ToolGroupState {
  const activeCount = toolCalls.filter(
    (toolCall) => toolCall.status === 'pending' || toolCall.status === 'running',
  ).length;
  const toolAttentionCount = toolCalls.filter(
    (toolCall) => toolCall.status === 'approval-required',
  ).length;
  const pendingFileChangeCount = fileChanges.filter((change) => change.status === 'pending').length;
  const failedCount = toolCalls.filter(
    (toolCall) => toolCall.status === 'failed' || toolCall.status === 'timed-out',
  ).length;
  const stoppedCount = toolCalls.filter(
    (toolCall) => toolCall.status === 'cancelled' || toolCall.status === 'rejected',
  ).length;
  const attentionCount = Math.max(toolAttentionCount, pendingFileChangeCount);

  return {
    activeCount,
    attentionCount,
    failedCount,
    stoppedCount,
    status:
      attentionCount > 0
        ? 'attention'
        : failedCount > 0
          ? 'failed'
          : activeCount > 0
            ? 'active'
            : stoppedCount > 0
              ? 'stopped'
              : 'completed',
  };
}

function GroupStatus({ state }: { state: ToolGroupState }): React.JSX.Element {
  if (state.status === 'attention') {
    return (
      <>
        <ShieldAlert aria-hidden size={13} />
        等待确认
      </>
    );
  }
  if (state.status === 'failed') {
    return (
      <>
        <CircleAlert aria-hidden size={13} />
        {state.failedCount} 项失败
      </>
    );
  }
  if (state.status === 'active') {
    return (
      <>
        <LoaderCircle aria-hidden size={13} />
        {state.activeCount} 项进行中
      </>
    );
  }
  if (state.status === 'stopped') {
    return (
      <>
        <CircleOff aria-hidden size={13} />
        {state.stoppedCount} 项已停止
      </>
    );
  }
  return (
    <>
      <CheckCircle2 aria-hidden size={13} />
      已完成
    </>
  );
}

export function ToolCallGroup({
  autoExpandRunningTools,
  children,
  fileChanges,
  toolCalls,
}: {
  autoExpandRunningTools: boolean;
  children: ReactNode;
  fileChanges: FileChange[];
  toolCalls: ToolCall[];
}): React.JSX.Element {
  const state = useMemo(() => resolveGroupState(toolCalls, fileChanges), [fileChanges, toolCalls]);
  const shouldAutoExpand =
    state.status === 'attention' ||
    state.status === 'failed' ||
    (state.status === 'active' && autoExpandRunningTools);
  const [open, setOpen] = useState(shouldAutoExpand);
  const manuallyToggled = useRef(false);
  const summary = useMemo(() => summarizeToolCalls(toolCalls), [toolCalls]);
  const summaryText = summary || `${toolCalls.length} 次工具调用`;
  const urgentIdentities = useMemo(
    () => [
      ...toolCalls.flatMap((toolCall) =>
        toolCall.status === 'approval-required' ||
        toolCall.status === 'failed' ||
        toolCall.status === 'timed-out'
          ? [`tool:${toolCall.id}:${toolCall.status}`]
          : [],
      ),
      ...fileChanges.flatMap((change) =>
        change.status === 'pending' ? [`file:${change.id}:pending`] : [],
      ),
    ],
    [fileChanges, toolCalls],
  );
  const previousUrgentIdentities = useRef(new Set(urgentIdentities));

  useEffect(() => {
    const currentUrgentIdentities = new Set(urgentIdentities);
    const hasNewUrgentIdentity = urgentIdentities.some(
      (identity) => !previousUrgentIdentities.current.has(identity),
    );
    previousUrgentIdentities.current = currentUrgentIdentities;

    if (hasNewUrgentIdentity) {
      manuallyToggled.current = false;
      setOpen(true);
      return;
    }
    if (currentUrgentIdentities.size > 0) return;
    if (!manuallyToggled.current) {
      const nextOpen = state.status === 'active' && autoExpandRunningTools;
      setOpen(nextOpen);
    }
  }, [autoExpandRunningTools, state.status, urgentIdentities]);

  const toggle = (): void => {
    const nextOpen = !open;
    manuallyToggled.current = true;
    setOpen(nextOpen);
  };

  return (
    <details
      className={`tool-call-group tool-call-group--${state.status}`}
      data-tool-count={toolCalls.length}
      open={open}
    >
      <summary
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        }}
      >
        <span className="tool-call-group__icon" aria-hidden>
          <Wrench size={15} />
        </span>
        <span className="tool-call-group__title">
          <strong title={summaryText}>{summaryText}</strong>
          <small>
            共 {toolCalls.length} 次工具调用，{open ? '工具明细已展开' : '展开查看每一步'}
          </small>
        </span>
        <span
          aria-atomic="true"
          aria-live="polite"
          className={`tool-call-group__status tool-call-group__status--${state.status}`}
          role="status"
        >
          <GroupStatus state={state} />
        </span>
        <ChevronDown aria-hidden className="tool-call-group__chevron" size={15} />
      </summary>
      {open ? <div className="tool-call-group__body">{children}</div> : null}
    </details>
  );
}
