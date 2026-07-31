import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../components/ui/Button';

export interface MessageDeleteDialogProps {
  confirmDisabled?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  onError?: (error: unknown) => void;
  open: boolean;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * 消息删除确认。对话框负责焦点约束和重复提交保护，删除语义由上层实现。
 */
export function MessageDeleteDialog({
  confirmDisabled = false,
  loading = false,
  onCancel,
  onConfirm,
  onError,
  open,
}: MessageDeleteDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef(onCancel);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = loading || submitting;
  busyRef.current = busy;
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;

    setError(null);
    submittingRef.current = false;
    setSubmitting(false);
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (dialogRef.current) {
        (focusableElements(dialogRef.current)[0] ?? dialogRef.current).focus();
      }
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!busyRef.current) {
          event.preventDefault();
          cancelRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const confirm = async (): Promise<void> => {
    if (busy || confirmDisabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '删除失败，请重试。');
      onError?.(confirmError);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="message-delete-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-busy={busy}
        aria-modal="true"
        className="message-delete-dialog"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <span className="message-delete-dialog__icon" aria-hidden>
          <TriangleAlert size={18} />
        </span>
        <div className="message-delete-dialog__copy">
          <h2 id={titleId}>删除这条消息？</h2>
          <div id={descriptionId}>
            <p>此消息及其后的内容将被移除，可从自动快照恢复聊天记录。</p>
            <p>已写入的文件、已执行的命令或其他外部操作不会回滚。</p>
          </div>
          {error ? (
            <p className="message-delete-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer>
          <Button disabled={busy} onClick={onCancel} size="small" variant="ghost">
            取消
          </Button>
          <Button
            disabled={confirmDisabled}
            loading={busy}
            onClick={() => void confirm()}
            size="small"
            variant="danger"
          >
            删除
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
