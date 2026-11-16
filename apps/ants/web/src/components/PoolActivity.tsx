import { useEffect, useId, useRef, useState } from 'react';
import { ChartTooltip, type TooltipRow } from './ChartTooltip';
import { nearestIndex, useChartHover } from './chart-hover';
import type { EpochVolume, SellerModelsView } from '../../../src/api-types';
import { api } from '../api';
import { usePageData } from '../data';
import { formatBps, formatInt, formatUsdc, formatUsdcCompact, formatUtc, toBigInt } from '../format';
import { Pill } from './Pill';

export function activityPoints(volumes: EpochVolume[], networkVolumes: EpochVolume[], currentEpoch: number) {
  const network = new Map(networkVolumes.map(row => [row.epoch, toBigInt(row.usdc)]));
  return volumes.filter(row => row.epoch < currentEpoch).sort((first, second) => first.epoch - second.epoch).map(row => {
    const volume = toBigInt(row.usdc);
    const total = network.get(row.epoch);
    return { epoch: row.epoch, volume: volume !== null && volume >= 0n ? volume : null, network: total ?? null,
      share: volume !== null && volume >= 0n && total != null && total > 0n && volume <= total ? volume * 10000n / total : null };
  });
}

function EpochChart({ points }: { points: ReturnType<typeof activityPoints> }) {
  const titleId = useId();
  const plot = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!plot.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);
  const values = points.flatMap(point => point.volume === null ? [] : [point.volume]);
  const maximum = values.reduce((maximum, value) => value > maximum ? value : maximum, 0n) || 1000000n;
  const shareAvailable = points.some(point => point.share !== null);
  const left = 64;
  const right = width - 64;
  const firstEpoch = points[0]?.epoch ?? 0;
  const lastEpoch = points.at(-1)?.epoch ?? firstEpoch;
  const coordinateX = (epoch: number) => firstEpoch === lastEpoch ? width / 2 : left + (epoch - firstEpoch) / (lastEpoch - firstEpoch) * (right - left);
  const coordinateY = (value: bigint, scale: bigint) => 218 - Number(value * 1000000n / scale) / 1000000 * 180;
  const series = [
    { key: 'volume' as const, name: 'Settled volume', scale: maximum, format: (value: bigint) => `${formatUsdc(String(value))} USDC` },
    { key: 'share' as const, name: 'Network volume share', scale: 10000n, format: (value: bigint) => formatBps(Number(value)) },
  ];
  const pathFor = (key: 'volume' | 'share', scale: bigint) => {
    let previous: number | null = null;
    return points.map(point => {
      const value = point[key];
      if (value === null) { previous = null; return ''; }
      const command = previous !== null && point.epoch === previous + 1 ? 'L' : 'M';
      previous = point.epoch;
      return `${command}${coordinateX(point.epoch)},${coordinateY(value, scale)}`;
    }).join(' ');
  };
  const tickCount = width < 500 ? 3 : 6;
  const tickStride = Math.max(1, Math.ceil((points.length - 1) / (tickCount - 1)));
  const svgRef = useRef<SVGSVGElement | null>(null);
  const xs = points.map(point => coordinateX(point.epoch));
  const { hover, onPointerMove, onPointerLeave, setHover, clientPoint } = useChartHover(svgRef, width, 270, (x) => nearestIndex(x, xs));
  const hovered = hover !== null ? points[hover.index] ?? null : null;
  const hoverRows: TooltipRow[] = [];
  if (hovered) {
    if (hovered.volume !== null) hoverRows.push({ name: 'Settled volume', value: `${formatUsdc(String(hovered.volume))} USDC`, color: 'var(--pc-accent)' });
    if (hovered.network !== null) hoverRows.push({ name: 'Network volume', value: `${formatUsdc(String(hovered.network))} USDC`, color: 'var(--pc-sub)' });
    if (hovered.share !== null) hoverRows.push({ name: 'Network share', value: formatBps(Number(hovered.share)), color: 'var(--pc-blue)' });
  }
  return <div className="pool-chart">
    <div className="pool-chart-legend"><h4><span className="pool-chart-dot" />Settled volume · left axis</h4><h4 className="pool-chart--share"><span className="pool-chart-dot" />Network volume share · right axis</h4></div>
    <div ref={plot} className="pool-chart-plot">
      {values.length ? <svg ref={svgRef} viewBox={`0 0 ${width} 270`} role="img" aria-labelledby={titleId} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
        <title id={titleId}>Settled volume and network volume share by completed epoch. USDC on the left axis; 0–100% on the right axis. Hover anywhere over the chart for that epoch's values.</title>
        {hovered ? <line x1={coordinateX(hovered.epoch)} x2={coordinateX(hovered.epoch)} y1={38} y2={218} className="chart-crosshair" aria-hidden="true" /> : null}
        <text x={left} y="16" className="pool-chart-axis-volume">USDC</text><text x={right} y="16" textAnchor="end" className="pool-chart-axis-share">Share · %</text>
        {[0, 1, 2, 3, 4].map(tick => <g key={tick}>
          <line x1={left} x2={right} y1={38 + tick * 45} y2={38 + tick * 45} className="pool-chart-grid" />
          <text x={left - 9} y={42 + tick * 45} textAnchor="end" className="pool-chart-axis-volume">{formatUsdcCompact(String(maximum * BigInt(4 - tick) / 4n))}</text>
          <text x={right + 9} y={42 + tick * 45} textAnchor="start" className="pool-chart-axis-share">{100 - tick * 25}%</text>
        </g>)}
        {series.map(line => <g key={line.key} className={line.key === 'share' ? 'pool-chart--share' : undefined}>
          {points.some(point => point[line.key] !== null) && <path d={pathFor(line.key, line.scale)} className="pool-chart-line" data-series={line.key} />}
          {points.map((point, index) => {
            const value = point[line.key];
            if (value === null) return null;
            const label = `${line.name}, epoch ${point.epoch}: ${line.format(value)}`;
            return <circle key={point.epoch} cx={coordinateX(point.epoch)} cy={coordinateY(value, line.scale)} r={hovered === point ? 5.5 : 4} tabIndex={0} role="img" aria-label={label} onFocus={() => setHover({ index })} onBlur={onPointerLeave}><title>{label}</title></circle>;
          })}
        </g>)}
        {points.filter((_, index) => index % tickStride === 0 || index === points.length - 1).map(point => <text key={point.epoch} x={coordinateX(point.epoch)} y="242" textAnchor="middle">{point.epoch}</text>)}
        <text x={width / 2} y="265" textAnchor="middle">Epoch</text>
      </svg> : <div className="pool-chart-empty">Settlement volume unavailable for completed epochs.</div>}
      {hovered && hoverRows.length > 0 ? <ChartTooltip {...clientPoint(coordinateX(hovered.epoch), 38)} title={`Epoch ${hovered.epoch}`} rows={hoverRows} /> : null}
    </div>
    {values.length > 0 && !shareAvailable && <p className="hint">Network share unavailable for these epochs.</p>}
  </div>;
}

