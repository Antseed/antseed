import type { ReactNode } from 'react';
import { Card } from './Card';
import { CopyButton } from './CopyButton';
import { Skeleton } from './Skeleton';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** A page's title row: heading and one line of description, actions on the right. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="as-page-header">
      <div className="as-page-header__text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="as-page-header__actions">{actions}</div>}
    </header>
  );
}

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Drops the body padding (for tables). */
  flush?: boolean;
  className?: string;
}

/** A section: heading row (title, description, actions) above a bordered card. */
export function Panel({ title, description, actions, children, flush, className }: PanelProps) {
  return (
    <section className={['as-panel', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="as-panel__head">
          <div>
            {title && <h2 className="as-panel__title">{title}</h2>}
            {description && <p className="as-panel__desc">{description}</p>}
          </div>
          {actions && <div className="as-panel__actions">{actions}</div>}
        </div>
      )}
      <Card className="as-panel__card">
        <div className={flush ? 'as-panel__body as-panel__body--flush' : 'as-panel__body'}>{children}</div>
      </Card>
    </section>
  );
}

export type StatTileTone = 'default' | 'warning' | 'danger';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** 0..1 fill of a usage meter under the value; omitted or null hides it. */
  meter?: number | null;
  /** Meter colour; by default warning from 80% and danger when full. */
  tone?: StatTileTone;
}

function meterTone(fill: number | null): StatTileTone {
  if (fill !== null && fill >= 1) return 'danger';
  if (fill !== null && fill >= 0.8) return 'warning';
  return 'default';
}

/** A metric card: label, large value, optional sub line and usage meter. */
export function StatTile({ label, value, sub, meter, tone }: StatTileProps) {
  const fill = meter === null || meter === undefined ? null : Math.max(0, Math.min(1, meter));
  return (
    <Card className="as-stat">
      <div className="as-stat__label">{label}</div>
      <div className="as-stat__value">{value}</div>
      {sub && <div className="as-stat__sub">{sub}</div>}
      {fill !== null && (
        <div className={`as-meter as-meter--${tone ?? meterTone(fill)}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
          <span style={{ width: `${fill * 100}%` }} />
        </div>
      )}
    </Card>
  );
}

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}

/** An empty list or chart: an icon tile, a title and one line of guidance. */
export function EmptyState({ title, body, action, icon }: EmptyStateProps) {
  return (
    <div className="as-empty">
      {icon && <div className="as-empty__icon" aria-hidden="true">{icon}</div>}
      <div className="as-empty__title">{title}</div>
      {body && <div className="as-empty__body">{body}</div>}
      {action && <div className="as-empty__action">{action}</div>}
    </div>
  );
}

/** Skeleton rows while a list or panel loads. */
export function LoadingRows({ rows = 4, height = 28 }: { rows?: number; height?: number }) {
  return (
    <div className="as-loading" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} height={height} />)}
    </div>
  );
}

/** A label/value list (detail drawers, summaries). */
export function DetailList({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="as-details">
      {items.map(([term, value], index) => (
        <div key={index} className="as-details__row">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Code with a copy button in a bar above it; long lines wrap inside the box. */
export function CodeBlock({ code, label }: { code: string; label?: ReactNode }) {
  return (
    <div className="as-code">
      <div className="as-code__bar"><span className="as-code__label">{label}</span><CopyButton value={code} /></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

/** A secret shown exactly once, with copy. */
export function SecretReveal({ secret, note = 'Copy it now. It will not be shown again.' }: { secret: string; note?: string }) {
  return (
    <div className="as-secret">
      <div className="as-secret__row">
        <code className="as-secret__value">{secret}</code>
        <CopyButton value={secret} />
      </div>
      <p className="as-secret__note">{note}</p>
    </div>
  );
}
