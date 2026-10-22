import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useQuery } from '@tanstack/react-query';
import { formatUnits, type Address } from 'viem';
import { useActions, useWallet } from '../lib/actions';
import { useViewedAddress } from '../lib/address';
import { antscan } from '../lib/antscan';
import { fmt, fmtUsd, shortAddress } from '../lib/format';
import { useAccount, useWeekPace, type Network } from '../lib/model';
import { epochEndMs, pointsFromWeighted, projectRange, slashFraction } from '../lib/points';
import { Link } from '../lib/router';
import { Steps } from './Steps';
import { useNow } from './Chrome';
import { LinkXPanel } from './Social';

const dayMonth = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEK_MS = 7 * 86_400_000;

/**
 * The viewed wallet's points, right under the hero. It only renders once we know an address:
 * from the lookup, a ?address= link from the AI VPN or console, or a connected wallet.
 */
export function YourPoints({ net }: { net: Network | undefined }) {
  const { address, setAddress } = useViewedAddress();
  const account = useAccount(address, net);
  const wallet = useWallet();
  const actions = useActions();
  const now = useNow(30_000);
  const pace = useWeekPace(net, now);
  const a = account.data;
  const rank = useQuery({
    queryKey: ['my-rank', net?.epoch, a?.buyerWeightedNow],
    queryFn: () => antscan.buyerRank(net!.epoch, a!.buyerWeightedNow),
    enabled: Boolean(net && a && a.buyerWeightedNow !== '0'),
  });
  if (!address) return null;

  const params = new URLSearchParams(window.location.search);
  const signinFailed = params.get('signin') === 'failed' ? params.get('reason') || 'x' : null;
  const loading = account.isLoading || !net;
  const isOperator = Boolean(a?.operator && wallet.address && a.operator.toLowerCase() === wallet.address);
  const isOwner = Boolean(wallet.address && wallet.address === address);
  const week = a?.epochs.at(-1);
  const range = a && net && pace
    ? projectRange({ potAnts: net.pots.buyer, totalPoints: pointsFromWeighted(net.totalBuyerWeighted), myPoints: a.pointsNow, alreadyCounted: true, ...pace })
    : null;
  const claimableAnts = a ? Number(formatUnits(a.claimableTotal, 18)) : 0;
  const weeks = [...(a?.epochs ?? [])].reverse().filter((e) => e.current || e.points > 0).slice(0, 4);
  const lookAgain = () => {
    setAddress(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => document.getElementById('lookup-input')?.focus(), 400);
  };

  return (
    <section id="me" className="yp" aria-labelledby="me-h">
      <div className="wrap stack" style={{ gap: 22 }}>
        <div className="ag-head" style={{ marginBottom: 0 }}>
          <div className="stack" style={{ gap: 10 }}>
            <h2 id="me-h" className="disp" style={{ color: 'var(--ink)' }}>Your points</h2>
            <span className="yp-who">
              <span className="num yp-chip">{shortAddress(address)}</span>
              <button type="button" className="yp-link" onClick={lookAgain}>Look up another account</button>
            </span>
          </div>
          <p style={{ color: 'var(--slate)', fontSize: 14 }}>View points without connecting a wallet. Connect your reward wallet when you’re ready to claim or stake.</p>
        </div>

        {signinFailed && <div className="notice bad">X sign-in didn't finish{signinFailed === 'cancelled' ? ' because it was cancelled' : ''}. You can try again below.</div>}
        <LinkXPanel address={address} operator={a?.operator ?? null} />

        <div className="yp-tiles">
          <div className="yp-tile">
            <span className="k">Points this week</span>
            <span className={`v${loading ? ' skeleton' : ''}`}>{fmt(a?.pointsNow ?? 0)}</span>
            <small>from {fmtUsd(week?.spentUsd ?? 0)} spent{a && a.providerPointsNow > 0 ? ` · plus ${fmt(a.providerPointsNow)} provider points` : ''}</small>
          </div>
          <div className="yp-tile">
            <span className="k">Rank this week</span>
            <span className="v">{rank.data ? `#${fmt(rank.data.rank)}` : a && a.pointsNow === 0 ? '—' : '…'}</span>
            <small>{rank.data ? `of ${fmt(rank.data.of)} buyers` : 'among buyers'}</small>
          </div>
          <div className="yp-tile dark">
            <span className="k">ANTS by Thursday</span>
            <span className="v">≈ {fmt(range?.expected ?? a?.estAntsNow ?? 0)}</span>
            <small>{range && range.low < range.now - 0.5 ? `likely ${fmt(range.low)} – ${fmt(range.now)}` : 'at this week’s pace'}</small>
          </div>
          <div className="yp-tile">
            <span className="k">Ready to claim</span>
            <span className={`v${loading ? ' skeleton' : ''}`}>{fmt(claimableAnts)}</span>
            <small>ANTS from past weeks</small>
          </div>
        </div>
        {range && net && range.expected >= net.pots.buyer * 0.05 - 0.5 && <div className="notice">At this week's pace you'll pass 5% of the buyer pot, so your claim will be capped at 5%. Anything above that goes to the reserve.</div>}

        <div className="yp-actions">
          <ClaimButtons buyer={address} epochs={a?.claimableEpochs ?? []} operator={a?.operator ?? null} isOperator={isOperator} actions={actions} claimableAnts={claimableAnts} />
          <Link className="btn btn-line" href="#stake">Stake my rewards</Link>
          <span>Use one provider a lot? Stake behind it: you raise its boost for yourself and everyone using it, and earn from the staker pot.</span>
        </div>
        <Steps steps={actions.steps} error={actions.error} tx={actions.lastTx} />
        {a && !a.operator && claimableAnts > 0 && (
          <p className="note" style={{ margin: 0 }}>No reward wallet is set for this address yet. Set one in the AI VPN or console (Rewards → authorized wallet) to claim.</p>
        )}

        {weeks.length > 0 && (
          <div className="yp-weeks">
            {weeks.map((e) => {
              const end = epochEndMs(e.epoch);
              const status = e.current ? 'Thursday 09:54 UTC' : e.claimable > 0n ? 'Ready to claim' : e.ants > 0 ? 'Claimed' : 'No ANTS';
              return (
                <div key={e.epoch}>
                  {e.current ? <b>This week</b> : <span>{dayMonth(end - WEEK_MS)} – {dayMonth(end)}</span>}
                  <span className="num">{fmt(e.points)} points</span>
                  <span className="num">{e.current ? '≈ ' : ''}{fmt(e.current && range ? range.expected : e.ants)} ANTS</span>
                  <span className={`yp-st${e.claimable > 0n ? ' go' : ''}`}>{status}</span>
                </div>
              );
            })}
          </div>
        )}

        {a && a.stakes.length > 0 && (
          <div className="panel stack" style={{ gap: 12 }}>
            <div className="row-between">
              <h3 className="disp" style={{ fontSize: 28, margin: 0 }}>Your stakes</h3>
              <Link className="btn btn-ink btn-sm" href="#stake">New stake</Link>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Position</th><th>Provider</th><th className="r">ANTS</th><th className="r">Lock</th><th className="r">Est. per week</th><th className="r">To claim</th><th className="r">Leaving now burns</th><th /></tr>
                </thead>
                <tbody>
                  {a.stakes.map((s) => {
                    const remaining = s.endEpoch - (net?.epoch ?? 0);
                    const total = s.endEpoch - s.startEpoch;
                    return (
                      <tr key={s.id}>
                        <td className="num">#{s.id}</td>
                        <td>{s.provider}</td>
                        <td className="r num">{fmt(s.amountAnts)}</td>
                        <td className="r">{s.maxLocked ? <span className="badge seed">Max lock</span> : `${Math.max(0, remaining)} epochs left`}{s.pending ? <span className="badge" style={{ marginLeft: 6 }}>Starts next epoch</span> : null}</td>
                        <td className="r num">≈ {fmt(s.estWeekAnts)}</td>
                        <td className="r num">{fmt(s.pendingAnts)}</td>
                        <td className="r num">{s.maxLocked ? 'Turn off max lock first' : `${fmt(slashFraction(remaining, total) * 100)}%`}</td>
                        <td className="r">
                          {isOwner && s.pendingAnts > 0 && (
                            <button type="button" className="btn btn-seed btn-sm" disabled={actions.busy} onClick={() => actions.claimStaker(s.id, wallet.address as Address).catch(() => {})}>Claim</button>
                          )}
                          {isOwner && !s.maxLocked && (
                            <button type="button" className="btn btn-line btn-sm" style={{ marginLeft: 6 }} disabled={actions.busy} onClick={() => actions.enableMaxLock(s.id).catch(() => {})}>Max lock</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ margin: 0 }}>To move, split or withdraw a stake, use the staking dashboard in the AI VPN or console (Rewards → Manage staking).</p>
          </div>
        )}
      </div>
    </section>
  );
}

function ClaimButtons({ buyer, epochs, operator, isOperator, actions, claimableAnts }: {
  buyer: Address;
  epochs: number[];
  operator: Address | null;
  isOperator: boolean;
  actions: ReturnType<typeof useActions>;
  claimableAnts: number;
}) {
  if (epochs.length === 0 || !operator) return null;
  if (!isOperator) {
    return (
      <ConnectButton.Custom>
        {({ account, openConnectModal, openAccountModal }) => (
          <button type="button" className="btn btn-ink" onClick={account ? openAccountModal : openConnectModal}>
            {account ? `Switch to ${shortAddress(operator)} to claim` : 'Connect your reward wallet to claim'}
          </button>
        )}
      </ConnectButton.Custom>
    );
  }
  return (
    <button type="button" className="btn btn-ink" disabled={actions.busy} onClick={() => actions.claimBuyer(buyer, epochs).catch(() => {})}>
      Claim {fmt(claimableAnts)} ANTS
    </button>
  );
}
