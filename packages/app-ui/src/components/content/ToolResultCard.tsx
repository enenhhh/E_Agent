import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleOff,
  Clock3,
  Copy,
  FileDiff,
  FilePenLine,
  FileText,
  FolderTree,
  Globe2,
  LoaderCircle,
  MonitorCog,
  PlugZap,
  Search,
  ShieldAlert,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { formatDuration } from '../../lib/format';
import type { ToolCall } from '../../types';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

import { MarkdownMessage } from './MarkdownMessage';

type ToolDecision = 'approve' | 'reject';

const MAX_RENDERED_RESULT_CHARACTERS = 200_000;

const toolCopy: Record<string, { label: string; detail: string }> = {
  workspace_read_file: { label: '读取文件', detail: '工作区只读工具' },
  workspace_list_files: { label: '列出文件', detail: '工作区只读工具' },
  workspace_find_files: { label: '查找文件', detail: '按名称匹配工作区文件' },
  workspace_search_text: { label: '搜索文本', detail: '工作区只读工具' },
  workspace_propose_write: { label: '修改文件', detail: '等待审阅的文件变更' },
  workspace_run_command: { label: '执行命令', detail: '受控的本机命令' },
  computer_system_info: { label: '系统信息', detail: '最小化的本机运行环境信息' },
  computer_list_processes: { label: '查看进程', detail: '敏感的本机只读操作' },
  browser_open: { label: '打开浏览器', detail: '需审批；公网 DNS 预检并非严格网络隔离' },
  browser_navigate: { label: '访问网页', detail: '需审批；best-effort public-only 导航' },
  browser_extract: { label: '提取网页', detail: '需审批；读取当前隔离页面的可见文本' },
  browser_screenshot: { label: '网页截图', detail: '需审批；截取当前隔离浏览页面' },
};

const statusCopy: Record<ToolCall['status'], string> = {
  pending: '等待执行',
  running: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  'approval-required': '等待确认',
  cancelled: '已拒绝',
  rejected: '已拒绝',
  'timed-out': '已超时',
};

function readMetadata(toolCall: ToolCall): Record<string, unknown> {
  return toolCall.metadata ?? {};
}

function ToolIcon({ name }: { name: string }): React.JSX.Element {
  if (name === 'workspace_read_file') return <FileText aria-hidden size={15} />;
  if (name === 'workspace_list_files') return <FolderTree aria-hidden size={15} />;
  if (name === 'workspace_search_text' || name === 'workspace_find_files')
    return <Search aria-hidden size={15} />;
  if (name === 'workspace_propose_write') return <FilePenLine aria-hidden size={15} />;
  if (name.startsWith('browser_')) return <Globe2 aria-hidden size={15} />;
  if (name.startsWith('computer_')) return <MonitorCog aria-hidden size={15} />;
  if (name.startsWith('mcp_')) return <PlugZap aria-hidden size={15} />;
  return <TerminalSquare aria-hidden size={15} />;
}

function toolLabel(toolCall: ToolCall): string {
  const metadata = readMetadata(toolCall);
  if (toolCall.name.startsWith('mcp_')) {
    return typeof metadata.originalToolName === 'string'
      ? `MCP · ${safeIdentityText(metadata.originalToolName)}`
      : `MCP · ${safeIdentityText(toolCall.name)}`;
  }
  if (typeof metadata.displayName === 'string' && metadata.displayName.trim()) {
    return metadata.displayName;
  }
  return toolCopy[toolCall.name]?.label ?? toolCall.name;
}

function safeIdentityText(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code >= 32 &&
        code !== 127 &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069) &&
        code !== 0x200e &&
        code !== 0x200f
      );
    })
    .join('')
    .slice(0, 256);
}

function prettyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return null;
  }
}

function getResultFormat(toolCall: ToolCall): 'json' | 'markdown' | 'diff' | 'text' {
  const metadata = readMetadata(toolCall);
  const format = metadata.format;
  if (format === 'json' || format === 'markdown' || format === 'diff') return format;
  if (metadata.kind === 'file-change') return 'diff';
  return prettyJson(resolveResult(toolCall) ?? '') === null ? 'text' : 'json';
}

