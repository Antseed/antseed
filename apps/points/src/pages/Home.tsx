import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PixelAnt } from '../components/Ant';
import { HeroCalc } from '../components/HeroCalc';
import { HeroTabs } from '../components/HeroTabs';
import { useNow } from '../components/Chrome';
import { ProviderModels, useProjectedPerUsd } from '../components/ProviderModels';
import { HowPoints } from '../components/HowPoints';
import { LeaderboardSection } from '../components/LeaderboardSection';
import { LantsSection } from '../components/LantsSection';
import { StakeSection } from '../components/StakeSection';
import { StartSteps } from '../components/StartSteps';
import { YourPoints } from '../components/YourPoints';
import { useViewedAddress } from '../lib/address';
import { fmt, fmtBoost, fmtCents, fmtK, fmtUsd, isAddress, shortAddress } from '../lib/format';
import { FIRST_REWARDED_EPOCH, useSettlements, useWeeks, type Network } from '../lib/model';
import { epochEndMs, formatCountdown, pointsFromWeighted } from '../lib/points';
import { goToSection, useInitialSection } from '../lib/router';

export function AddressLookup({ cta = 'See my points', dark = false }: { cta?: string; dark?: boolean }) {
  const { address, setAddress } = useViewedAddress();
  const [value, setValue] = useState(address ?? '');
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isAddress(value)) return setBad(true);
    setBad(false);
    setAddress(value);
    goToSection('me');
  };
  return (
    <>
    <form className={`lookup${dark ? ' dark' : ''}`} onSubmit={submit} role="search" aria-label="Look up points by Antseed account address">
      
      <input
        id="lookup-input"
        value={value}
        onChange={(e) => { setValue(e.target.value.trim()); setBad(false); }}
        placeholder="Paste your Antseed account address (0x…)"
        aria-label="Antseed account address"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad}
        aria-describedby={bad ? 'lookup-error' : undefined}
      />
      <button type="submit" className={`btn ${dark ? 'btn-green' : 'btn-ink'}`}>{cta}</button>
    </form>
    {bad && <span id="lookup-error" className="lookup-error" role="alert">Enter a valid address beginning with 0x.</span>}
    </>
  );
}

const ago = (sec: number, now: number) => {
  const m = Math.max(0, Math.round((now / 1000 - sec) / 60));
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};
const dayMonth = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function Home({ net }: { net: Network | undefined }) {
  useInitialSection();
  const now = useNow(1000);
  const left = net ? formatCountdown(epochEndMs(net.epoch) - now) : '…';
  const points = net ? pointsFromWeighted(net.totalBuyerWeighted) : 0;
  // What one point is worth by Thursday at this week's pace (today's rate overshoots early in the week).
  const perPoint = useProjectedPerUsd(net)(1);
  // The pot people using AI share (providers and stakers have their own), rounded to the thousand.
  const buyerPot = net ? fmt(Math.round(net.pots.buyer / 1000) * 1000) : '250,000';

  return (
    <>
      <section className="ag-hero" aria-labelledby="hero-h">
        <div className="wrap ag-hero-g">
          <div className="stack" style={{ gap: 24 }}>
            <h1 id="hero-h" className="disp ag-h1">The network that rewards{' '}<br />you for using AI</h1>
            <p className="ag-lead">Spend on AI through Antseed and earn points. Every Thursday, {buyerPot} ANTS are shared out between everyone who used it.</p>
            <HeroTabs />
          </div>
          <HeroCalc net={net} />
        </div>
      </section>

      <section className="ag-dark ag-strip" aria-label="This week so far">
        <div className="marcher hide-s" aria-hidden="true"><div className="px-march"><PixelAnt size={44} color="var(--green)" eyes="#001E12" seed hop /></div></div>
        <div className="wrap ag-stats">
          <span><b style={{ color: 'var(--seed)' }}>{net ? fmt(net.pots.buyer) : '…'}</b> ANTS this week</span>
          <span><b>{net ? `≈ ${fmt(perPoint, perPoint < 100 ? 1 : 0)}` : '…'}</b> ANTS per point</span>
          <span><b>{left}</b> left</span>
          <span><b>{fmt(points)}</b> points earned this week</span>
          <span><b>{net?.buyersThisEpoch != null ? fmt(net.buyersThisEpoch) : '…'}</b> buyers</span>
          <span><b>{net ? fmtUsd(net.volumeUsd) : '…'}</b> spent on AI</span>
        </div>
      </section>

      <YourPoints net={net} />

      <section id="leaderboard" className="ag-dark" aria-labelledby="top-h">
        <div className="wrap" style={{ paddingBlock: '56px 80px' }}>
          <LeaderboardSection net={net} now={now} ticker={<LandingTicker net={net} now={now} />} />
        </div>
      </section>

      <ProviderModels net={net} />

      <StartSteps />

      <StakeSection net={net} />

      <LantsSection net={net} />

      <Weeks net={net} perPoint={perPoint} />

      <HowPoints net={net} />


    </>
  );
}

