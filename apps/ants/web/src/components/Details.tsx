import { useState, type ReactNode } from 'react';

/** Collapsed-by-default section (native <details>) for numbers and forms that are not needed at a glance. */
export function Details({ summary, children, open, className, lazy = false }: { summary: ReactNode; children: ReactNode; open?: boolean; className?: string; lazy?: boolean }) {
  const [expanded, setExpanded] = useState(open ?? false);
  return (
    <details className={['details', className ?? ''].filter(Boolean).join(' ')} open={open} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{summary}</summary>
      <div className="details-body">{!lazy || expanded ? children : null}</div>
    </details>
  );
}
