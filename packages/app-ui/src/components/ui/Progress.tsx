import { classNames } from '../../lib/class-names';
import { clampPercentage } from '../../lib/format';

export function Progress({
  label,
  tone = 'default',
  value,
}: {
  label?: string;
  tone?: 'default' | 'warning' | 'danger';
  value: number;
}): React.JSX.Element {
  const percentage = clampPercentage(value);
  return (
    <span
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percentage}
      className={classNames('progress', `progress--${tone}`)}
      role="progressbar"
    >
      <span className="progress__value" style={{ width: `${percentage}%` }} />
    </span>
  );
}