export function PoolActivity({ volumes, networkVolumes, currentEpoch }: { volumes: EpochVolume[]; networkVolumes: EpochVolume[]; currentEpoch: number }) {
  const points = activityPoints(volumes, networkVolumes, currentEpoch);
  return <>
    <EpochChart points={points} />
    <p className="hint">Network share = seller settled volume ÷ total network settled volume in the same epoch. The right axis stays at 0–100%; each line uses its own units. Missing observations leave gaps; a missing or zero network total is not a 0% share.</p>
  </>;
}

export function uniqueAdvertisedModels(offerings: SellerModelsView['offerings']) {
  const models = new Map<string, { name: string; providers: string[] }>();
  for (const offering of offerings) {
    const name = offering.name.trim();
    const key = name.toLowerCase();
    const model = models.get(key) ?? { name, providers: [] };
    if (!model.providers.includes(offering.provider)) model.providers.push(offering.provider);
    models.set(key, model);
  }
  return [...models.values()];
}

export function SellerModels({ address }: { address: string | null }) {
  const models = usePageData(address ? `seller-models:${address}` : null, () => api.sellerModels(address!));
  const data = models.data;
  return <section className="pool-section">
    <div className="pool-section-heading"><h3>Models &amp; usage</h3><span className="small muted">Sourced from Antscan</span></div>
    {!address ? <p className="hint">Bind a seller to see its model catalog.</p> : !data ? models.error ? <div role="status">
      <p className="hint">Model data could not load. Pool statistics remain available.</p>
      <p className="hint">{models.error}</p>
      <button type="button" className="link-button" onClick={models.refresh} disabled={models.loading}>Retry model data</button>
    </div> : <p className="hint">Loading provider models and last-epoch usage…</p> : <>
      {models.error && <p className="hint">Model data could not refresh. Showing the previously loaded snapshot.</p>}
      <h4 className="pool-subheading">Observed model usage <span className="small muted">Last completed epoch{data.period ? ` · Epoch ${data.period.epoch}` : ''}</span></h4>
      {data.usageStatus === 'unavailable' ? <div role="status"><p className="hint">{data.usageError ?? 'Model usage is unavailable.'}</p><button type="button" className="link-button" onClick={models.refresh} disabled={models.loading}>Retry model data</button></div> : data.usage.length ? <div className="table-wrap" tabIndex={0} role="region" aria-label="Observed model usage"><table className="table pool-model-table">
        <thead><tr><th>Model</th><th className="num">Requests</th><th className="num">Input tokens</th><th className="num">Output tokens</th><th className="num">Volume · USDC</th></tr></thead>
        <tbody>{data.usage.map(model => <tr key={model.serviceId}><td>{model.name}</td><td className="num">{formatInt(model.requests)}</td><td className="num">{formatInt(model.inputTokens)}</td><td className="num">{formatInt(model.outputTokens)}</td><td className="num">{formatUsdc(model.volumeUsdc)}</td></tr>)}</tbody>
      </table></div> : <p className="hint">No indexed model usage for this seller in this epoch.</p>}
      {data.totals && <p className="hint">Settled volume: {formatUsdc(data.totals.settledVolumeUsdc)} USDC · Model-attributed: {formatUsdc(data.totals.attributedVolumeUsdc)} USDC · Unattributed: {data.totals.unattributedVolumeUsdc === null ? 'unavailable (model totals exceed settlements)' : `${formatUsdc(data.totals.unattributedVolumeUsdc)} USDC`}</p>}
      <section className="pool-catalog" aria-label="Advertised models">
        <h4 className="pool-subheading">Advertised models <span className="small muted">{data.catalogStatus === 'live' ? 'Latest discovered catalog' : data.catalogStatus === 'stale' ? 'Stale catalog' : 'Unavailable'}</span></h4>
        <p className="hint">Seller-advertised models, not a guarantee of availability.</p>
        {data.catalogStatus === 'unavailable' ? <p className="hint">Antscan model catalog is unavailable.</p> : data.offerings.length ? <ul className="pool-model-tags" aria-label="Advertised model names">
          {uniqueAdvertisedModels(data.offerings).map(model => <li key={model.name}><Pill title={`Providers: ${model.providers.join(', ')}`}>{model.name}</Pill></li>)}
        </ul> : <p className="hint">No advertised models found in Antscan’s catalog.</p>}
        {data.catalogUpdatedAt !== null && <p className="small muted">Catalog snapshot {formatUtc(Math.floor(data.catalogUpdatedAt / 1000))}</p>}
      </section>
    </>}
  </section>;
}
