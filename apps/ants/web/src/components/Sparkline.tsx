import { useId, useRef } from 'react';
import { ChartTooltip } from './ChartTooltip';
import { nearestIndex, useChartHover } from './chart-hover';

interface Props {
  /** Oldest first. `null` leaves a gap. */
  values: Array<bigint | number | null>;
  width?: number;
  height?: number;
  /** Accessible summary for screen readers. */
  label: string;
  tone?: 'accent' | 'muted';
  /** Per-point hover titles (e.g. "Epoch 21"); hover is disabled without them. */
  labels?: string[];
  /** Hover value formatter; defaults to the raw number. */
  format?: (value: number) => string;
}

/** Tiny area sparkline for table rows: no axes, one line, soft fill. */
export function Sparkline({ values, width = 96, height = 26, label, tone = 'accent', labels, format }: Props) {
  const gradientId = useId();
  const numeric = values.map((value) => (value === null ? null : Number(value)));
  const known = numeric.filter((value): value is number => value !== null && Number.isFinite(value));
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stepX = numeric.length > 1 ? (width - 2) / (numeric.length - 1) : 0;
  const x = (index: number) => 1 + index * stepX;
  // Gaps sit at +Infinity so the nearest-point search skips them.
  const xs = numeric.map((value, index) => (value === null || !Number.isFinite(value) ? Number.POSITIVE_INFINITY : x(index)));
  const { hover, onPointerMove, onPointerLeave, clientPoint } = useChartHover(svgRef, width, height, (px) => (labels ? nearestIndex(px, xs) : null));
  if (known.length < 2) return <span className="sparkline sparkline--empty" aria-label={label} role="img">·</span>;
  const max = Math.max(...known);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const pad = 2;
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);
  let path = '';
  let area = '';
  let previous: number | null = null;
  numeric.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) { previous = null; return; }
    const command = previous === null ? 'M' : 'L';
    path += `${command}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
    previous = index;
  });
  const first = numeric.findIndex((value) => value !== null);
  const last = numeric.length - 1 - [...numeric].reverse().findIndex((value) => value !== null);
  if (first >= 0 && last >= first) {
    area = `${path.trim()} L${x(last).toFixed(1)},${height} L${x(first).toFixed(1)},${height} Z`;
  }
  const lastValue = numeric[last];
  const hoveredValue = hover !== null ? numeric[hover.index] : null;
  const hovered = hover !== null && hoveredValue !== null && hoveredValue !== undefined && Number.isFinite(hoveredValue) ? { index: hover.index, value: hoveredValue } : null;
  return (
    <span className="sparkline-wrap">
    <svg ref={svgRef} className={`sparkline sparkline--${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {area ? <path d={area} fill={`url(#${gradientId})`} stroke="none" /> : null}
      <path d={path.trim()} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {lastValue !== null && lastValue !== undefined && Number.isFinite(lastValue) ? <circle cx={x(last)} cy={y(lastValue)} r="2" fill="currentColor" /> : null}
      {hovered ? <circle cx={x(hovered.index)} cy={y(hovered.value)} r="3" className="sparkline-hover" aria-hidden="true" /> : null}
    </svg>
    {hovered ? <ChartTooltip {...clientPoint(x(hovered.index), 0)} title={labels?.[hovered.index] ?? ''} rows={[{ name: 'Settled volume', value: format ? format(hovered.value) : String(hovered.value) }]} /> : null}
    </span>
  );
}
