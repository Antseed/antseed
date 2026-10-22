import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { useActions, useWallet } from '../lib/actions';
import { useViewedAddress } from '../lib/address';
import { fmt, fmtBoost, fmtK, shortAddress } from '../lib/format';
import { useAccount, type Network } from '../lib/model';
import { MAX_LOCK_EPOCHS, blendedStakerEstimate, boostFromWeight, epochStartMs } from '../lib/points';
import { onStakeProviderPicked } from '../lib/stakePick';
import { Steps } from './Steps';

/** ANTS can't move until the token launches; until then only earned rewards can be staked. */
const TGE_MS = Date.parse('2026-11-04T00:00:00Z');
/** Lock choices in epochs (weeks). 'max' is max lock: it counts as 2 years until turned off. */
const LOCKS: { key: number | 'max'; label: string }[] = [
  { key: 13, label: '3 months' },
  { key: 52, label: '1 year' },
  { key: 'max', label: 'Max lock' },
];
/** What we preview when there's nothing to stake yet. */
const EXAMPLE_ANTS = 10_000;
type Mode = 'rewards' | 'wallet';

const dayTime = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
const monthYear = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Staking on the home page. Until Nov 4 it's "stake your rewards" only; after that you can also
 * stake ANTS from your wallet. Two choices (provider, lock), three results, and the steps to do it.
 */
