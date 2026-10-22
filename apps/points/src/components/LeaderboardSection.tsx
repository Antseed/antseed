import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { antscan } from '../lib/antscan';
import { useViewedAddress } from '../lib/address';
import { fmt, fmtBoost, fmtUsd, shortAddress } from '../lib/format';
import { useWeekPace, type Network } from '../lib/model';
import { antsFromWei, pointsFromWeighted, projectRange, usageReward, usdFromUsdc } from '../lib/points';
import { useProfiles } from '../lib/social';
import { Who } from './Social';

type Board = 'buyers' | 'providers' | 'stakers';
type Period = 'week' | 'all';
interface Row { key: string; who: ReactNode; c3: ReactNode; c4: ReactNode; c5: ReactNode; me: boolean }

/** The leaderboard, in place on the home page: buyers, providers or stakers; this week or all time; top 10 or 50. */
export function LeaderboardSection({ net, now, ticker }: { net: Network | undefined; now: number; ticker?: ReactNode }) {
  const [board, setBoard] = useState<Board>('buyers');
  const [period, setPeriod] = useState<Period>('week');
  const [limit, setLimit] = useState(10);
  const { address } = useViewedAddress();
  const pace = useWeekPace(net, now);
  const epoch = net?.epoch ?? 0;
  const allTime = board === 'buyers' && period === 'all';

  const buyers = useQuery({ queryKey: ['lb-buyers', epoch, limit], queryFn: () => antscan.topBuyers(epoch, limit), enabled: Boolean(net) && board === 'buyers' && !allTime });
  const buyersAll = useQuery({ queryKey: ['lb-buyers-all', limit], queryFn: () => antscan.topBuyersAllTime(limit), enabled: allTime });
  const sellers = useQuery({ queryKey: ['lb-sellers', epoch, limit], queryFn: () => antscan.topSellers(epoch, limit), enabled: Boolean(net) && board === 'providers' });
  const stakers = useQuery({ queryKey: ['lb-stakers'], queryFn: () => antscan.openPositions(500), enabled: board === 'stakers' });

  const stakerRows = (() => {
    const by = new Map<string, { owner: string; ants: number; positions: number; maxLocked: number }>();
    for (const p of stakers.data ?? []) {
      const r = by.get(p.owner) ?? { owner: p.owner, ants: 0, positions: 0, maxLocked: 0 };
      r.ants += antsFromWei(p.amount);
      r.positions += 1;
      if (p.maxLocked) r.maxLocked += 1;
      by.set(p.owner, r);
    }
    return [...by.values()].sort((a, b) => b.ants - a.ants).slice(0, limit);
  })();

  const wallets =
    board === 'buyers' ? (allTime ? (buyersAll.data ?? []).map((b) => b.address) : (buyers.data ?? []).map((b) => b.buyer))
    : board === 'stakers' ? stakerRows.map((s) => s.owner)
    : [];
  const profiles = useProfiles(wallets).data ?? {};
  const who = (a: string) => <Who address={a} profile={profiles[a.toLowerCase()]} />;
  const isMe = (a: string) => Boolean(address && a.toLowerCase() === address);
  const total = net ? pointsFromWeighted(net.totalBuyerWeighted) : 0;
  const providers = new Map(net?.providers.map((p) => [p.agentId, p]) ?? []);

  let head: [string, string, string, string];
  let rows: Row[];
  if (board === 'buyers' && !allTime) {
    head = ['Buyer', 'Spent', 'Points', 'Estimated ANTS'];
    rows = (buyers.data ?? []).map((b) => {
      const r = usageReward(net?.pots.buyer ?? 0, b.weightedPoints, net?.totalBuyerWeighted);
      const range = net && pace ? projectRange({ potAnts: net.pots.buyer, totalPoints: total, myPoints: pointsFromWeighted(b.weightedPoints), alreadyCounted: true, ...pace }) : null;
      // The 5% cap, judged on the Thursday estimate: today's rate overshoots early in the week.
      const capped = range ? range.expected >= (net?.pots.buyer ?? 0) * 0.05 - 0.5 : r.capped;
      return {
        key: b.buyer, me: isMe(b.buyer), who: who(b.buyer),
        c3: fmtUsd(usdFromUsdc(b.volumeUsdc)), c4: fmt(pointsFromWeighted(b.weightedPoints)),
        c5: (
          <span className="lb-ants">
            <b>{fmt(range?.expected ?? r.ants)}{capped && <small> · cap</small>}</b>
            {range && range.low < range.now - 0.5 && <small>likely {fmt(range.low)} – {fmt(range.now)}</small>}
          </span>
        ),
      };
    });
  } else if (allTime) {
    head = ['Buyer', 'Spent on Antseed', '', 'Points, all time'];
    rows = (buyersAll.data ?? []).map((b) => ({
      key: b.address, me: isMe(b.address), who: who(b.address),
      c3: fmtUsd(usdFromUsdc(b.spentUsdc)), c4: '', c5: <b className="num">{fmt(usdFromUsdc(b.buyerPoints))}</b>,
    }));
  } else if (board === 'providers') {
    head = ['Provider', 'Served', 'Points', 'Boost'];
    rows = (sellers.data ?? []).map((s) => {
      const p = providers.get(s.agentId);
      const boost = p?.boost ?? 0;
      return {
        key: s.seller + s.agentId, me: isMe(s.seller), who: <b style={{ color: '#fff' }}>{p?.name ?? shortAddress(s.seller)}</b>,
        c3: fmtUsd(usdFromUsdc(s.volumeUsdc)), c4: fmt(pointsFromWeighted(s.weightedPoints)),
        c5: <span className={`boost-tag${boost < 0.01 ? ' zero' : ''}`}>{boost < 0.01 ? '0×' : fmtBoost(boost)}</span>,
      };
    });
  } else {
    head = ['Staker', 'Positions', 'Max-locked', 'ANTS staked'];
    rows = stakerRows.map((s) => ({
      key: s.owner, me: isMe(s.owner), who: who(s.owner),
      c3: fmt(s.positions), c4: fmt(s.maxLocked), c5: <b className="num" style={{ color: 'var(--seed)' }}>{fmt(s.ants)}</b>,
    }));
  }
  const loading = buyers.isLoading || buyersAll.isLoading || sellers.isLoading || stakers.isLoading;
  const pick = <T,>(set: (v: T) => void, v: T) => () => { set(v); setLimit(10); };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row-between">
        <h2 id="top-h" className="disp" style={{ fontSize: 'clamp(34px, 4vw, 52px)', color: '#fff' }}>{allTime ? 'Leaderboard' : 'Weekly Leaderboard'}</h2>
        <div className="lb-switches">
          <div className="seg-d" role="group" aria-label="Who">
            {([['buyers', 'Buyers'], ['providers', 'Providers'], ['stakers', 'Stakers']] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={board === k} onClick={pick(setBoard, k)}>{l}</button>
            ))}
          </div>
          {board === 'buyers' && (
            <div className="seg-d" role="group" aria-label="When">
              {([['week', 'This week'], ['all', 'All time']] as const).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={period === k} onClick={pick(setPeriod, k)}>{l}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      {ticker}
      <div className="ag-list">
        <div className="ag-li ag-li-head"><span>#</span><span>{head[0]}</span><span className="hide-s">{head[1]}</span><span className="hide-s">{head[2]}</span><span style={{ textAlign: 'right' }}>{head[3]}</span></div>
        {rows.map((r, i) => (
          <div key={r.key} className="ag-li" data-me={r.me || undefined}>
            <span className="num ag-rank" data-top={i < 3}>{i + 1}</span>
            <span style={{ minWidth: 0 }}>{r.who}</span>
            <span className="num hide-s">{r.c3}</span>
            <span className="num hide-s">{r.c4}</span>
            <span style={{ justifySelf: 'end', textAlign: 'right' }}>{r.c5}</span>
          </div>
        ))}
        {loading && <p className="muted-d">Loading…</p>}
        {!loading && rows.length === 0 && <p className="muted-d">Nobody here yet this week.</p>}
      </div>
      {limit < 50 && rows.length >= limit && (
        <button type="button" className="btn btn-sm lb-more" onClick={() => setLimit(50)}>Show top 50</button>
      )}
      <p className="muted-d" style={{ margin: 0, fontSize: 14 }}>Each buyer can claim up to 5% of this week’s buyer rewards. Link your X account and wallet to show your name.</p>
    </div>
  );
}
