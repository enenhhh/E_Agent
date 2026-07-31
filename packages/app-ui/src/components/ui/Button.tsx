import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

import { classNames } from '../../lib/class-names';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  loading?: boolean;
}

export function Button({
  children,
  className,
  disabled,
  loading = false,
  size = 'medium',
  type = 'button',
  variant = 'secondary',
  ...props
}: PropsWithChildren<ButtonProps>): React.JSX.Element {
  return (
    <button
      className={classNames('button', `button--${variant}`, `button--${size}`, className)}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden className="button__spinner" size={16} /> : null}
      {children}
    </button>
  );
}
