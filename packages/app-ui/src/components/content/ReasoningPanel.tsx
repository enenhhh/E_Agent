import { BrainCircuit, CheckCircle2, ChevronDown, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AppSettings } from '../../types';

import { MarkdownMessage } from './MarkdownMessage';

function formatReasoningDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
}

export function ReasoningPanel({
  content,
  display,
  durationMs,
  streaming,
}: {
  content: string;
  display: AppSettings['reasoningDisplay'];
  durationMs?: number;
  streaming: boolean;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(streaming || display === 'expanded');
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (streaming) {
      setOpen(true);
    } else if (wasStreaming.current || display !== 'collapsed') {
      setOpen(display === 'expanded');
    }
    wasStreaming.current = streaming;
  }, [display, streaming]);

  if (display === 'hidden' || content.length === 0) return null;

  const label = streaming
    ? '思考中'
    : durationMs === undefined
      ? '思考完成'
      : `已思考 ${formatReasoningDuration(durationMs)}`;

  return (
    <details
      className={`reasoning-panel${streaming ? ' reasoning-panel--streaming' : ''}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span className="reasoning-panel__icon" aria-hidden>
          {streaming ? <LoaderCircle size={15} /> : <CheckCircle2 size={15} />}
        </span>
        <BrainCircuit aria-hidden size={15} />
        <strong>{label}</strong>
        <ChevronDown aria-hidden className="reasoning-panel__chevron" size={15} />
      </summary>
      <div className="reasoning-panel__content">
        <MarkdownMessage content={content} />
      </div>
    </details>
  );
}
