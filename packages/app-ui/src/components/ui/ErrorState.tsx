import { CircleAlert } from 'lucide-react';

import { Button } from './Button';

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="error-state" role="alert">
      <CircleAlert aria-hidden size={22} />
      <span>
        <strong>无法完成操作</strong>
        <p>{message}</p>
      </span>
      {onRetry ? (
        <Button onClick={onRetry} size="small" variant="ghost">
          重试
        </Button>
      ) : null}
    </div>
  );
}