export function StakeSection({ net }: { net: Network | undefined }) {
  const params = new URLSearchParams(window.location.search);
  const { address } = useViewedAddress();
  const wallet = useWallet();
  const account = useAccount(address, net);
  const actions = useActions();
  const a = account.data;

  // Best for stakers first: busy providers with little staked behind them pay the most.
  const ranked = useMemo(() => (net ? [...net.providers].filter((p) => p.seller).sort((x, y) => y.stakerPer1k - x.stakerPer1k) : []), [net]);
  const [agentId, setAgentId] = useState<string>(params.get('agent') ?? '');
  useEffect(() => onStakeProviderPicked(setAgentId), []);
  const provider = ranked.find((p) => p.agentId === agentId) ?? ranked[0];
  const [lockKey, setLockKey] = useState<number | 'max'>('max');

  const walletOpen = a ? a.transfersEnabled : Date.now() >= TGE_MS;
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'wallet' ? 'wallet' : 'rewards');
  const activeMode: Mode = walletOpen ? mode : 'rewards';
  const [amount, setAmount] = useState(String(EXAMPLE_ANTS));

  const claimableAnts = a ? Number(formatUnits(a.claimableTotal, 18)) : 0;
  const stakeAnts = activeMode === 'rewards' ? claimableAnts : Math.max(0, Number(amount.replace(/,/g, '')) || 0);
  const example = stakeAnts <= 0;
  const previewAnts = example ? EXAMPLE_ANTS : stakeAnts;
  const maxLock = lockKey === 'max';
  const epochs = maxLock ? MAX_LOCK_EPOCHS : lockKey;
  const est = net && provider
    ? blendedStakerEstimate({
        stakerPotAnts: net.pots.staker, stakeAnts: previewAnts, lockEpochs: epochs,
        volumeUsd: provider.volumeUsd, totalPoolWeighted: net.totalPoolWeighted,
        lastVolumeUsd: provider.volumeLastUsd, lastTotalPoolWeighted: net.lastTotalPoolWeighted, weekFraction: net.weekFraction,
      })
    : 0;
  const boostAfter = provider ? provider.boost + boostFromWeight(BigInt(Math.round(previewAnts * epochs)) * 10n ** 18n) : 0;
  const startMs = net ? epochStartMs(net.epoch + 1) : 0;

  // The steps, in order; the first one not done is where the visitor is.
  const isOperator = Boolean(a?.operator && wallet.address && a.operator.toLowerCase() === wallet.address);
  const lookedUp = Boolean(address);
  const signer = activeMode === 'rewards' ? a?.operator ?? null : null;
  const connected = activeMode === 'rewards' ? isOperator : wallet.isConnected;
  const hasSomething = stakeAnts > 0;

  const submit = () => {
    if (!provider || !address) return;
    if (activeMode === 'rewards') actions.stakeRewards(address, a!.claimableEpochs, provider.agentId, epochs, maxLock).catch(() => {});
    else actions.stakeWallet(wallet.address!, provider.agentId, String(stakeAnts), epochs, maxLock, 0n).catch(() => {});
  };
  const lookUp = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => document.getElementById('lookup-input')?.focus(), 400);
  };

  return (
    <section id="stake" className="stk" aria-labelledby="stake-h">
      <div className="wrap stack" style={{ gap: 28 }}>
        <div className="ag-head" style={{ marginBottom: 0 }}>
          <h2 id="stake-h" className="disp" style={{ color: 'var(--ink)' }}>Stake</h2>
          <p style={{ color: 'var(--slate)' }}>
            Back a provider with your ANTS. You raise its boost for everyone using it, and share the {net ? fmt(net.pots.staker) : '…'} ANTS staker pot every week.
          </p>
        </div>
        <div className="stk-g">
          <div className="stk-form">
            <div className="stk-f">
              <span>{walletOpen ? 'What you’re staking' : 'Rewards available to stake'}</span>
              {!walletOpen && <small>You can stake unclaimed rewards now. Staking ANTS from your wallet opens November 4, when token transfers open.</small>}
              {walletOpen && (
                <div className="segl" role="group" aria-label="Stake from">
                  <button type="button" aria-pressed={activeMode === 'rewards'} onClick={() => setMode('rewards')}>My rewards</button>
                  <button type="button" aria-pressed={activeMode === 'wallet'} onClick={() => setMode('wallet')}>ANTS in my wallet</button>
                </div>
              )}
              {activeMode === 'wallet' ? (
                <div className="stk-in">
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="ANTS to stake" />
                  <span>ANTS</span>
                </div>
              ) : !lookedUp ? (
                <div className="stk-have">
                  <span>Look up your Antseed account to see the rewards you can stake.</span>
                  <button type="button" className="btn btn-ink btn-sm" onClick={lookUp}>Look up my account</button>
                </div>
              ) : (
                <div className="stk-have">
                  <b className={`num${!a ? ' skeleton' : ''}`}>{fmt(claimableAnts)} ANTS</b>
                  <span>{claimableAnts > 0 ? 'ready from finished weeks, not yet claimed' : 'No rewards ready yet. This week’s become stakeable after Thursday.'}</span>
                </div>
              )}
            </div>

            <div className="stk-f">
              <label htmlFor="stk-prov">Provider</label>
              <select id="stk-prov" className="stk-dd" value={provider?.agentId ?? ''} onChange={(e) => setAgentId(e.target.value)}>
                {ranked.map((p) => (
                  <option key={p.agentId} value={p.agentId}>
                    {p.name} · {p.boost < 0.01 ? '0×' : fmtBoost(p.boost)} boost
                  </option>
                ))}
              </select>
              <small>Compare estimated staking rewards based on provider usage and your lock duration.</small>
            </div>

            <div className="stk-f">
              <span>Lock</span>
              <div className="segl" role="group" aria-label="Lock">
                {LOCKS.map((l) => (
                  <button key={String(l.key)} type="button" aria-pressed={lockKey === l.key} onClick={() => setLockKey(l.key)}>{l.label}</button>
                ))}
              </div>
              <small>
                {maxLock
                  ? 'Max lock keeps your stake at full two-year weight. Turning it off starts a two-year unlock countdown from the next weekly period. Withdrawing before that countdown ends burns 5–50% of your stake.'
                  : 'Longer locks earn more. Withdrawing before your lock ends burns 5–50% of your stake.'}
              </small>
            </div>
          </div>

          <div className="stk-out">
            <span className="stk-lbl">{example ? `Estimated weekly rewards for ${fmt(EXAMPLE_ANTS)} ANTS` : `Estimated weekly rewards for ${fmt(stakeAnts)} ANTS`}</span>
            <div>
              <div className={`stk-big${!net ? ' skeleton' : ''}`}>≈ {fmt(est)} ANTS</div>
              <span>a week from the staker pot</span>
            </div>
            <ul className="stk-says">
              {provider && (
                <li>
                  {provider.name}’s boost goes from {provider.boost < 0.01 ? '0×' : fmtBoost(provider.boost)} to {fmtBoost(boostAfter)}
                  {provider.boost >= 0.01
                    ? `, so everyone using it earns ${fmt(boostAfter / provider.boost, boostAfter / provider.boost < 10 ? 1 : 0)}× the points.`
                    : ', so the people using it start earning points.'}
                </li>
              )}
              <li>
                Starts {net ? dayTime(startMs) : '…'}. {maxLock ? 'Stays at full weight until you turn off max lock, then unlocks over two years.' : `Locked until ${monthYear(startMs + epochs * 7 * 86_400_000)}.`}
              </li>
            </ul>

            <ol className="stk-steps">
              {activeMode === 'rewards' && (
                <li data-done={lookedUp || undefined}>Look up your account{lookedUp && address ? ` · ${shortAddress(address)}` : ''}</li>
              )}
              <li data-done={connected || undefined}>
                {activeMode === 'rewards' ? `Connect your reward wallet${signer ? ` · ${shortAddress(signer)}` : ''}` : 'Connect the wallet holding your ANTS'}
              </li>
              <li>Stake{activeMode === 'rewards' ? ' (one signature per week of rewards)' : ' (approve, then stake)'}{maxLock ? ', then turn on max lock' : ''}</li>
            </ol>

            {!provider ? (
              <div className="stk-note">Loading providers…</div>
            ) : activeMode === 'rewards' && !lookedUp ? (
              <button type="button" className="btn btn-green stk-go" onClick={lookUp}>Look up my account</button>
            ) : activeMode === 'rewards' && a && !a.operator ? (
              <div className="stk-note">Set a reward wallet in the AI VPN or console first (Rewards → authorized wallet).</div>
            ) : activeMode === 'rewards' && a && !hasSomething ? (
              <div className="stk-note">Nothing to stake yet. Rewards become stakeable after Thursday’s share-out.</div>
            ) : !connected ? (
              <ConnectButton.Custom>
                {({ account: acc, openConnectModal, openAccountModal }) => (
                  <button type="button" className="btn btn-green stk-go" onClick={acc ? openAccountModal : openConnectModal}>
                    {activeMode === 'rewards' && acc && signer ? `Switch to ${shortAddress(signer)}` : activeMode === 'rewards' ? 'Connect your reward wallet' : 'Connect wallet'}
                  </button>
                )}
              </ConnectButton.Custom>
            ) : (
              <button type="button" className="btn btn-green stk-go" disabled={actions.busy || !hasSomething} onClick={submit}>
                Stake {fmtK(stakeAnts)} ANTS behind {provider.name}
              </button>
            )}
            <Steps steps={actions.steps} error={actions.error} tx={actions.lastTx} />
            <span className="stk-fine">
              Early in the week this leans on last week's numbers, since only a few providers have any spend yet. It falls as more ANTS is staked.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
