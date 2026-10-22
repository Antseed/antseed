import type { Hash } from 'viem';
import type { ActionStep } from '../lib/actions';

/** Progress for a multi-transaction action (approve, stake, max lock…), with the last transaction and any error. */
export function Steps({ steps, error, tx }: { steps: ActionStep[]; error: string | null; tx: Hash | null }) {
  if (!steps.length && !error) return null;
  return (
    <div className="steps" aria-live="polite">
      {steps.map((s, i) => (
        <div key={s.label + i} className={`step ${s.state === 'done' ? 'done' : s.state === 'now' ? 'now' : ''}`}>
          <i>{s.state === 'done' ? '✓' : i + 1}</i>
          {s.label}
        </div>
      ))}
      {tx && (
        <a className="note" href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noopener noreferrer">
          Last transaction on Basescan ↗
        </a>
      )}
      {error && <div className="notice bad">{error}</div>}
    </div>
  );
}
