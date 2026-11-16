import { Card } from './ui';
import type { ReactNode } from 'react';

interface Props {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: 'surface' | 'muted' | 'accent' | 'danger';
}

export function Panel({ title, actions, children, className, tone }: Props) {
  return (
    <Card className={`panel ${className ?? ''}`.trim()} tone={tone}>
      {title || actions ? (
        <div className="panel-head">
          {title ? <h3>{title}</h3> : <span />}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="facts">
      {items.map(([label, value]) => (
        <FactRow key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </>
  );
}
