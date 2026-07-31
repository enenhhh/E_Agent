import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

import { classNames } from '../../lib/class-names';

import { IconButton } from './IconButton';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  error?: string;
  action?: ReactNode;
}

export function Field({
  action,
  className,
  description,
  error,
  id,
  label,
  type = 'text',
  ...props
}: FieldProps): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [showSecret, setShowSecret] = useState(false);
  const isPassword = type === 'password';

  return (
    <div className={classNames('field', className)}>
      <span className="field__label-row">
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
        {action}
      </span>
      <span className="field__control">
        <input
          aria-describedby={description ? `${inputId}-description` : undefined}
          aria-invalid={Boolean(error)}
          className="field__input"
          id={inputId}
          type={isPassword && showSecret ? 'text' : type}
          {...props}
        />
        {isPassword ? (
          <IconButton
            className="field__reveal"
            label={showSecret ? '隐藏内容' : '显示内容'}
            onClick={() => setShowSecret((value) => !value)}
            tabIndex={-1}
          >
            {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        ) : null}
      </span>
      {description ? (
        <span className="field__description" id={`${inputId}-description`}>
          {description}
        </span>
      ) : null}
      {error ? <span className="field__error">{error}</span> : null}
    </div>
  );
}
