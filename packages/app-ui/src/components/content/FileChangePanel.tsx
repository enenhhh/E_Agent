import { Check, FileCode2, X } from 'lucide-react';

import { classNames } from '../../lib/class-names';
import type { FileChange } from '../../types';
import { Button } from '../ui/Button';

function DiffLine({ line, number }: { line: string; number: number }): React.JSX.Element {
  const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
  return (
    <div className={classNames('diff-line', `diff-line--${kind}`)}>
      <span className="diff-line__number">{number}</span>
      <code>{line || ' '}</code>
    </div>
  );
}

export function FileChangePanel({
  change,
  onAccept,
  onReject,
  unavailableReason,
}: {
  change: FileChange;
  onAccept?: () => void;
  onReject?: () => void;
  unavailableReason?: string;
}): React.JSX.Element {
  const lines = change.diff.split('\n');
  return (
    <section className="file-change">
      <header className="file-change__header">
        <span className="file-change__path">
          <FileCode2 size={16} />
          {change.path}
        </span>
        {change.status === 'pending' && unavailableReason ? (
          <span className="file-change__unavailable">{unavailableReason}</span>
        ) : change.status === 'pending' ? (
          <span className="file-change__actions">
            <Button disabled={!onAccept} onClick={onAccept} size="small" variant="primary">
              <Check size={14} />
              接受更改
            </Button>
            <Button disabled={!onReject} onClick={onReject} size="small" variant="ghost">
              <X size={14} />
              拒绝
            </Button>
          </span>
        ) : (
          <span className={`file-change__decision file-change__decision--${change.status}`}>
            {change.status === 'accepted' ? '已接受' : '已拒绝'}
          </span>
        )}
      </header>
      <div className="file-change__diff">
        {lines.map((line, index) => (
          <DiffLine key={`${index}-${line}`} line={line} number={index + 1} />
        ))}
      </div>
    </section>
  );
}
