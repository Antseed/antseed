import { useEpochInfo } from '../app-context';
import { epochStartAt, formatUtc } from '../format';

/** Epoch number with its UTC start date (from overview genesis + epochDuration). */
export function EpochCell({ epoch, dateOnly = false }: { epoch: number | null | undefined; dateOnly?: boolean }) {
  const info = useEpochInfo();
  if (epoch === null || epoch === undefined) return <span className="mono">—</span>;
  const date = info ? formatUtc(epochStartAt(epoch, info.genesis, info.epochDuration)) : null;
  if (dateOnly) return <span className="mono">{date ?? '—'}</span>;
  return (
    <span className="mono" title={date ?? undefined}>
      {epoch}
      {date ? <span className="muted small"> {date.slice(0, 10)}</span> : null}
    </span>
  );
}

export function useEpochDate(epoch: number | null | undefined): string | null {
  const info = useEpochInfo();
  if (epoch === null || epoch === undefined || !info) return null;
  return formatUtc(epochStartAt(epoch, info.genesis, info.epochDuration));
}
