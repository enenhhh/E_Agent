import { History, MessageSquareText, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { Snapshot } from '../../types';

interface SnapshotHistoryModalProps {
  open: boolean;
  snapshots: Snapshot[];
  loading: boolean;
  restoringSnapshotId: string | null;
  error: string | null;
  onClose: () => void;
  onRestore: (snapshotId: string) => Promise<void>;
}

/**
 * 展示当前会话的历史快照，并在执行破坏性恢复前要求二次确认。
 */
export function SnapshotHistoryModal({
  error,
  loading,
  onClose,
  onRestore,
  open,
  restoringSnapshotId,
  snapshots,
}: SnapshotHistoryModalProps): React.JSX.Element {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmingSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === confirmingId) ?? null,
    [confirmingId, snapshots],
  );

  useEffect(() => {
    if (!open) {
      setConfirmingId(null);
    }
  }, [open]);

  const restore = async (): Promise<void> => {
    if (confirmingSnapshot === null) return;
    await onRestore(confirmingSnapshot.id);
    setConfirmingId(null);
  };

  return (
    <Modal
      description="恢复后，会话消息与上下文将回到所选快照保存时的状态。"
      footer={
        <Button disabled={restoringSnapshotId !== null} onClick={onClose} variant="ghost">
          关闭
        </Button>
      }
      onClose={onClose}
      open={open}
      title="快照历史"
    >
      <div className="snapshot-history">
        {loading ? (
          <div aria-live="polite" className="snapshot-history__state">
            <History aria-hidden size={22} />
            正在加载快照…
          </div>
        ) : null}

        {!loading && error ? (
          <p className="snapshot-history__error" role="alert">
            {error}
          </p>
        ) : null}

        {!loading && !error && snapshots.length === 0 ? (
          <div className="snapshot-history__state">
            <History aria-hidden size={22} />
            <strong>尚无快照</strong>
            <span>先保存一次快照，之后就可以回到该会话状态。</span>
          </div>
        ) : null}

        {!loading && snapshots.length > 0 ? (
          <ol className="snapshot-history__list">
            {snapshots.map((snapshot) => (
              <li className="snapshot-history__item" key={snapshot.id}>
                <span className="snapshot-history__icon">
                  <MessageSquareText aria-hidden size={16} />
                </span>
                <span className="snapshot-history__details">
                  <strong>{formatSnapshotTime(snapshot.createdAt)}</strong>
                  <small>{snapshot.messageCount.toLocaleString()} 条消息</small>
                </span>
                <Button
                  aria-label={`恢复 ${formatSnapshotTime(snapshot.createdAt)} 的快照`}
                  disabled={restoringSnapshotId !== null}
                  onClick={() => setConfirmingId(snapshot.id)}
                  size="small"
                  variant="secondary"
                >
                  <RotateCcw aria-hidden size={13} />
                  恢复到此快照
                </Button>
              </li>
            ))}
          </ol>
        ) : null}

        {confirmingSnapshot ? (
          <section aria-live="polite" className="snapshot-history__confirmation">
            <div>
              <strong>确认恢复此快照？</strong>
              <p>当前快照之后的消息将从会话中移除。系统不会删除快照，之后仍可再次选择。</p>
            </div>
            <span>
              <Button
                disabled={restoringSnapshotId !== null}
                onClick={() => setConfirmingId(null)}
                size="small"
                variant="ghost"
              >
                取消
              </Button>
              <Button
                loading={restoringSnapshotId === confirmingSnapshot.id}
                onClick={() => void restore()}
                size="small"
                variant="danger"
              >
                确认恢复
              </Button>
            </span>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function formatSnapshotTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
