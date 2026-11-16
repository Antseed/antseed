import { createContext, useContext, type ReactNode } from 'react';
import { formatAnts, formatInt } from '../format';

export const RewardRefreshContext = createContext({ updating: false, stale: false });

export function RewardRefreshStatus() {
  const { updating, stale } = useContext(RewardRefreshContext);
  if (!stale) return null;
  return <span className="reward-refresh-state">{updating ? 'Updating…' : 'Out of date'}</span>;
}

export function RewardAmount({ children }: { children: ReactNode }) {
  const { updating } = useContext(RewardRefreshContext);
  if (!updating) return <>{children}</>;
  return <span className="muted" aria-busy="true">{children}</span>;
}

/** `amount` is an ANTS base-unit string by default; `amountKind="count"` renders a plain integer with no unit. */
export function BucketRow({ visible, name, note, amount, amountKind = 'ants', amountDetail, actions }: { visible: boolean; name: string; note?: ReactNode; amount: string | null; amountKind?: 'ants' | 'count'; amountDetail?: string; actions: ReactNode }) {
  if (!visible) return null;
  return (
    <div className="bucket">
      <div className="bucket-main">
        <div className="bucket-name">{name}</div>
        {note ? <div className="bucket-note">{note}</div> : null}
      </div>
      <div className={`bucket-amount mono${amountDetail ? ' bucket-amount--detailed' : ''}`}>
        {amount === null ? <span className="muted">—</span>
          : amountKind === 'count'
          ? <span><RewardAmount>{formatInt(amount)}</RewardAmount></span>
          : <span><RewardAmount>{formatAnts(amount, 4)}</RewardAmount> <span className="unit">ANTS</span></span>}
        {amountDetail ? <span className="bucket-amount-detail"><RewardAmount>{amountDetail}</RewardAmount></span> : null}
      </div>
      <div className="bucket-actions">{actions}</div>
    </div>
  );
}
