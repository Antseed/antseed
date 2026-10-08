import { useEffect, useRef, useState } from 'react';

const plain = (value: number) => value.toLocaleString('en-US');

/** Rendered width of an element, so SVG charts draw in real pixels instead of being stretched. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(element.clientWidth, 120));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (value <= factor * magnitude) return factor * magnitude;
  return 10 * magnitude;
}

/** Horizontal grid lines with value ticks at 0, 25, 50, 75 and 100% of `scaleMax`. */
function YAxis({ left, top, width, innerHeight, scaleMax, format }: {
  left: number; top: number; width: number; innerHeight: number; scaleMax: number; format: (value: number) => string
}) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const y = top + innerHeight * (1 - fraction);
        return (
          <g key={fraction}>
            <line x1={left} x2={width} y1={y} y2={y} className={fraction === 0 ? 'as-chart__axis' : 'as-chart__grid'} />
            <text x={left - 8} y={y + 3.5} textAnchor="end" className="as-chart__tick">{format(scaleMax * fraction)}</text>
          </g>
        );
      })}
    </>
  );
}

export interface ChartPoint {
  label: string;
  value: number;
  sub?: string;
}

/** Small dependency-free bar chart (e.g. spend per day), with a y axis and a hover readout. */
export function BarChart({ points, height = 200, format = plain, label }: {
  points: ChartPoint[]; height?: number; format?: (value: number) => string; label: string
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const max = Math.max(...points.map((point) => point.value), 0);
  const scaleMax = max > 0 ? niceCeil(max) : 1;
  const axisWidth = Math.min(64, Math.max(36, format(scaleMax).length * 7 + 8));
  const pad = { top: 8, bottom: 24, left: axisWidth };
  const innerWidth = Math.max(width - pad.left, 40);
  const innerHeight = height - pad.top - pad.bottom;
  const step = innerWidth / Math.max(points.length, 1);
  const barWidth = Math.max(2, Math.min(32, step * 0.68));
  // Roughly one date label per 64px so they never overlap.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(innerWidth / 64))));
  const active = hover !== null ? points[hover] : null;

  return (
    <div className="as-chart" ref={ref}>
      <div className="as-chart__readout" aria-live="polite">
        {active ? <><strong>{format(active.value)}</strong> <span>{active.label}{active.sub ? ` · ${active.sub}` : ''}</span></>
          : <><strong>{format(points.reduce((sum, point) => sum + point.value, 0))}</strong> <span>total</span></>}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label} className="as-chart__svg"
        onMouseLeave={() => setHover(null)}>
        <YAxis left={pad.left} top={pad.top} width={width} innerHeight={innerHeight} scaleMax={scaleMax} format={format} />
        {points.map((point, index) => {
          const barHeight = (point.value / scaleMax) * innerHeight;
          const x = pad.left + index * step + (step - barWidth) / 2;
          return (
            <g key={index} onMouseEnter={() => setHover(index)}>
              <rect x={pad.left + index * step} y={pad.top} width={step} height={innerHeight} fill="transparent" />
              <rect x={x} y={pad.top + innerHeight - barHeight} width={barWidth} height={Math.max(barHeight, point.value > 0 ? 1 : 0)} rx={1.5}
                className={hover === index ? 'as-chart__bar as-chart__bar--on' : 'as-chart__bar'}>
                <title>{`${point.label}: ${format(point.value)}`}</title>
              </rect>
              {index % labelEvery === 0 && (
                <text x={pad.left + index * step + step / 2} y={height - 6} textAnchor="middle" className="as-chart__tick">{point.label}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}


/** A horizontal share bar list (top keys/models). */
export function ShareBars({ items, format = plain }: {
  items: Array<{ label: string; value: number; sub?: string }>; format?: (value: number) => string
}) {
  const max = Math.max(...items.map((item) => item.value), 0) || 1;
  return (
    <ul className="as-share">
      {items.map((item) => (
        <li key={item.label}>
          <div className="as-share__row">
            <span className="as-share__label" title={item.label}>{item.label}</span>
            <span className="as-share__value">{format(item.value)}</span>
          </div>
          <div className="as-share__bar"><span style={{ width: `${(item.value / max) * 100}%` }} /></div>
          {item.sub && <div className="as-share__sub">{item.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Tiny inline trend line for table cells. Its accessible name is
 * "<label>: peak <format(max)> <per>", or "<label>: <emptyText>".
 */
export function Sparkline({ values, label, width = 96, height = 24, format = plain, per, emptyText = 'no data' }: {
  values: number[]; label: string; width?: number; height?: number; format?: (value: number) => string; per?: string; emptyText?: string
}) {
  const max = Math.max(...values, 0);
  if (values.length < 2 || max === 0) return <span className="as-spark as-spark--empty" role="img" aria-label={`${label}: ${emptyText}`} />;
  const step = width / (values.length - 1);
  const y = (value: number) => height - 2 - (value / max) * (height - 4);
  const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  return (
    <svg className="as-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img"
      aria-label={`${label}: peak ${format(max)}${per ? ` ${per}` : ''}`}>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} className="as-spark__area" />
      <path d={line} className="as-spark__line" />
    </svg>
  );
}

/** Categorical series colours (CSS tokens); "Other" always takes the neutral one. */
export const SERIES_COLORS = ['var(--as-series-1)', 'var(--as-series-2)', 'var(--as-series-3)', 'var(--as-series-4)', 'var(--as-series-5)', 'var(--as-series-6)'];
export const OTHER_COLOR = 'var(--as-series-other)';

export interface StackSeries { key: string; label: string; total: number; color: string }

/** Beside the hovered column (never over it): to its right in the left half, to its left otherwise. */
function tooltipLeft(columnX: number, step: number, width: number): number {
  if (columnX + step / 2 < width / 2) return Math.min(columnX + step + 8, Math.max(width - 192, 0));
  return Math.max(columnX - 8 - 184, 0);
}

/**
 * Stacked bar chart (one column per time bucket, one segment per series) with
 * a y axis, a hover breakdown and a legend with totals. Dependency-free SVG.
 */
export function StackedBarChart({ labels, columns, series, height = 240, format, label }: {
  labels: string[];
  columns: Array<Record<string, number>>;
  series: StackSeries[];
  height?: number;
  format: (value: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const sums = columns.map((column) => series.reduce((sum, entry) => sum + (column[entry.key] ?? 0), 0));
  const max = Math.max(...sums, 0);
  const scaleMax = max > 0 ? niceCeil(max) : 1;
  const axisWidth = Math.min(64, Math.max(36, format(scaleMax).length * 7 + 8));
  const pad = { top: 8, bottom: 24, left: axisWidth, right: 0 };
  const innerWidth = Math.max(width - pad.left - pad.right, 40);
  const innerHeight = height - pad.top - pad.bottom;
  const step = innerWidth / Math.max(columns.length, 1);
  const barWidth = Math.max(3, Math.min(36, step * 0.68));
  const labelEvery = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(innerWidth / 64))));
  const total = series.reduce((sum, entry) => sum + entry.total, 0);
  const active = hover !== null ? { index: hover, sum: sums[hover] ?? 0, column: columns[hover] ?? {} } : null;
  const tipLeft = active ? tooltipLeft(pad.left + active.index * step, step, width) : 0;

  return (
    <div className="as-chart" ref={ref}>
      <div className="as-chart__readout" aria-live="polite">
        <strong>{format(active ? active.sum : total)}</strong>
        <span>{active ? labels[active.index] : 'total in range'}</span>
      </div>
      <div className="as-chart__plot">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={label}
          className={hover !== null ? 'as-chart__svg as-chart__svg--hovering' : 'as-chart__svg'} onMouseLeave={() => setHover(null)}>
          <YAxis left={pad.left} top={pad.top} width={width} innerHeight={innerHeight} scaleMax={scaleMax} format={format} />
          {columns.map((column, index) => {
            let y = pad.top + innerHeight;
            const x = pad.left + index * step + (step - barWidth) / 2;
            return (
              <g key={index} className={hover === index ? 'as-chart__col as-chart__col--on' : 'as-chart__col'} onMouseEnter={() => setHover(index)}>
                <rect x={pad.left + index * step} y={pad.top} width={step} height={innerHeight} fill="transparent" />
                {series.map((entry) => {
                  const value = column[entry.key] ?? 0;
                  if (value <= 0) return null;
                  const h = Math.max((value / scaleMax) * innerHeight, 1);
                  y -= h;
                  return <rect key={entry.key} x={x} y={y} width={barWidth} height={h} fill={entry.color} className="as-chart__seg" />;
                })}
                <title>{`${labels[index]}: ${format(sums[index] ?? 0)}`}</title>
                {index % labelEvery === 0 && (
                  <text x={pad.left + index * step + step / 2} y={height - 6} textAnchor="middle" className="as-chart__tick">{labels[index]}</text>
                )}
              </g>
            );
          })}
        </svg>
        {active && active.sum > 0 && (
          <div className="as-chart__tip" style={{ left: tipLeft, top: 0 }}>
            <div className="as-chart__tip-head">{labels[active.index]} · {format(active.sum)}</div>
            {series.filter((entry) => (active.column[entry.key] ?? 0) > 0).map((entry) => (
              <div key={entry.key} className="as-chart__tip-row">
                <span className="as-swatch" style={{ background: entry.color }} />
                <span>{entry.label}</span>
                <span>{format(active.column[entry.key] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {series.length > 0 && (
        <ul className="as-legend" aria-label="Legend">
          {series.map((entry) => (
            <li key={entry.key} className="as-legend__item">
              <span className="as-swatch" style={{ background: entry.color }} />
              <span className="as-legend__label" title={entry.label}>{entry.label}</span>
              <strong>{format(entry.total)}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
