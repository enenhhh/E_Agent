import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import type { MessageRole } from '../../types';

export type MessageCopyFormat = 'markdown' | 'plain';
export type MessageFeedback = 'negative' | 'positive' | null;
export type MessageActionName =
  | 'branch'
  | 'copy'
  | 'delete'
  | 'edit'
  | 'feedback'
  | 'retry'
  | 'version';

type ActionCallback = () => Promise<void> | void;

export interface MessageVersion {
  current: number;
  total: number;
}

export interface MessageActionsProps {
  contentAvailable?: boolean;
  feedback?: MessageFeedback;
  mutationDisabled?: boolean;
  onActionError?: (action: MessageActionName, error: unknown) => void;
  onBranch?: ActionCallback;
  onCopy?: (format: MessageCopyFormat) => Promise<void> | void;
  onEdit?: () => void;
  onFeedback?: (feedback: MessageFeedback) => Promise<void> | void;
  onNextVersion?: ActionCallback;
  onPreviousVersion?: ActionCallback;
  onRequestDelete?: () => void;
  onRetry?: ActionCallback;
  role: MessageRole;
  version?: MessageVersion;
}

function ActionButton({
  active,
  children,
  disabled,
  label,
  onClick,
  pressed,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`message-actions__button${active ? ' is-active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      <span className="message-actions__label">{label}</span>
    </button>
  );
}

/**
 * 消息操作展示层。所有业务动作均通过回调交给上层，不读取 Store 或 Transport。
 */
export function MessageActions({
  contentAvailable = true,
  feedback = null,
  mutationDisabled = false,
  onActionError,
  onBranch,
  onCopy,
  onEdit,
  onFeedback,
  onNextVersion,
  onPreviousVersion,
  onRequestDelete,
  onRetry,
  role,
  version,
}: MessageActionsProps): React.JSX.Element | null {
  const menuId = useId();
  const menuContainerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const copyPendingRef = useRef(false);
  const mutationPendingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('up');
  const [copyPending, setCopyPending] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<MessageActionName | null>(null);
  const [copied, setCopied] = useState(false);

  const canEdit = role === 'user' && onEdit !== undefined;
  const canRetry = role === 'assistant' && onRetry !== undefined;
  const canGiveFeedback = role === 'assistant' && onFeedback !== undefined;
  const hasMenu = onBranch !== undefined || onCopy !== undefined || onRequestDelete !== undefined;
  const hasVersionNavigation =
    version !== undefined &&
    version.total > 1 &&
    (onPreviousVersion !== undefined || onNextVersion !== undefined);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!menuContainerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [menuOpen]);

  const enabledMenuItems = (): HTMLButtonElement[] =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );

  const focusMenuItem = (position: 'first' | 'last' | number): void => {
    window.requestAnimationFrame(() => {
      const items = enabledMenuItems();
      if (items.length === 0) {
        menuRef.current?.focus();
        return;
      }
      const index =
        position === 'first'
          ? 0
          : position === 'last'
            ? Math.max(0, items.length - 1)
            : Math.max(0, Math.min(position, items.length - 1));
      items[index]?.focus();
    });
  };

  const openMenu = (position: 'first' | 'last' = 'first'): void => {
    const triggerBounds = moreButtonRef.current?.getBoundingClientRect();
    setMenuPlacement(triggerBounds && triggerBounds.top < 190 ? 'down' : 'up');
    setMenuOpen(true);
    focusMenuItem(position);
  };

  const closeMenu = (restoreFocus = true): void => {
    setMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => moreButtonRef.current?.focus());
    }
  };

  const runMutation = async (
    name: Exclude<MessageActionName, 'copy'>,
    callback: ActionCallback,
  ): Promise<boolean> => {
    if (mutationDisabled || mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    setPendingMutation(name);
    try {
      await callback();
      return true;
    } catch (error) {
      onActionError?.(name, error);
      return false;
    } finally {
      mutationPendingRef.current = false;
      setPendingMutation(null);
    }
  };

  const copy = async (format: MessageCopyFormat): Promise<void> => {
    if (!onCopy || !contentAvailable || copyPendingRef.current) return;
    copyPendingRef.current = true;
    setCopyPending(true);
    try {
      await onCopy(format);
      setCopied(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      onActionError?.('copy', error);
    } finally {
      copyPendingRef.current = false;
      setCopyPending(false);
    }
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = enabledMenuItems();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (items.length > 0) {
        items[(currentIndex + 1 + items.length) % items.length]?.focus();
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0) {
        items[(currentIndex - 1 + items.length) % items.length]?.focus();
      }
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (event.key === 'Tab') {
      setMenuOpen(false);
    }
  };

  const allActionsMissing =
    onCopy === undefined &&
    !canEdit &&
    !canRetry &&
    !canGiveFeedback &&
    !hasMenu &&
    !hasVersionNavigation;
  if (allActionsMissing) return null;

  const mutationBusy = mutationDisabled || pendingMutation !== null;

  return (
    <div aria-label="消息操作" className="message-actions" role="group">
      {canEdit ? (
        <ActionButton disabled={mutationBusy} label="编辑并重新发送" onClick={() => onEdit()}>
          <Pencil aria-hidden size={13} strokeWidth={1.5} />
        </ActionButton>
      ) : null}

      {onCopy ? (
        <ActionButton
          disabled={!contentAvailable || copyPending}
          label={copied ? '已复制' : '复制'}
          onClick={() => void copy('plain')}
        >
          {copyPending ? (
            <LoaderCircle aria-hidden className="message-actions__spinner" size={13} />
          ) : copied ? (
            <Check aria-hidden size={13} strokeWidth={1.5} />
          ) : (
            <Copy aria-hidden size={13} strokeWidth={1.5} />
          )}
        </ActionButton>
      ) : null}

      {canRetry ? (
        <ActionButton
          disabled={mutationBusy}
          label="重试"
          onClick={() => void runMutation('retry', onRetry)}
        >
          {pendingMutation === 'retry' ? (
            <LoaderCircle aria-hidden className="message-actions__spinner" size={13} />
          ) : (
            <RefreshCw aria-hidden size={13} strokeWidth={1.5} />
          )}
        </ActionButton>
      ) : null}

      {canGiveFeedback ? (
        <>
          <ActionButton
            active={feedback === 'positive'}
            disabled={mutationBusy}
            label="有帮助"
            onClick={() =>
              void runMutation('feedback', () =>
                onFeedback(feedback === 'positive' ? null : 'positive'),
              )
            }
            pressed={feedback === 'positive'}
          >
            <ThumbsUp aria-hidden size={13} strokeWidth={1.5} />
          </ActionButton>
          <ActionButton
            active={feedback === 'negative'}
            disabled={mutationBusy}
            label="无帮助"
            onClick={() =>
              void runMutation('feedback', () =>
                onFeedback(feedback === 'negative' ? null : 'negative'),
              )
            }
            pressed={feedback === 'negative'}
          >
            <ThumbsDown aria-hidden size={13} strokeWidth={1.5} />
          </ActionButton>
        </>
      ) : null}

      {hasMenu ? (
        <span className="message-actions__more" ref={menuContainerRef}>
          <button
            aria-controls={menuOpen ? menuId : undefined}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="更多"
            className={`message-actions__button${menuOpen ? ' is-active' : ''}`}
            onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                openMenu('first');
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                openMenu('last');
              } else if (event.key === 'Escape' && menuOpen) {
                event.preventDefault();
                closeMenu();
              }
            }}
            ref={moreButtonRef}
            title="更多"
            type="button"
          >
            <MoreHorizontal aria-hidden size={14} strokeWidth={1.5} />
            <span className="message-actions__label">更多</span>
          </button>
          {menuOpen ? (
            <div
              aria-label="更多消息操作"
              className={`message-actions__menu message-actions__menu--${menuPlacement}`}
              id={menuId}
              onKeyDown={handleMenuKeyDown}
              ref={menuRef}
              role="menu"
              tabIndex={-1}
            >
              {onBranch ? (
                <button
                  disabled={mutationBusy}
                  onClick={() => {
                    closeMenu();
                    void runMutation('branch', onBranch);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <GitBranch aria-hidden size={14} strokeWidth={1.5} />
                  从此处开启新对话
                </button>
              ) : null}
              {onCopy ? (
                <button
                  disabled={!contentAvailable || copyPending}
                  onClick={() => {
                    closeMenu();
                    void copy('markdown');
                  }}
                  role="menuitem"
                  type="button"
                >
                  <FileText aria-hidden size={14} strokeWidth={1.5} />
                  复制为 Markdown
                </button>
              ) : null}
              {onRequestDelete ? (
                <button
                  className="message-actions__menu-danger"
                  disabled={mutationBusy}
                  onClick={() => {
                    closeMenu(false);
                    moreButtonRef.current?.focus();
                    onRequestDelete();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Trash2 aria-hidden size={14} strokeWidth={1.5} />
                  删除此消息
                </button>
              ) : null}
            </div>
          ) : null}
        </span>
      ) : null}

      {hasVersionNavigation && version ? (
        <span aria-label="答案版本" className="message-actions__versions">
          <button
            aria-label="上一个答案版本"
            disabled={mutationBusy || version.current <= 1 || onPreviousVersion === undefined}
            onClick={() => {
              if (onPreviousVersion) void runMutation('version', onPreviousVersion);
            }}
            title="上一个答案版本"
            type="button"
          >
            <ChevronLeft aria-hidden size={14} strokeWidth={1.5} />
          </button>
          <output aria-live="polite">
            {version.current} / {version.total}
          </output>
          <button
            aria-label="下一个答案版本"
            disabled={
              mutationBusy || version.current >= version.total || onNextVersion === undefined
            }
            onClick={() => {
              if (onNextVersion) void runMutation('version', onNextVersion);
            }}
            title="下一个答案版本"
            type="button"
          >
            <ChevronRight aria-hidden size={14} strokeWidth={1.5} />
          </button>
        </span>
      ) : null}

      <span aria-live="polite" className="sr-only" role="status">
        {copied ? '消息已复制' : ''}
      </span>
    </div>
  );
}
