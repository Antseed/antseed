import type { ReactNode } from 'react';

export interface DisclosureProps {
  /** The always-visible row that toggles the content. */
  title: ReactNode;
  /** Quiet text at the end of the row, e.g. what is set inside ("2 set"). */
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** A collapsible section (native details/summary), closed by default. */
export function Disclosure({ title, summary, children, defaultOpen, className }: DisclosureProps) {
  return (
    <details className={['as-disclosure', className].filter(Boolean).join(' ')} open={defaultOpen}>
      <summary className="as-disclosure__summary">
        <span className="as-disclosure__title">{title}</span>
        {summary !== undefined && summary !== null && summary !== '' && <span className="as-disclosure__meta">{summary}</span>}
        <svg className="as-disclosure__chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="as-disclosure__body">{children}</div>
    </details>
  );
}
