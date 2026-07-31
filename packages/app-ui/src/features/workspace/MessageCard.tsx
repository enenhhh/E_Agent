import {
  Bot,
  CircleAlert,
  CircleStop,
  Clock3,
  LoaderCircle,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { MarkdownMessage } from '../../components/content/MarkdownMessage';
import { ReasoningPanel } from '../../components/content/ReasoningPanel';
import { Button } from '../../components/ui/Button';
import { formatDuration } from '../../lib/format';
import { useSettingsStore } from '../../stores/settings-store';
import type { Message } from '../../types';

import {
  MessageActions,
  type MessageActionName,
  type MessageCopyFormat,
  type MessageFeedback,
  type MessageVersion,
} from './MessageActions';
import { MessageDeleteDialog } from './MessageDeleteDialog';
import type { ToolActivityOrderEntry } from './tool-activity-types';
import { ToolActivity } from './ToolActivity';

type MaybePromise = Promise<void> | void;

export interface MessageCardProps {
  conversationBusy?: boolean;
  feedback?: MessageFeedback;
  groupedToolMessages?: Message[];
  message: Message;
  onActionError?: (action: MessageActionName, error: unknown) => void;
  onBranch?: (messageId: string) => MaybePromise;
  onCopy?: (messageId: string, content: string, format: MessageCopyFormat) => MaybePromise;
  onDelete?: (messageId: string) => MaybePromise;
  onEdit?: (messageId: string, content: string) => MaybePromise;
  onFeedback?: (messageId: string, feedback: MessageFeedback) => MaybePromise;
  onFileDecision: (changeId: string, decision: 'accept' | 'reject') => void;
  onNextVersion?: (messageId: string) => MaybePromise;
  onPreviousVersion?: (messageId: string) => MaybePromise;
  onRetry?: (messageId: string) => MaybePromise;
  toolActivityOrder?: ToolActivityOrderEntry[];
  version?: MessageVersion;
}

export function MessageCard({
  conversationBusy = false,
  feedback,
  groupedToolMessages,
  message,
  onActionError,
  onBranch,
  onCopy,
  onDelete,
  onEdit,
  onFeedback,
  onFileDecision,
  onNextVersion,
  onPreviousVersion,
  onRetry,
  toolActivityOrder,
  version,
}: MessageCardProps): React.JSX.Element {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const reasoningDisplay = useSettingsStore((state) => state.settings.reasoningDisplay);
  const isStreaming = message.status === 'pending' || message.status === 'streaming';
  const mutationsDisabled = conversationBusy || isStreaming;
  const hasReasoning = Boolean(message.reasoning?.trim());
  const cardRef = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const copyMessage = async (format: MessageCopyFormat): Promise<void> => {
    if (onCopy) {
      await onCopy(message.id, message.content, format);
      return;
    }
    await navigator.clipboard.writeText(message.content);
  };

  const beginEditing = (): void => {
    setEditDraft(message.content);
    setEditError(null);
    setEditing(true);
  };

  const cancelEditing = (): void => {
    if (editSubmitting) return;
    setEditDraft(message.content);
    setEditError(null);
    setEditing(false);
    window.requestAnimationFrame(() => cardRef.current?.focus());
  };

  const submitEdit = async (): Promise<void> => {
    const nextContent = editDraft.trim();
    if (
      !onEdit ||
      !nextContent ||
      editSubmitting ||
      mutationsDisabled ||
      nextContent === message.content.trim()
    )
      return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      await onEdit(message.id, nextContent);
      setEditing(false);
      window.requestAnimationFrame(() => cardRef.current?.focus());
    } catch (error) {
      setEditError(error instanceof Error ? error.message : '无法重新发送，请重试。');
      onActionError?.('edit', error);
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
      return;
    }
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      event.target instanceof HTMLTextAreaElement &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submitEdit();
    }
  };

  return (
    <article
      aria-label={`${isUser ? '你的' : isTool ? '工具' : 'E Agent 的'}消息`}
      className={`message-card message-card--${message.role}`}
      ref={cardRef}
      tabIndex={0}
    >
      <span className="message-card__avatar" aria-hidden>
        {isUser ? (
          <UserRound size={16} />
        ) : isTool ? (
          <TerminalSquare size={16} />
        ) : (
          <Bot size={16} />
        )}
      </span>
      <div className="message-card__content">
        <header className="message-card__meta">
          <strong>{isUser ? '你' : isTool ? '工具' : 'E Agent'}</strong>
          {message.model ? <span>{message.model}</span> : null}
          <time>
            {new Intl.DateTimeFormat(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(message.createdAt))}
          </time>
          {message.status === 'streaming' ? (
            <span className="message-card__streaming">
              <LoaderCircle size={13} />
              正在生成
            </span>
          ) : null}
          {message.status === 'failed' ? (
            <span className="message-card__failed">
              <CircleAlert size={13} />
              失败
            </span>
          ) : null}
          {message.status === 'cancelled' ? (
            <span className="message-card__cancelled">
              <CircleStop size={13} />
              已停止
            </span>
          ) : null}
        </header>
        {!isUser && !isTool ? (
          <ReasoningPanel
            content={message.reasoning ?? ''}
            display={reasoningDisplay}
            durationMs={message.reasoningDurationMs}
            streaming={isStreaming}
          />
        ) : null}
        {editing ? (
          <form
            className="message-editor"
            onKeyDown={handleEditorKeyDown}
            onSubmit={(event) => {
              event.preventDefault();
              void submitEdit();
            }}
          >
            <textarea
              aria-label="编辑消息"
              autoFocus
              onChange={(event) => setEditDraft(event.target.value)}
              rows={Math.min(12, Math.max(3, editDraft.split('\n').length + 1))}
              value={editDraft}
            />
            {editError ? (
              <p className="message-editor__error" role="alert">
                {editError}
              </p>
            ) : null}
            <footer>
              <span>Ctrl / ⌘ + Enter 重新发送 · Esc 取消</span>
              <Button
                disabled={editSubmitting}
                onClick={cancelEditing}
                size="small"
                variant="ghost"
              >
                取消
              </Button>
              <Button
                disabled={
                  mutationsDisabled ||
                  !editDraft.trim() ||
                  editDraft.trim() === message.content.trim()
                }
                loading={editSubmitting}
                size="small"
                type="submit"
                variant="primary"
              >
                编辑并重新发送
              </Button>
            </footer>
          </form>
        ) : message.content ? (
          isUser ? (
            <p className="message-card__user-copy">{message.content}</p>
          ) : (
            <MarkdownMessage content={message.content} />
          )
        ) : isStreaming && !hasReasoning && !message.toolCalls?.length ? (
          <span className="message-card__thinking">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        <ToolActivity
          conversationId={message.conversationId}
          fileChanges={message.fileChanges}
          onFileDecision={onFileDecision}
          order={toolActivityOrder}
          toolCalls={message.toolCalls}
          toolMessages={groupedToolMessages}
        />
        {message.status === 'completed' && (message.inputTokens || message.outputTokens) ? (
          <footer className="message-card__usage">
            <span>
              {message.inputTokens?.toLocaleString() ?? 0} 输入 ·{' '}
              {message.outputTokens?.toLocaleString() ?? 0} 输出
            </span>
            {message.latencyMs ? (
              <span>
                <Clock3 size={12} />
                {formatDuration(message.latencyMs)}
              </span>
            ) : null}
          </footer>
        ) : null}
        {!editing ? (
          <MessageActions
            contentAvailable={Boolean(message.content)}
            feedback={feedback}
            mutationDisabled={mutationsDisabled}
            onActionError={onActionError}
            onBranch={onBranch ? () => onBranch(message.id) : undefined}
            onCopy={copyMessage}
            onEdit={isUser && onEdit ? beginEditing : undefined}
            onFeedback={
              onFeedback ? (nextFeedback) => onFeedback(message.id, nextFeedback) : undefined
            }
            onNextVersion={onNextVersion ? () => onNextVersion(message.id) : undefined}
            onPreviousVersion={onPreviousVersion ? () => onPreviousVersion(message.id) : undefined}
            onRequestDelete={onDelete ? () => setDeleteOpen(true) : undefined}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            role={message.role}
            version={version}
          />
        ) : null}
      </div>
      <MessageDeleteDialog
        confirmDisabled={mutationsDisabled}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!onDelete || mutationsDisabled) return;
          await onDelete(message.id);
          setDeleteOpen(false);
        }}
        onError={(error) => onActionError?.('delete', error)}
        open={deleteOpen}
      />
    </article>
  );
}
