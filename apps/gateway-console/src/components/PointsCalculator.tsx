import { useEffect, useMemo, useState } from 'react'
import type { Peer, RewardsPoints } from '../api/types'
import { BOOST_EARNING_MIN, formatAntsAmount, formatBoost, formatPoints } from '../lib/format'
import { isPaidPeer } from '../lib/peers'
import { usePeers } from '../lib/queries'
import { formatCountdown, weekEstimate } from '../../../ants/src/service/points-math'
import { Panel, SelectField } from './ui'

const PRESETS = [10, 50, 250, 1000]

function providerName(peer: Peer): string {
  return peer.displayName ?? `${peer.peerId.slice(0, 8)}…`
}

const ants = formatAntsAmount

/** Where `value` sits on a 0…max bar, as a percentage. */
const pct = (value: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0)

/** Re-renders every `ms`, so the time left and the projection stay live. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [ms])
  return now
}

/**
 * "What would you earn?", the Points site's calculator, starting from this
 * buyer wallet's points so far: $ spent × the provider's boost = points, then
 * points × this week's rate = ANTS, projected to the week's close from this
 * week's pace. The math is the shared `weekEstimate`, so the numbers match the
 * site and the AI VPN.
 */
export function PointsCalculator({ points }: { points: RewardsPoints }) {
  const peers = usePeers()
  // Paid providers with a known boost, highest first; 0× ones sink to the bottom. Free usage earns nothing.
  const providers = useMemo(() => (peers.data ?? [])
    .filter((peer) => isPaidPeer(peer) && peer.boost !== null)
    .sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0)), [peers.data])
  const [spend, setSpend] = useState(50)
  const [peerId, setPeerId] = useState<string | null>(null)
  const now = useNow(30_000)
  if (points.potAnts === null || points.totalPoints === null) return null
  const provider = providers.find((peer) => peer.peerId === peerId) ?? providers[0] ?? null
  const boost = provider?.boost !== null && provider?.boost !== undefined && provider.boost >= BOOST_EARNING_MIN ? provider.boost : 0
  const week = weekEstimate({
    potAnts: points.potAnts, totalPoints: points.totalPoints, myPoints: points.points, spendUsd: spend, boost,
    startsAt: points.startsAt, endsAt: points.endsAt, busyPointsPerDay: points.busyPointsPerDay, now,
  })
  const closes = points.endsAt ? new Date(points.endsAt).toLocaleDateString('en-US', { weekday: 'long' }) : 'the end of the week'
  const range = week.range

  return (
    <Panel>
      <section className="gc-hc" aria-labelledby="gc-hc-title">
        <div className="gc-hc__top">
          <h3 id="gc-hc-title">What would you earn?</h3>
          <span className="gc-hc__live"><i aria-hidden="true" />{week.leftMs !== null ? `${formatCountdown(week.leftMs)} left` : 'This week'}</span>
        </div>
        <div className="gc-hc__q">
          <span>If this workspace spends</span>
          <div className="gc-hc__opts" role="group" aria-label="Spend">
            {PRESETS.map((value) => (
              <button key={value} type="button" className="gc-hc__opt" aria-pressed={spend === value} onClick={() => setSpend(value)}>
                ${value.toLocaleString('en-US')}
              </button>
            ))}
          </div>
        </div>
        <div className="gc-hc__q">
          <span>with the provider</span>
          {providers.length > 0
            ? <SelectField size="sm" aria-label="Provider" value={provider?.peerId ?? ''} onChange={setPeerId}
                options={providers.map((peer) => ({ value: peer.peerId, label: `${providerName(peer)} · ${formatBoost(peer.boost)}` }))} />
            : <p className="gc-fineprint">No paid provider has a boost right now, so more spend earns no points.</p>}
        </div>
        <div className="gc-hc__steps" aria-live="polite">
          <div><span>${spend.toLocaleString('en-US')} × {formatBoost(boost)} boost</span><b>{formatPoints(week.addedPoints)} points</b></div>
          {points.points > 0 && <div><span>+ {formatPoints(points.points)} points you have this week</span><b>{formatPoints(week.points)} points</b></div>}
          <div>
            <span>{formatPoints(week.points)} points × {week.antsPerPoint.toLocaleString('en-US', { maximumFractionDigits: 2 })} ANTS each right now</span>
            <b>{week.capped ? 'capped at 5%' : `${ants(week.now)} ANTS`}</b>
          </div>
        </div>
        <div className="gc-hc__total">
          <span>By {closes}, about</span>
          <b className={boost === 0 ? 'gc-hc__zero' : undefined}>{ants(range?.expected ?? week.now)} ANTS</b>
        </div>
        {range && range.now > 0 && (
          <div className="gc-hc__range" aria-label="Likely range">
            <div className="gc-hc__bar"><i style={{ left: `${pct(range.low, range.now)}%`, right: 0 }} /><b style={{ left: `${pct(range.expected, range.now)}%` }} /></div>
            <div className="gc-hc__range-l"><span>Likely {ants(range.low)} – {ants(range.now)} ANTS</span><span>{ants(range.now)} is the most: today's rate</span></div>
          </div>
        )}
        <p className="gc-fineprint">
          {points.endsAt ? `Every ${closes}` : 'At the end of each week'} the week's pot is shared out by points. Each point is worth less as more people spend before then, so this projects the rest of the week from this week's pace.
        </p>
      </section>
    </Panel>
  )
}
