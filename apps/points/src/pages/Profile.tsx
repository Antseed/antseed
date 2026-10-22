import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import { PixelAnt } from '../components/Ant';
import { useNow } from '../components/Chrome';
import { BoostBadge } from '../components/Providers';
import { BoostTag } from '../components/ProviderPicker';
import { Avatar, XLogo } from '../components/Social';
import { useViewedAddress } from '../lib/address';
import { antscan } from '../lib/antscan';
import { fmt, fmtK, fmtPerUsd, fmtUsd, shortAddress } from '../lib/format';
import { loadAccount, useWeekPace, type Account, type Network, type Provider } from '../lib/model';
import { epochEndMs, formatCountdown, pointsFromWeighted, projectRange } from '../lib/points';

const dayMonth = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekStart = (epoch: number) => dayMonth(epochEndMs(epoch) - 7 * 86_400_000);
const weekRange = (epoch: number) => `${weekStart(epoch)} – ${dayMonth(epochEndMs(epoch))}`;
import { Link, navigate, profileHandleFrom, usePathname } from '../lib/router';
import { canvasBlob, drawShareCard, type ShareCardData } from '../lib/shareCard';
import { useMe, useProfile } from '../lib/social';

export function Profile({ net }: { net: Network | undefined }) {
  const handle = profileHandleFrom(usePathname());
  const prof = useProfile(handle);
  const me = useMe().data;
  const { setAddress } = useViewedAddress();
  const addresses = (prof.data?.addresses ?? []) as Address[];

  const accountQs = useQueries({
    queries: addresses.map((a) => ({
      queryKey: ['account', a, net?.epoch, net?.asOfBlock],
      queryFn: () => loadAccount(a, net!),
      enabled: Boolean(net),
      staleTime: 30_000,
    })),
  });
  const accounts = accountQs.map((q) => q.data).filter((a): a is Account => Boolean(a));
  const loading = !net || accountQs.some((q) => q.isLoading);
  // Wait for every linked wallet, so totals never show a partial sum.
  const sum = useMemo(() => summarize(loading ? [] : accounts, net), [accounts, net, loading]);

  // This week's ANTS, projected to Thursday the same way as on the home page.
  const pace = useWeekPace(net, useNow(60_000));
  const antsEst = net && pace && !loading
    ? projectRange({ potAnts: net.pots.buyer, totalPoints: pointsFromWeighted(net.totalBuyerWeighted), myPoints: sum.pointsNow, alreadyCounted: true, ...pace }).expected
    : sum.antsNow;

  const rank = useQuery({
    queryKey: ['rank', net?.epoch, sum.weightedNow.toString()],
    queryFn: () => antscan.buyerRank(net!.epoch, sum.weightedNow.toString()),
    enabled: Boolean(net) && !loading && sum.weightedNow > 0n,
    staleTime: 60_000,
  });

  if (prof.isError) {
    return (
      <section className="section">
        <div className="wrap stack" style={{ gap: 20, justifyItems: 'center', textAlign: 'center' }}>
          <PixelAnt size={150} seed />
          <h1 className="disp" style={{ fontSize: 'clamp(36px, 6vw, 64px)' }}>No profile for @{handle} yet</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 520 }}>
            Profiles appear once someone signs in with X and links the wallet they use with Antseed. If this is you, look up your Antseed account on the home page to link it.
          </p>
          <Link className="btn btn-ink" href="/#me">Go to your points</Link>
        </div>
      </section>
    );
  }

  const p = prof.data;
  const isMe = Boolean(me?.signedIn && p && me.handle?.toLowerCase() === p.handle.toLowerCase());
  const maxAnts = Math.max(1, ...sum.history.map((e) => e.ants));
  const now = Date.now();

  return (
    <section className="section">
      <div className="wrap stack" style={{ gap: 24 }}>
        <div className="prof-head">
          {p ? <Avatar src={p.avatar} name={p.handle} size={96} /> : <span className="xavatar skeleton" style={{ width: 96, height: 96 }} />}
          <div className="stack" style={{ gap: 6, minWidth: 0 }}>
            <span className="eyebrow">Profile · {net ? `week of ${weekRange(net.epoch)}` : '…'}</span>
            <h1 className="disp" style={{ fontSize: 'clamp(36px, 6vw, 64px)', overflowWrap: 'anywhere' }}>{p?.name || `@${handle}`}</h1>
            <div className="prof-wallets">
              <a className="badge ink" href={`https://x.com/${encodeURIComponent(p?.handle ?? handle)}`} target="_blank" rel="noreferrer">
                <XLogo size={11} /> @{p?.handle ?? handle}
              </a>
              {addresses.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="badge"
                  style={{ border: 0, cursor: 'pointer' }}
                  title="Open this wallet under Your points"
                  onClick={() => {
                    setAddress(a);
                    navigate('/#me');
                  }}
                >
                  {shortAddress(a)}
                </button>
              ))}
            </div>
          </div>
          <div className="prof-share">
            {isMe && <Link className="btn btn-line btn-sm" href="/#me">Manage linked wallets</Link>}
          </div>
        </div>

        <div className="prof-big">
          <div className="stat"><div className="k">Points this week</div><div className={`v${loading ? ' skeleton' : ''}`}>{fmt(sum.pointsNow)}</div></div>
          <div className="stat"><div className="k">Estimated ANTS this week</div><div className={`v${loading ? ' skeleton' : ''}`}>{fmt(antsEst)}</div></div>
          <div className="stat">
            <div className="k">Rank among buyers</div>
            <div className={`v${loading || rank.isLoading ? ' skeleton' : ''}`}>{rank.data ? `#${fmt(rank.data.rank)}` : '—'}</div>
            {rank.data && <div className="note">of {fmt(rank.data.of)} this week</div>}
          </div>
          <div className="stat"><div className="k">ANTS staked</div><div className={`v${loading ? ' skeleton' : ''}`}>{fmtK(sum.stakedAnts)}</div></div>
        </div>

        <div className="grid2">
          <div className="panel stack" style={{ gap: 12 }}>
            <div className="row-between">
              <span className="eyebrow">ANTS earned per week</span>
              <span className="note">this week final in {net ? formatCountdown(epochEndMs(net.epoch) - now) : '…'}</span>
            </div>
            <div className={`hist${loading ? ' skeleton' : ''}`} role="img" aria-label="ANTS earned per week">
              {sum.history.map((e) => (
                <div key={e.epoch} className={`col${e.current ? ' now' : ''}`}>
                  <span>{(e.current ? antsEst : e.ants) > 0 ? fmtK(e.current ? antsEst : e.ants) : ''}</span>
                  <i style={{ height: `${Math.max(4, (e.ants / maxAnts) * 100)}px` }} />
                  <span>{e.current ? 'now' : weekStart(e.epoch)}</span>
                </div>
              ))}
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Week</th><th className="r">Spent</th><th className="r">Points</th><th className="r">ANTS</th></tr></thead>
                <tbody>
                  {[...sum.history].reverse().filter((e) => e.points > 0 || e.current).map((e) => (
                    <tr key={e.epoch}>
                      <td>{e.current ? 'This week' : weekRange(e.epoch)}</td>
                      <td className="r num">{fmtUsd(e.spentUsd)}</td>
                      <td className="r num">{fmt(e.points)}</td>
                      <td className="r num">{e.current ? '≈ ' : ''}{fmt(e.current ? antsEst : e.ants)}{e.capped ? <span className="badge seed" style={{ marginLeft: 6 }}>5% cap</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ margin: 0 }}>
              Finished weeks show what the contract paid out. This week's figure is an estimate projected to Thursday, the same way as on the home page.
            </p>
          </div>

          <ShareCard
            data={p && net && !loading ? { handle: p.handle, name: p.name, avatar: p.avatar, epoch: net.epoch, points: sum.pointsNow, ants: antsEst, rank: rank.data ?? null } : null}
            isMe={isMe}
          />
        </div>

        <div className="panel stack" style={{ gap: 12 }}>
          <h2 className="disp" style={{ fontSize: 36 }}>Providers backed</h2>
          {sum.backed.length > 0 ? (
            <div className="tablewrap">
              <table>
                <thead><tr><th>Provider</th><th className="r">Boost</th><th className="r">ANTS staked here</th><th className="r">Served this week</th><th className="r">Est. ANTS per week</th></tr></thead>
                <tbody>
                  {sum.backed.map((b) => (
                    <tr key={b.agentId}>
                      <td>{b.provider?.name ?? b.name}</td>
                      <td className="r">{b.provider ? <BoostTag boost={b.provider.boost} /> : '—'}</td>
                      <td className="r num">{fmt(b.ants)}{b.maxLocked ? <span className="badge seed" style={{ marginLeft: 6 }}>Max lock</span> : null}</td>
                      <td className="r num">{b.provider ? fmtUsd(b.provider.volumeUsd) : '—'}</td>
                      <td className="r num">≈ {fmt(b.estWeek)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{loading ? 'Loading…' : 'Not backing any provider yet.'}</p>
          )}
        </div>

        {sum.runs.length > 0 && (
          <div className="panel stack" style={{ gap: 14 }}>
            <h2 className="disp" style={{ fontSize: 36 }}>Runs a provider</h2>
            {sum.runs.map((r) => (
              <div key={r.agentId} className="stack" style={{ gap: 10 }}>
                <div className="row-between">
                  <b style={{ fontSize: 20 }}>{r.name}</b>
                  <span style={{ display: 'inline-flex', gap: 6 }}><BoostTag boost={r.boost} /><BoostBadge p={r} /></span>
                </div>
                <div className="stats">
                  <div className="stat"><div className="k">Served this week</div><div className="v">{fmtUsd(r.volumeUsd)}</div></div>
                  <div className="stat"><div className="k">Provider points</div><div className="v">{fmt(r.points)}</div></div>
                  <div className="stat"><div className="k">ANTS staked behind it</div><div className="v">{fmtK(r.stakeAnts)}</div></div>
                  <div className="stat"><div className="k">Buyer ANTS per $1</div><div className="v">{fmtPerUsd(r.antsPerUsd)}</div></div>
                  <div className="stat"><div className="k">Staker est. per 1K / week</div><div className="v">{fmt(r.stakerPer1k)}</div></div>
                  <div className="stat"><div className="k">Models</div><div className="v">{r.offers.length || r.models.length}</div></div>
                </div>
                {r.providerCapped && <div className="notice">This provider is above 5% of the provider pot, so its own claim is capped at 5% this week.</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface Backed {
  agentId: string;
  name: string;
  provider?: Provider;
  ants: number;
  estWeek: number;
  maxLocked: boolean;
}

function summarize(accounts: Account[], net: Network | undefined) {
  const byEpoch = new Map<number, { epoch: number; spentUsd: number; points: number; ants: number; capped: boolean; current: boolean }>();
  for (const a of accounts) {
    for (const e of a.epochs) {
      const row = byEpoch.get(e.epoch) ?? { epoch: e.epoch, spentUsd: 0, points: 0, ants: 0, capped: false, current: e.current };
      row.spentUsd += e.spentUsd;
      row.points += e.points;
      row.ants += e.ants;
      row.capped ||= e.capped;
      byEpoch.set(e.epoch, row);
    }
  }
  const history = [...byEpoch.values()].sort((x, y) => x.epoch - y.epoch);
  const provs = new Map(net?.providers.map((p) => [p.agentId, p]) ?? []);
  const backedMap = new Map<string, Backed>();
  for (const s of accounts.flatMap((a) => a.stakes)) {
    const b = backedMap.get(s.agentId) ?? { agentId: s.agentId, name: s.provider, provider: provs.get(s.agentId), ants: 0, estWeek: 0, maxLocked: false };
    b.ants += s.amountAnts;
    b.estWeek += s.estWeekAnts;
    b.maxLocked ||= s.maxLocked;
    backedMap.set(s.agentId, b);
  }
  const owned = new Set(accounts.map((a) => a.address.toLowerCase()));
  return {
    history,
    pointsNow: accounts.reduce((t, a) => t + a.pointsNow, 0),
    antsNow: accounts.reduce((t, a) => t + a.estAntsNow, 0),
    stakedAnts: accounts.reduce((t, a) => t + a.stakedAnts, 0),
    weightedNow: accounts.reduce((t, a) => t + BigInt(a.buyerWeightedNow || '0'), 0n),
    backed: [...backedMap.values()].sort((x, y) => y.ants - x.ants),
    runs: net?.providers.filter((p) => owned.has(p.seller.toLowerCase())) ?? [],
  };
}

function ShareCard({ data, isMe }: { data: ShareCardData | null; isMe: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const key = data ? JSON.stringify(data) : '';

  useEffect(() => {
    if (!data || !ref.current) return;
    let live = true;
    setReady(false);
    drawShareCard(ref.current, data).then(() => live && setReady(true));
    return () => {
      live = false;
    };
    // Redraw only when the numbers change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const url = data ? `${window.location.origin}/u/${encodeURIComponent(data.handle)}` : '';
  const text = data
    ? `${isMe ? 'My' : `@${data.handle}'s`} Antseed points this week: ${fmt(data.points)}, an estimated ${fmt(data.ants)} ANTS this week${data.rank ? ` (#${fmt(data.rank.rank)} of ${fmt(data.rank.of)} buyers)` : ''}. The AI network that rewards you for using it.`
    : '';
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

  const save = async () => {
    if (!ref.current || !data) return;
    const blob = await canvasBlob(ref.current);
    if (!blob) return setMsg("Couldn't make the image in this browser.");
    const file = new File([blob], `antseed-points-${data.handle}-week-${weekStart(data.epoch).replace(' ', '-')}.png`, { type: 'image/png' });
    // On phones, the share sheet can attach the image straight to a post.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, url });
        return;
      } catch {
        /* cancelled: fall back to saving */
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setMsg('Saved. Attach it to your post on X.');
  };

  return (
    <div className="panel stack share-panel" style={{ gap: 14 }}>
      <span className="eyebrow">Share card</span>
      <canvas ref={ref} className="share-card" width={1200} height={630} aria-label="Share card preview" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn btn-ink btn-sm" href={intent} target="_blank" rel="noreferrer" aria-disabled={!data}>
          <XLogo /> Post on X
        </a>
        <button type="button" className="btn btn-line btn-sm" disabled={!ready} onClick={save}>Save image</button>
        <button
          type="button"
          className="btn btn-line btn-sm"
          disabled={!data}
          onClick={() => navigator.clipboard?.writeText(url).then(() => setMsg('Profile link copied.'), () => setMsg(url))}
        >
          Copy link
        </button>
      </div>
      {msg && <p className="note" style={{ margin: 0 }}>{msg}</p>}
    </div>
  );
}