function resolveResult(toolCall: ToolCall): string | null {
  if (toolCall.result) {
    const parsed = resultObject(toolCall.result);
    if (parsed?.kind === 'browser-extract' && typeof parsed.content === 'string') {
      return parsed.content;
    }
    if (parsed?.kind === 'browser-page') {
      const title = typeof parsed.title === 'string' ? parsed.title : '浏览器页面';
      return typeof parsed.url === 'string' ? `${title}\n${parsed.url}` : title;
    }
    if (parsed?.kind === 'browser-screenshot') {
      const dimensions =
        typeof parsed.width === 'number' && typeof parsed.height === 'number'
          ? `${parsed.width} × ${parsed.height}`
          : '未知尺寸';
      return `${String(parsed.mimeType ?? 'image/jpeg')} · ${dimensions}${
        typeof parsed.bytes === 'number' ? ` · ${parsed.bytes.toLocaleString()} 字节` : ''
      }`;
    }
    if (parsed?.kind === 'mcp-result' && Array.isArray(parsed.content)) {
      const text = parsed.content
        .flatMap((item) => {
          if (item === null || typeof item !== 'object') return [];
          const value = item as Record<string, unknown>;
          return value.type === 'text' && typeof value.text === 'string' ? [value.text] : [];
        })
        .join('\n');
      if (text) return text;
      if (parsed.structuredContent !== undefined) {
        return JSON.stringify(parsed.structuredContent);
      }
    }
    return toolCall.result;
  }
  const metadata = readMetadata(toolCall);
  if (metadata.kind === 'read-file') {
    return typeof metadata.content === 'string' ? metadata.content : null;
  }
  if (metadata.kind === 'file-list' && Array.isArray(metadata.entries)) {
    return metadata.entries
      .map((entry) => {
        if (entry === null || typeof entry !== 'object') return String(entry);
        const value = entry as Record<string, unknown>;
        const prefix = value.type === 'directory' ? '📁' : '📄';
        return `${prefix} ${typeof value.path === 'string' ? value.path : String(value.name ?? '')}`;
      })
      .join('\n');
  }
  if (metadata.kind === 'search-results' && Array.isArray(metadata.matches)) {
    return metadata.matches
      .map((match) => {
        if (match === null || typeof match !== 'object') return String(match);
        const value = match as Record<string, unknown>;
        return `${String(value.path ?? '')}:${String(value.line ?? '')}:${String(value.column ?? '')}  ${String(value.preview ?? '')}`;
      })
      .join('\n');
  }
  if (metadata.kind === 'command') {
    const stdout = typeof metadata.stdout === 'string' ? metadata.stdout : '';
    const stderr = typeof metadata.stderr === 'string' ? metadata.stderr : '';
    if (stdout && stderr) return `${stdout}\n\n[stderr]\n${stderr}`;
    return stdout || stderr || null;
  }
  if (metadata.kind === 'file-change') {
    if (typeof metadata.diff === 'string') return metadata.diff;
    if (typeof metadata.path === 'string') return `文件变更：${metadata.path}`;
  }
  return typeof metadata.output === 'string' ? metadata.output : null;
}

function resultObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function screenshotDataUrl(toolCall: ToolCall): string | null {
  if (!toolCall.result) return null;
  const parsed = resultObject(toolCall.result);
  if (
    parsed?.kind !== 'browser-screenshot' ||
    (parsed.mimeType !== 'image/jpeg' && parsed.mimeType !== 'image/png') ||
    typeof parsed.base64 !== 'string' ||
    parsed.base64.length > 1_500_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(parsed.base64)
  ) {
    return null;
  }
  return `data:${parsed.mimeType};base64,${parsed.base64}`;
}

