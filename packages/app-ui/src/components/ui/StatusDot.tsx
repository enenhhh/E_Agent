import { classNames } from '../../lib/class-names';
import type { HealthLevel } from '../../types';

export function StatusDot({
  label,
  status,
}: {
  label?: string;
  status: HealthLevel;
}): React.JSX.Element {
  return (
    <span className={classNames('status-dot', `status-dot--${status}`)}>
      <span aria-hidden className="status-dot__indicator" />
      {label ? <span>{label}</span> : <span className="sr-only">{status}</span>}
    </span>
  );
}
