import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { readNextWeekWeight } from '../lib/chain';
import { avatarColor, fmt, fmtBoost, fmtPerUsd, fmtUsd } from '../lib/format';
import { useWeekPace, type ModelOffer, type Network, type Provider } from '../lib/model';
import { boostFromWeight, pointsFromWeighted, projectRange } from '../lib/points';
import { discountPct, useListPrices } from '../lib/listPrices';
import { goToSection } from '../lib/router';
import { pickStakeProvider } from '../lib/stakePick';
import { useNow } from './Chrome';
import { DownloadVpnButton } from './DownloadVpn';

type Sort = 'boost' | 'points' | 'staker' | 'volume';
const SORTS: [Sort, string][] = [['boost', 'Highest boost'], ['points', 'Most points'], ['staker', 'Highest estimated staking rewards'], ['volume', 'Most paid usage']];
const KEY: Record<Sort, (p: Provider) => number> = { boost: (p) => p.boost, points: (p) => p.points, staker: (p) => p.stakerPer1k, volume: (p) => p.volumeUsd };
/** Rows shown before "Show all"; the page stays short for people who only want the top. */
const FIRST = 10;
const MODELS_SHOWN = 9;

/**
 * ANTS per $1 at the rate we expect by Thursday, for a given boost. Today's rate swings wildly
 * early in the week, when few points exist yet, so every "per $1" figure on the site uses this.
 */
export function useProjectedPerUsd(net: Network | undefined) {
  const pace = useWeekPace(net, useNow(60_000));
  return (boost: number) =>
    net && pace ? projectRange({ potAnts: net.pots.buyer, totalPoints: pointsFromWeighted(net.totalBuyerWeighted), myPoints: boost, alreadyCounted: false, ...pace }).expected : 0;
}

