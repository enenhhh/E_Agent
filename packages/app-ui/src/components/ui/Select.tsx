import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

import { classNames } from '../../lib/class-names';

export function Select({
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <span className={classNames('select', className)}>
      <select className="select__native" {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden className="select__icon" size={14} />
    </span>
  );
}
