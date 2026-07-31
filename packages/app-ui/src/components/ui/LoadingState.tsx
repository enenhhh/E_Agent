export function LoadingState({ label = '正在加载…' }: { label?: string }): React.JSX.Element {
  return (
    <div aria-live="polite" className="loading-state">
      <span aria-hidden className="loading-state__spinner" />
      <span>{label}</span>
    </div>
  );
}