function StatusIcon({ status }: { status: ToolCall['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 aria-hidden size={14} />;
    case 'failed':
      return <CircleAlert aria-hidden size={14} />;
    case 'approval-required':
      return <ShieldAlert aria-hidden size={14} />;
    case 'cancelled':
    case 'rejected':
      return <CircleOff aria-hidden size={14} />;
    case 'timed-out':
      return <Clock3 aria-hidden size={14} />;
    case 'pending':
    case 'running':
      return <LoaderCircle aria-hidden size={14} />;
  }
}

function ResultContent({
  format,
  result,
}: {
  format: ReturnType<typeof getResultFormat>;
  result: string;
}): React.JSX.Element {
  if (format === 'markdown') {
    return (
      <div className="tool-result-card__markdown">
        <MarkdownMessage content={result} />
      </div>
    );
  }

  const display = format === 'json' ? (prettyJson(result) ?? result) : result;
  return (
    <pre className={format === 'diff' ? 'tool-result-card__diff' : undefined}>
      {format === 'diff' ? <FileDiff aria-hidden size={14} /> : null}
      <code>{display}</code>
    </pre>
  );
}

export function ToolResultCard({
  defaultExpanded = false,
  executionUnavailableReason,
  onDecision,
  sequenceNumber,
  toolCall,
}: {
  defaultExpanded?: boolean;
  executionUnavailableReason?: string;
  onDecision?: (decision: ToolDecision) => Promise<void> | void;
  sequenceNumber?: number;
  toolCall: ToolCall;
}): React.JSX.Element {
  const shouldAutoExpand =
    defaultExpanded ||
    toolCall.status === 'approval-required' ||
    toolCall.status === 'failed' ||
    toolCall.status === 'timed-out';
  const [open, setOpen] = useState(shouldAutoExpand);
  const [decision, setDecision] = useState<ToolDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const metadata = readMetadata(toolCall);
  const isFileChange =
    metadata.kind === 'file-change' || toolCall.name === 'workspace_propose_write';
  const isCommand = metadata.kind === 'command' || toolCall.name === 'workspace_run_command';
  const isMcp = toolCall.name.startsWith('mcp_');
  const detail =
    (isMcp && typeof metadata.serverName === 'string'
      ? `Server · ${safeIdentityText(metadata.serverName)}${
          typeof metadata.serverId === 'string' ? ` (${safeIdentityText(metadata.serverId)})` : ''
        }`
      : undefined) ??
    toolCall.summary ??
    (typeof metadata.path === 'string' ? metadata.path : undefined) ??
    (typeof metadata.url === 'string' ? metadata.url : undefined) ??
    (typeof metadata.serverName === 'string' ? `MCP · ${metadata.serverName}` : undefined) ??
    toolCopy[toolCall.name]?.detail ??
    '工具调用';
  const resultFormat = getResultFormat(toolCall);
  const durationMs =
    typeof toolCall.durationMs === 'number'
      ? toolCall.durationMs
      : typeof metadata.durationMs === 'number'
        ? metadata.durationMs
        : null;
  const duration = durationMs === null ? null : formatDuration(durationMs);
  const result = useMemo(() => {
    const resolvedResult = resolveResult(toolCall);
    if (!resolvedResult) return null;
    if (resolvedResult.length <= MAX_RENDERED_RESULT_CHARACTERS) return resolvedResult;
    return `${resolvedResult.slice(0, MAX_RENDERED_RESULT_CHARACTERS)}\n\n…界面预览已截断`;
  }, [toolCall]);
  const screenshot = useMemo(() => screenshotDataUrl(toolCall), [toolCall]);
  const serverTruncated = toolCall.truncated === true || metadata.truncated === true;
  const visibleResult = isFileChange && toolCall.status === 'approval-required' ? null : result;

  useEffect(() => {
    if (
      toolCall.status === 'approval-required' ||
      toolCall.status === 'failed' ||
      toolCall.status === 'timed-out'
    ) {
      setOpen(true);
    }
  }, [toolCall.status]);

  const decide = async (nextDecision: ToolDecision): Promise<void> => {
    if (!onDecision) return;
    setDecision(nextDecision);
    setDecisionError(null);
    try {
      await onDecision(nextDecision);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : '工具操作失败，请重试。');
    } finally {
      setDecision(null);
    }
  };

  const copyResult = async (): Promise<void> => {
    const resolvedResult = resolveResult(toolCall);
    if (!resolvedResult) return;
    try {
      await navigator.clipboard.writeText(resolvedResult);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details
      className={`tool-result-card tool-result-card--${toolCall.status}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span className="tool-result-card__tool-icon" aria-hidden>
          <ToolIcon name={toolCall.name} />
        </span>
        <span className="tool-result-card__title">
          <strong>
            {sequenceNumber ? `#${sequenceNumber} · ` : ''}
            {toolLabel(toolCall)}
          </strong>
          <small>{detail}</small>
        </span>
        {duration ? (
          <span className="tool-result-card__duration">
            <Clock3 aria-hidden size={12} />
            {duration}
          </span>
        ) : null}
        <span className={`tool-result-card__status tool-result-card__status--${toolCall.status}`}>
          <StatusIcon status={toolCall.status} />
          {statusCopy[toolCall.status]}
        </span>
        <ChevronDown aria-hidden className="tool-result-card__chevron" size={15} />
      </summary>

      <div className="tool-result-card__body">
        {toolCall.arguments ? (
          <section className="tool-result-card__section">
            <header>
              <span>调用参数</span>
            </header>
            <pre>
              <code>{prettyJson(toolCall.arguments) ?? toolCall.arguments}</code>
            </pre>
          </section>
        ) : null}

        {screenshot ? (
          <section className="tool-result-card__section tool-result-card__screenshot">
            <header>
              <span>截图预览</span>
            </header>
            <img alt="浏览器截图结果" src={screenshot} />
          </section>
        ) : null}

        {visibleResult ? (
          <section className="tool-result-card__section">
            <header>
              <span>执行结果</span>
              <IconButton label="复制工具输出" onClick={() => void copyResult()}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </IconButton>
            </header>
            <ResultContent format={resultFormat} result={visibleResult} />
            {metadata.kind === 'command' ? (
              <div className="tool-result-card__command-meta">
                {typeof metadata.exitCode === 'number' ? (
                  <span>退出码 {metadata.exitCode}</span>
                ) : null}
                {typeof metadata.signal === 'string' ? <span>信号 {metadata.signal}</span> : null}
              </div>
            ) : null}
            {serverTruncated ? (
              <p className="tool-result-card__notice">
                输出已按安全上限截断
                {typeof metadata.originalBytes === 'number'
                  ? `（原始 ${metadata.originalBytes.toLocaleString()} 字节）`
                  : ''}
                。
              </p>
            ) : null}
          </section>
        ) : toolCall.status === 'completed' ? (
          <p className="tool-result-card__empty">工具已执行，没有返回可显示的内容。</p>
        ) : null}

        {toolCall.status === 'approval-required' && isFileChange ? (
          <section className="tool-result-card__approval tool-result-card__approval--diff">
            <span>
              <FileDiff aria-hidden size={17} />
              <span>
                <strong>请在下方 Diff 审阅</strong>
                <small>文件修改由差异面板单独确认，可接受或拒绝本次变更。</small>
              </span>
            </span>
          </section>
        ) : null}

        {toolCall.status === 'approval-required' && !isFileChange ? (
          <section className="tool-result-card__approval">
            <span>
              <ShieldAlert aria-hidden size={17} />
              <span>
                <strong>需要你的确认</strong>
                <small>
                  {isCommand
                    ? '这不是 OS 沙箱；进程拥有当前系统用户权限，可能访问网络或工作区外资源。仅在确认命令和相关脚本可信时执行。'
                    : toolCall.name.startsWith('mcp_')
                      ? 'MCP Server 是外部进程或服务。请核对服务器、工具名称和参数；批准后它可能访问其自身权限范围内的数据。'
                      : toolCall.name.startsWith('computer_')
                        ? '该操作会读取或控制本机资源。请核对参数与影响范围后再允许。'
                        : '请检查调用参数。允许后，该操作才会在当前工作区执行。'}
                </small>
              </span>
            </span>
            {isMcp ? (
              <dl className="tool-result-card__identity">
                <div>
                  <dt>Server ID</dt>
                  <dd>{safeIdentityText(String(metadata.serverId ?? 'unknown'))}</dd>
                </div>
                <div>
                  <dt>真实工具名</dt>
                  <dd>{safeIdentityText(String(metadata.originalToolName ?? toolCall.name))}</dd>
                </div>
                {typeof metadata.endpoint === 'string' ? (
                  <div>
                    <dt>连接目标</dt>
                    <dd>{safeIdentityText(metadata.endpoint)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Server 声明</dt>
                  <dd>
                    {metadata.destructiveHint === true
                      ? '可能修改数据'
                      : metadata.readOnlyHint === true
                        ? '自报只读（不作为信任依据）'
                        : '影响范围未声明'}
                    {metadata.openWorldHint === true ? ' · 可能访问外部网络' : ''}
                  </dd>
                </div>
              </dl>
            ) : null}
            {executionUnavailableReason ? (
              <span className="tool-result-card__unavailable">{executionUnavailableReason}</span>
            ) : (
              <span className="tool-result-card__approval-actions">
                <Button
                  disabled={!onDecision || decision !== null}
                  loading={decision === 'approve'}
                  onClick={() => void decide('approve')}
                  size="small"
                  variant="primary"
                >
                  <Check size={13} />
                  允许执行
                </Button>
                <Button
                  disabled={!onDecision || decision !== null}
                  loading={decision === 'reject'}
                  onClick={() => void decide('reject')}
                  size="small"
                  variant="danger"
                >
                  <XCircle size={13} />
                  拒绝
                </Button>
              </span>
            )}
          </section>
        ) : null}

        {decisionError ? (
          <p className="tool-result-card__error" role="alert">
            <CircleAlert aria-hidden size={14} />
            {decisionError}
          </p>
        ) : null}
      </div>
    </details>
  );
}
