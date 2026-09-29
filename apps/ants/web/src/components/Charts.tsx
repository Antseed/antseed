import { useEffect, useId, useRef, useState } from 'react';
import { ChartTooltip, type TooltipRow } from './ChartTooltip';
import { slotIndex, useChartHover } from './chart-hover';

export interface ChartSeries {
  key: string;
  name: string;
  /** Oldest first; `null` = no observation. */
  values: Array<bigint | null>;
  format: (value: bigint) => string;
  /** Axis tick formatter; defaults to `format`. */
  tick?: (value: bigint) => string;
  /** Fixed scale maximum (e.g. 10000n for basis points); otherwise the series maximum. */
  max?: bigint;
  /** Per-point flag rendered as a hollow (estimated) bar. */
  provisional?: boolean[];
}

interface Props {
  epochs: number[];
  bars: ChartSeries;
  line?: ChartSeries;
  title: string;
  height?: number;
  /** Compact = no axis titles, tighter margins (side panels). */
  compact?: boolean;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function seriesMax(series: ChartSeries): bigint {
  if (series.max !== undefined) return series.max;
  const known = series.values.filter((value): value is bigint => value !== null && value > 0n);
  const max = known.reduce((maximum, value) => (value > maximum ? value : maximum), 0n);
  return max === 0n ? 1n : max;
}

/**
 * Bars per epoch with an optional line on a second axis. Hovering anywhere over
 * the plot highlights that epoch's column and shows its exact values in a
 * tooltip; every mark also carries an accessible label for keyboard users.
 */
export function EpochBarChart({ epochs, bars, line, title, height = 200, compact = false }: Props) {
  const titleId = useId();
  const { ref, width } = useWidth(640);
  const left = compact ? 48 : 60;
  const right = line ? (compact ? 44 : 56) : 12;
  const top = 14;
  const bottom = 28;
  const plotWidth = Math.max(40, width - left - right);
  const plotHeight = height - top - bottom;
  const count = Math.max(1, epochs.length);
  const slot = plotWidth / count;
  const barWidth = Math.max(3, Math.min(28, slot * 0.58));
  const barMax = seriesMax(bars);
  const lineMax = line ? seriesMax(line) : 1n;
  const scale = (value: bigint, max: bigint) => Number((value * 1_000_000n) / max) / 1_000_000;
  const yBar = (value: bigint) => top + plotHeight - scale(value, barMax) * plotHeight;
  const yLine = (value: bigint) => top + plotHeight - scale(value, lineMax) * plotHeight;
  const xCenter = (index: number) => left + slot * index + slot / 2;
  const hasBars = bars.values.some((value) => value !== null);
  const hasLine = !!line && line.values.some((value) => value !== null);
  const ticks = [0, 1, 2, 3, 4];
  const tickCount = width < 480 ? 4 : 8;
  const tickStride = Math.max(1, Math.ceil(count / tickCount));
  const barTick = bars.tick ?? bars.format;
  const lineTick = line ? (line.tick ?? line.format) : null;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { hover, onPointerMove, onPointerLeave, setHover, clientPoint } = useChartHover(svgRef, width, height, (x) => slotIndex(x, left, slot, epochs.length));
  const focusIndex = (index: number) => setHover({ index });
  const hovered = hover?.index ?? null;
  const hoverRows: TooltipRow[] = [];
  if (hovered !== null) {
    const bar = bars.values[hovered];
    if (bar != null) hoverRows.push({ name: bars.name, value: bars.format(bar), color: 'var(--pc-accent)', note: bars.provisional?.[hovered] ? 'estimated' : undefined });
    const point = line?.values[hovered];
    if (line && point != null) hoverRows.push({ name: line.name, value: line.format(point), color: 'var(--pc-blue)' });
  }

  let linePath = '';
  if (line) {
    let previous: number | null = null;
    linePath = line.values.map((value, index) => {
      if (value === null) { previous = null; return ''; }
      const command = previous !== null && index === previous + 1 ? 'L' : 'M';
      previous = index;
      return `${command}${xCenter(index).toFixed(1)},${yLine(value).toFixed(1)}`;
    }).join(' ');
  }

  return (
    <div className="chart">
      <div className="chart-legend">
        <span className="chart-legend-item chart-legend-item--bars"><i />{bars.name}</span>
        {line ? <span className="chart-legend-item chart-legend-item--line"><i />{line.name}</span> : null}
      </div>
      <div ref={ref} className="chart-plot">
        {hasBars || hasLine ? (
          <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
            <title id={titleId}>{title}</title>
            {hovered !== null ? <g className="chart-hover" aria-hidden="true">
              <rect x={xCenter(hovered) - slot / 2} y={top} width={slot} height={plotHeight} className="chart-hover-band" />
              <line x1={xCenter(hovered)} x2={xCenter(hovered)} y1={top} y2={top + plotHeight} className="chart-crosshair" />
            </g> : null}
            {ticks.map((tick) => {
              const y = top + (plotHeight * tick) / 4;
              const barValue = (barMax * BigInt(4 - tick)) / 4n;
              const lineValue = (lineMax * BigInt(4 - tick)) / 4n;
              return (
                <g key={tick}>
                  <line x1={left} x2={left + plotWidth} y1={y} y2={y} className="chart-grid" />
                  <text x={left - 8} y={y + 4} textAnchor="end" className="chart-axis chart-axis--bars">{barTick(barValue)}</text>
                  {line && lineTick ? <text x={left + plotWidth + 8} y={y + 4} textAnchor="start" className="chart-axis chart-axis--line">{lineTick(lineValue)}</text> : null}
                </g>
              );
            })}
            <g className="chart-bars">
              {bars.values.map((value, index) => {
                if (value === null) return null;
                const provisional = bars.provisional?.[index] === true;
                const y = yBar(value);
                const label = `${bars.name}, epoch ${epochs[index]}: ${bars.format(value)}${provisional ? ' (estimated)' : ''}`;
                return (
                  <rect
                    key={epochs[index]}
                    x={xCenter(index) - barWidth / 2}
                    y={Math.min(y, top + plotHeight - 1)}
                    width={barWidth}
                    height={Math.max(1, top + plotHeight - y)}
                    rx={Math.min(3, barWidth / 3)}
                    className={`${provisional ? 'chart-bar chart-bar--provisional' : 'chart-bar'}${hovered === index ? ' chart-bar--hover' : ''}`}
                    tabIndex={0}
                    role="img"
                    aria-label={label}
                    onFocus={() => focusIndex(index)}
                    onBlur={onPointerLeave}
                  >
                    <title>{label}</title>
                  </rect>
                );
              })}
            </g>
            {line && hasLine ? (
              <g className="chart-line-group">
                <path d={linePath} className="chart-line" data-series={line.key} />
                {line.values.map((value, index) => {
                  if (value === null) return null;
                  const label = `${line.name}, epoch ${epochs[index]}: ${line.format(value)}`;
                  return (
                    <circle key={epochs[index]} cx={xCenter(index)} cy={yLine(value)} r={hovered === index ? 5 : 3.5} className="chart-dot" tabIndex={0} role="img" aria-label={label} onFocus={() => focusIndex(index)} onBlur={onPointerLeave}>
                      <title>{label}</title>
                    </circle>
                  );
                })}
              </g>
            ) : null}
            {epochs.map((epoch, index) => (index % tickStride === 0 || index === epochs.length - 1) ? (
              <text key={epoch} x={xCenter(index)} y={height - 8} textAnchor="middle" className="chart-axis chart-axis--x">{epoch}</text>
            ) : null)}
          </svg>
        ) : (
          <div className="chart-empty">No indexed data for these epochs.</div>
        )}
        {hovered !== null && hoverRows.length > 0 ? <ChartTooltip {...clientPoint(xCenter(hovered), top)} title={`Epoch ${epochs[hovered]}`} rows={hoverRows} /> : null}
      </div>
    </div>
  );
}
