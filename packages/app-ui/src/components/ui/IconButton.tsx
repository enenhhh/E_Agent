import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

import { classNames } from '../../lib/class-names';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({
  active = false,
  children,
  className,
  label,
  type = 'button',
  ...props
}: PropsWithChildren<IconButtonProps>): React.JSX.Element {
  return (
    <button
      aria-label={label}
      className={classNames('icon-button', active && 'is-active', className)}
      title={label}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