/** Every provider as a list; click one to see the models it serves, then use it or stake behind it. */
export function ProviderModels({ net }: { net: Network | undefined }) {
  const [sort, setSort] = useState<Sort>('boost');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const perUsd = useProjectedPerUsd(net);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const found = (net?.providers ?? []).filter((p) =>
      // Providers people can use: they serve models or had paying users this week.
      (p.offers.length > 0 || p.models.length > 0 || p.volumeUsd > 0) &&
      (!term || p.name.toLowerCase().includes(term) || p.offers.some((o) => o.name.toLowerCase().includes(term)) || p.models.some((m) => m.toLowerCase().includes(term))));
    // 0× providers sink to the bottom whatever the sort, since nobody earns there.
    return found.sort((a, b) => Number(b.boost >= 0.01) - Number(a.boost >= 0.01) || KEY[sort](b) - KEY[sort](a));
  }, [net, q, sort]);
  const shown = all || q ? list : list.slice(0, FIRST);

  return (
    <section id="providers" className="ag-sand" aria-labelledby="pm-h">
      <div className="wrap stack" style={{ gap: 22, paddingBlock: 96 }}>
        <div className="ag-head" style={{ marginBottom: 0 }}>
          <h2 id="pm-h" className="disp" style={{ color: 'var(--ink)' }}>Earn more points with your provider</h2>
          <p style={{ color: 'var(--slate)' }}>Find the models you use and compare provider boosts. Higher boosts earn more points per dollar of qualifying paid usage.</p>
        </div>
        <div className="pl2-card">
          <div className="pl2-tools">
            <label className="pl2-search">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              <input type="search" placeholder="Search providers or models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search providers or models" />
            </label>
            <div className="pl2-sort" role="group" aria-label="Sort">
              {SORTS.map(([k, l]) => <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}
            </div>
          </div>
          <div className="pl2">
            <div className="pl2-head"><span>Provider</span><span>Boost</span><span>Est. ANTS per $1 spent</span><span>Spent this week</span><span>Est. weekly ANTS per 1,000 staked</span><span /></div>
            {net && shown.map((p) => (
              <ProviderItem key={p.agentId} p={p} net={net} perUsd={perUsd(p.boost)} open={open === p.agentId} onToggle={() => setOpen(open === p.agentId ? null : p.agentId)} />
            ))}
            {!net && [0, 1, 2, 3].map((i) => <div key={i} className="pl2-item skeleton" style={{ height: 64 }} />)}
            {net && list.length === 0 && <p className="muted" style={{ margin: 0, padding: '20px 24px' }}>No providers match “{q}”.</p>}
          </div>
        </div>
        <div className="pm-end">
          {!q && list.length > FIRST && (
            <button type="button" className="btn btn-line" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${list.length} providers`}</button>
          )}
          <span>Est. ANTS per $1 spent projects this week's pace to Thursday. Est. weekly ANTS per 1,000 staked assumes max lock. 1.0× = 10,000 ANTS locked for two years.</span>
        </div>
      </div>
    </section>
  );
}

function ProviderItem({ p, net, perUsd, open, onToggle }: { p: Provider; net: Network; perUsd: number; open: boolean; onToggle: () => void }) {
  const zero = p.boost < 0.01;
  const count = p.offers.length || p.models.length;
  return (
    <div className="pl2-item" data-open={open}>
      <button type="button" className="pl2-row" aria-expanded={open} onClick={onToggle}>
        <span className="pl2-who">
          <span className="pl2-av" style={{ background: avatarColor(p.seller) }} aria-hidden="true">{initial(p.name)}</span>
          <span style={{ minWidth: 0 }}>
            <b>{p.name}</b>
            <small>{count ? `${count} model${count === 1 ? '' : 's'}` : 'Offline right now'}{zero ? ' · nothing staked, earns no points' : ''}</small>
          </span>
        </span>
        <span className={`pl2-boost${zero ? ' zero' : p.boost >= 5 ? ' hot' : ''}`}>{zero ? '0×' : fmtBoost(p.boost)}</span>
        <span className="num hide-s pl2-per">{zero ? '—' : `≈ ${fmtPerUsd(perUsd)}`}</span>
        <span className="num hide-s">{p.volumeUsd >= 0.005 ? fmtUsd(p.volumeUsd) : '—'}</span>
        <span className="num hide-s">{p.stakerPer1k >= 0.5 ? `≈ ${fmt(p.stakerPer1k)}/wk` : '—'}</span>
        <svg className="pl2-chev" width="16" height="16" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && <ProviderMore p={p} net={net} />}
    </div>
  );
}

function ProviderMore({ p, net }: { p: Provider; net: Network }) {
  const [allModels, setAllModels] = useState(false);
  const list = useListPrices();
  const next = useQuery({ queryKey: ['next-weight', p.agentId, net.epoch], queryFn: () => readNextWeekWeight(p.agentId, net.epoch), staleTime: 120_000 });
  const nextBoost = next.data !== undefined ? boostFromWeight(next.data) : null;
  // Paid models first (free ones earn no points), cheapest first; plain names when the marketplace has no prices.
  const offers: ModelOffer[] = p.offers.length ? p.offers : p.models.map((m) => ({ id: m, name: m, inputUsdPerMillion: 0, outputUsdPerMillion: 0, free: false }));
  const priced = p.offers.length > 0;
  const shown = allModels ? offers : offers.slice(0, MODELS_SHOWN);
  const notes = [
    priced ? 'Prices per million input / output tokens' : '',
    priced && list.data ? 'discounts compare the input price with the official list price' : '',
    nextBoost !== null && Math.abs(nextBoost - p.boost) >= 0.05 ? `Next week ${fmtBoost(nextBoost)}` : '',
    p.stakeAnts > 0 ? `${fmt(p.stakeAnts)} ANTS staked` : '',
  ].filter(Boolean);
  const stakeHere = () => {
    pickStakeProvider(p.agentId);
    goToSection('stake');
  };
  return (
    <div className="pl2-more">
      {offers.length > 0 ? (
        <div className="pl2-models">
          {shown.map((m) => (
            <span key={m.id}>
              <b>{m.name}</b>
              {m.free ? <em>Free, no points</em> : priced && (
                <span className="pl2-price">
                  {discountPct(m.id, m.name, m.inputUsdPerMillion, list.data) !== null && <i className="pl2-off">−{discountPct(m.id, m.name, m.inputUsdPerMillion, list.data)}%</i>}
                  <small className="num">{price(m)}</small>
                </span>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>{p.name} isn't online on the network right now, so its models aren't showing. The marketplace only lists providers that are online; check back soon.</p>
      )}
      <div className="pl2-foot">
        <span>
          {offers.length > MODELS_SHOWN && (
            <>
              <button type="button" className="yp-link" onClick={() => setAllModels((v) => !v)}>{allModels ? 'Show fewer models' : `Show all ${offers.length} models`}</button>
              {notes.length ? ' · ' : ''}
            </>
          )}
          {notes.join(' · ')}
        </span>
        <DownloadVpnButton className="btn btn-ink btn-sm" label="Download the AI VPN" phoneLabel="Get the AI VPN" />
        <button type="button" className="btn btn-line btn-sm" onClick={stakeHere}>Stake here</button>
      </div>
    </div>
  );
}

const initial = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase();
const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : fmt(v)}`;
/** Price per million input · output tokens. */
const price = (m: ModelOffer) => `${usd(m.inputUsdPerMillion)} / ${usd(m.outputUsdPerMillion)}`;