function Weeks({ net, perPoint }: { net: Network | undefined; perPoint: number }) {
  // Every week since rewards began, oldest first; the slider opens on the latest.
  const weeks = useWeeks(net, net ? net.epoch - FIRST_REWARDED_EPOCH + 1 : 4);
  const rows = weeks.data ?? [];
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const update = () => {
    const el = track.current;
    if (el) setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(() => {
    const el = track.current;
    if (!el || !rows.length) return;
    el.scrollLeft = el.scrollWidth;
    update();
  }, [rows.length]);
  const slide = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };
  return (
    <section className="ag-green" aria-labelledby="weeks-h">
      <div className="wrap" style={{ paddingBlock: 96 }}>
        <div className="ag-head-row">
          <div className="ag-head">
            <h2 id="weeks-h" className="disp" style={{ color: 'var(--ink)' }}>Week by week</h2>
            <p style={{ color: 'var(--ink)' }}>See the ANTS-per-point rate for each completed week. Rates depend on the reward pool and total points earned that week.</p>
          </div>
          <div className="wk-arrows">
            <button type="button" aria-label="Earlier weeks" disabled={edge.start} onClick={() => slide(-1)}>←</button>
            <button type="button" aria-label="Later weeks" disabled={edge.end} onClick={() => slide(1)}>→</button>
          </div>
        </div>
        <div className="wk-track" ref={track} onScroll={update}>
          {rows.map((w) => {
            const rate = w.live ? perPoint : w.rate;
            return (
              <div key={w.epoch} className="week" data-live={w.live}>
                <span className="week-name">{w.live ? 'This week' : `${dayMonth(w.startMs)} – ${dayMonth(w.endMs)}`}</span>
                <span className="week-rate num">{w.live ? '≈ ' : ''}{rate >= 10_000 ? fmtK(rate) : fmt(rate, rate < 100 ? 1 : 0)} <small>ANTS</small></span>
                <span className="week-per">{w.live ? 'per point, estimated by Thursday' : 'per point'}</span>
                <span className="week-sub">
                  {w.live ? `${fmtUsd(w.spentUsd)} spent so far` : `${fmtUsd(w.spentUsd)} spent that week`}
                  {/* The first weeks had almost nothing staked, so almost no points: say so, or the number looks like a bug. */}
                  {!w.live && w.points < 10 ? ` · rate before the per-account cap, only ${fmt(w.points, 2)} points earned` : ''}
                </span>
              </div>
            );
          })}
          {net && (
            <div className="week" data-next="true">
              <span className="week-name">Next week</span>
              <span className="week-rate num">?</span>
              <span className="week-per">starts Thursday, 09:54 UTC</span>
            </div>
          )}
          {weeks.isLoading && <p className="note">Loading past weeks…</p>}
        </div>
      </div>
    </section>
  );
}

/** Payments landing right now, as a ticker running along the top of the leaderboard. */
function LandingTicker({ net, now }: { net: Network | undefined; now: number }) {
  const s = useSettlements(net, 12);
  const rows = s.data ?? [];
  return (
    <div className="ticker-wrap" aria-label="Recent activity">
      <span className="ticker-lbl"><i className="pot-live-dot" />Recent activity</span>
      <div className="ticker-view">
        <div className="ticker">
          {[...rows, ...rows].map((r, i) => (
            <a key={`${r.tx}-${i}`} className="tick-item" href={`https://basescan.org/tx/${r.tx}`} target="_blank" rel="noreferrer" aria-hidden={i >= rows.length}>
              <b style={{ color: '#fff' }}>{r.provider}</b>
              <span className="muted-d">{shortAddress(r.buyer)} · {ago(r.timestamp, now)}</span>
              <b className="num" style={{ color: r.boost < 0.01 ? '#F29A8C' : 'var(--green)' }}>{r.boost < 0.01 ? '0×, no points' : `+${fmt(r.points, 2)} pts`}</b>
              <span className="muted-d">{r.boost < 0.01 ? '' : `${fmtBoost(r.boost)} on ${fmtCents(r.usd)}`}</span>
            </a>
          ))}
          {s.isLoading && <span className="muted-d">Loading…</span>}
        </div>
      </div>
    </div>
  );
}
