import { useMemo, useState } from 'react';
import { fmt, fmtBoost } from '../lib/format';
import { useWeekPace, type Network } from '../lib/model';
import { earnEstimate, formatCountdown, pointsFromWeighted, projectRange } from '../lib/points';
import { useNow } from './Chrome';
import { PixelAnt } from './Ant';
import { ProviderPicker } from './ProviderPicker';
import { DownloadVpnButton } from './DownloadVpn';
import { InfoTip } from './InfoTip';

const PRESETS = [10, 50, 250, 1000];

/**
 * The hero's calculator, written to explain how points work as you use it:
 * $ spent × the provider's boost = points, then points × this week's rate = ANTS.
 */
export function HeroCalc({ net }: { net: Network | undefined }) {
  // Every provider people can use, highest boost first; 0× ones sink to the bottom.
  const choices = useMemo(
    () => (net ? [...net.providers].filter((p) => p.volumeUsd > 0 || p.boost > 0).sort((a, b) => b.boost - a.boost) : []),
    [net],
  );
  const [spend, setSpend] = useState(50);
  const [agentId, setAgentId] = useState<string | null>(null);
  // Default to the highest boost among providers online right now (listing models), so we never suggest an offline one.
  const p = choices.find((c) => c.agentId === agentId) ?? choices.find((c) => c.boost >= 0.01 && c.offers.length > 0) ?? choices[0];
  const boost = p && p.boost >= 0.01 ? p.boost : 0;
  const est = net && p ? earnEstimate(net.pots.buyer, net.totalBuyerWeighted, spend, boost) : null;
  // Live: re-run against the pot, the points so far and the exact time left, every 30 seconds.
  const now = useNow(30_000);
  const pace = useWeekPace(net, now);
  const range = net && pace && est
    ? projectRange({ potAnts: net.pots.buyer, totalPoints: pointsFromWeighted(net.totalBuyerWeighted), myPoints: est.points, alreadyCounted: false, ...pace })
    : null;

  return (
    <section className="hero-calc" aria-labelledby="hc-h">
      <div className="hc-top">
        <PixelAnt size={34} color="var(--green)" eyes="#001E12" seed hop />
        <h2 id="hc-h">What would you earn?</h2>
        <span className="pot-live"><i />{pace ? `${formatCountdown(pace.leftMs)} left` : 'This week'}</span>
      </div>
      <div className="hc-q">
        <span>If you spend</span>
        <div className="hc-opts">
          {PRESETS.map((v) => (
            <button key={v} type="button" className="hc-opt" aria-pressed={spend === v} onClick={() => setSpend(v)}>${v.toLocaleString('en-US')}</button>
          ))}
        </div>
      </div>
      <div className="hc-q">
        <span>with the provider</span>
        <ProviderPicker providers={choices} value={p} onChange={setAgentId} />
      </div>
      <div className="hc-steps" aria-live="polite">
        <div><span>${fmt(spend)} × {fmtBoost(boost)} boost</span><b className="num">{fmt(est?.points ?? 0)} points</b></div>
      </div>
      <div className="hc-total">
        <span>{fmt(est?.points ?? 0)} points ≈</span>
        <b className={`num${!net ? ' skeleton' : ''}`} style={{ color: boost === 0 && p ? '#F29A8C' : 'var(--seed)' }}>{fmt(range?.expected ?? est?.ants ?? 0)} ANTS</b>
      </div>
      <div className="hc-range" aria-label="Likely range">
        {range && range.now > 0 && (
          <div className="hc-bar"><i style={{ left: `${pct(range.low, range.now)}%`, right: 0 }} /><b style={{ left: `${pct(range.expected, range.now)}%` }} /></div>
        )}
        <div className="hc-range-l">
          <span className="hc-est">
            <b>Estimated reward this Thursday</b>
            <small>Based on current network activity. Your final reward changes as more points are earned.</small>
          </span>
          <InfoTip label="How this estimate works">
            <b>How the estimate works</b>
            Every Thursday at 09:54 UTC the week's {net ? fmt(net.pots.buyer) : ''} ANTS pot is shared out by points. Each point is worth less as more
            people spend before then, so we project the rest of the week from this week's pace.
            {range && range.now > 0 && <> The most it can be is {fmt(range.now)}: today's rate, if nobody else spent.</>} One wallet can take at most 5% of the pot.
          </InfoTip>
        </div>
      </div>
      <DownloadVpnButton className="btn btn-green hc-go" label="Download the AI VPN to start" />
    </section>
  );
}

/** Where `v` sits on a 0…max bar, as a percentage. */
const pct = (v: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
