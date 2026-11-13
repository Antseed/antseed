import type { ReactNode } from 'react';

export interface TooltipRow { name: string; value: string; color?: string; note?: string; }

interface Props {
  /** Anchor in viewport pixels (the tooltip is position: fixed so table and modal scroll containers never clip it). */
  left: number;
  top: number;
  title: ReactNode;
  rows: TooltipRow[];
}

/** Hover readout anchored at a chart point: epoch on top, one row per series with its colour swatch. */
export function ChartTooltip({ left, top, title, rows }: Props) {
  const flip = typeof window !== 'undefined' && left > window.innerWidth - 240;
  return (
    <div className={flip ? 'chart-tip chart-tip--left' : 'chart-tip'} style={{ left, top }} role="status" aria-live="polite">
      <div className="chart-tip-title">{title}</div>
      {rows.map((row) => (
        <div key={row.name} className="chart-tip-row">
          <i style={row.color ? { background: row.color } : undefined} aria-hidden="true" />
          <span className="chart-tip-name">{row.name}</span>
          <span className="chart-tip-value">{row.value}{row.note ? <small> {row.note}</small> : null}</span>
        </div>
      ))}
    </div>
  );
}
