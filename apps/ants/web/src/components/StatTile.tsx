import { Card, Skeleton } from './ui';
import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  loading?: boolean;
  title?: string;
}

export function StatTile({ label, value, unit, sub, loading, title }: Props) {
  return (
    <Card className="tile" title={title}>
      <div className="tile-label">{label}</div>
      {loading ? (
        <Skeleton width="60%" height={22} style={{ marginTop: 3 }} />
      ) : (
        <div className="tile-value">
          {value}
          {unit ? <span className="unit">{unit}</span> : null}
        </div>
      )}
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </Card>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="tiles">{children}</div>;
}
