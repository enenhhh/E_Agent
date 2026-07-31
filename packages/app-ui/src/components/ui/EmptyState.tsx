import type { ReactNode } from 'react';

export function EmptyState({
  action,
  description,
  icon,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">{icon}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
