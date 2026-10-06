import { InfoHelp } from './EarlyExitHelp';
import { useEffect, useRef, useState } from 'react';
import type { PoolConfigView, PoolView, RewardsView } from '../../../src/api-types';
import { describeError, formatAnts, formatBps, isPositiveDecimal, parseUnits } from '../format';
import { useActionBlock } from './Confirm';
import { Button } from './ui';
import { useJobs } from '../jobs';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { useApp, useEpochInfo } from '../app-context';
import { stakeSources, stakeSourceRequest, type StakeSource } from '../stake-sources';
import { formatYieldPercent, stakeApy } from '../pool-yield';

interface Props {
  config: PoolConfigView | null;
  pools: PoolView[];
  /** Wallet ANTS balance in base units; fills the amount on "Max". */
  balance?: string;
  rewards?: RewardsView | null;
  rewardsError?: string | null;
  /** Pool preselected by the row's Stake button. */
  defaultAgentId?: number | null;
  /** The pool cannot be changed (seller sheet): sources bound to another pool are hidden. */
  lockedPool?: boolean;
  onStarted?: () => void;
  onClose?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

const DAY = 86_400;

/** Full-precision ANTS amount without thousands separators, as the API expects it. */
const plainAnts = (value: string) => formatAnts(value, 18).replace(/,/g, '');
const LOCK_PRESETS: Array<{ label: string; days: number | 'max' }> = [
  { label: '1w', days: 7 }, { label: '1m', days: 30 }, { label: '6m', days: 182 }, { label: '1y', days: 365 }, { label: 'max', days: 'max' },
];

function sourceNote(source: StakeSource): string {
  if (source.kind === 'wallet') return 'Stakes wallet ANTS; token approval may be needed.';
  if (source.kind === 'buyer') return 'AI buying rewards. Choose any seller; no claim needed.';
  if (source.kind === 'seller') return 'AI selling rewards. Stakes into your own pool.';
  return 'Position rewards. Restakes into the same pool.';
}

/** Stake eligible unclaimed rewards (or wallet ANTS, when transfers are enabled) into a seller pool. */
export function StakeForm({ config, pools, balance, rewards = null, rewardsError, defaultAgentId, lockedPool = false, onStarted, onClose, onBusyChange }: Props) {
  const { overview, config: dashboardConfig } = useApp();
  const info = useEpochInfo();
  const jobs = useJobs();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [agentId, setAgentId] = useState(() => String(defaultAgentId ?? pools[0]?.agentId ?? ''));
  const [walletAmount, setAmount] = useState('');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const canTransfer = overview?.wallet.canTransfer ?? false;
  const managesWallet = !dashboardConfig.selectedAddress || dashboardConfig.selectedAddress.toLowerCase() === dashboardConfig.walletAddress?.toLowerCase();
  const allSources = stakeSources(rewardsError ? null : rewards, balance ?? '0', canTransfer).filter(source => managesWallet || source.kind === 'buyer');
  const sources = lockedPool && defaultAgentId ? allSources.filter((s) => s.agentId === undefined || s.agentId === defaultAgentId) : allSources;
  const hiddenBound = lockedPool ? allSources.length - sources.length : 0;
  const chosenSource = sources.find(s => s.id === sourceId);
  const source: StakeSource | null = chosenSource ?? sources.find(s => s.available && s.kind !== 'wallet') ?? sources[0] ?? null;
  const block = useActionBlock(source?.kind === 'buyer');
  const sourceMissing = sourceId !== null && !chosenSource;
  const isWallet = source?.kind === 'wallet';
  const amount = source === null ? '' : isWallet ? walletAmount : plainAnts(source.amount);
  const selectedAgentId = source?.agentId ?? Number(agentId);
  const maxEpochs = config?.maxStakeEpochs ?? 1;
  const minEpochs = Math.max(1, config?.minStakeEpochs ?? 1);
  const [epochs, setEpochs] = useState(minEpochs);

  useEffect(() => {
    if (config) setEpochs((current) => Math.max(config.minStakeEpochs, Math.min(current, config.maxStakeEpochs)));
  }, [config?.minStakeEpochs, config?.maxStakeEpochs]);
  useEffect(() => {
    if (defaultAgentId) setAgentId(String(defaultAgentId));
  }, [defaultAgentId]);
  useEffect(() => {
    if (!agentId && pools[0]) setAgentId(String(pools[0].agentId));
  }, [agentId, pools]);

  const pool = pools.find((p) => p.agentId === selectedAgentId) ?? null;
  let estimatedApy: number | null = null;
  if (config && source?.available && !sourceMissing && isPositiveDecimal(amount)) {
    const principal = parseUnits(amount, 18);
    const bonusBps = source.kind === 'staker' ? Math.floor(config.restakedRewardWeightBonusBps * epochs / config.maxStakeEpochs) : 0;
    if (principal !== null) estimatedApy = stakeApy(pool?.yield, epochs, principal.toString(), bonusBps);
  }

  const fillMax = () => {
    if (balance !== undefined) setAmount(plainAnts(balance));
  };

  const validate = (): string | null => {
    if (!source) return 'Nothing is available to stake.';
    if (!selectedAgentId || (source.agentId === undefined && !pool)) return 'Choose a pool.';
    if (!isPositiveDecimal(amount)) return 'Amount must be a positive decimal number of ANTS.';
    const units = parseUnits(amount, 18);
    if (units === null) return 'Amount must have no more than 18 decimal places.';
    if (isWallet && balance !== undefined && units !== null) {
      let available = 0n;
      try {
        available = BigInt(balance);
      } catch {
        available = 0n;
      }
      if (units > available) return `Amount exceeds wallet balance (${formatAnts(balance, 4)} ANTS).`;
    }
    if (!config) return 'Pool configuration is still loading.';
    if (epochs < minEpochs || epochs > maxEpochs) return `Lock must be between ${minEpochs} and ${maxEpochs} epochs.`;
    return null;
  };

  const activationEpoch = config && overview ? overview.epoch.current + config.stakeActivationDelay : null;
  const noPools = source?.agentId === undefined && pools.length === 0;
  const readinessError = dashboardConfig.browserWallet && dashboardConfig.readOnly
    ? 'Connect wallet to stake.'
    : !overview ? 'Wallet information is unavailable. Refresh before staking.'
    : sourceMissing ? 'The selected rewards are no longer available. Choose a source again.'
    : source && !source.available ? 'Use the wallet button above to switch to the authorized wallet for these rewards.'
    : BigInt(overview.wallet.signingWalletEth ?? overview.wallet.eth) === 0n ? 'The signing wallet needs ETH on the selected network to pay transaction fees.'
    : null;
  const blocked = block.blocked || noPools || !!readinessError || source === null;
  const blockedReason = readinessError ?? block.reason ?? (noPools ? 'No stakeable pools yet.' : null);
  const epochsForDays = (days: number) => info ? Math.max(minEpochs, Math.min(maxEpochs, Math.round((days * DAY) / info.epochDuration))) : null;

  const submit = async () => {
    if (submitting.current || blocked || !source) return;
    const problem = validate();
    if (problem) { setError(problem); return; }
    submitting.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const request = stakeSourceRequest(source, selectedAgentId, amount.trim(), epochs);
      await jobs.start(request.path, request.body);
      onStarted?.();
    } catch (err) {
      jobs.pushToast({ tone: 'danger', title: `${isWallet ? 'Stake' : 'Stake rewards'} failed`, body: describeError(err), sticky: true });
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  const loadingRewards = !rewards && !rewardsError;

  if (dashboardConfig.browserWallet && dashboardConfig.readOnly) {
    return (
      <form className="stake-form" onSubmit={(event) => event.preventDefault()}>
        <div className="status-line status-line--muted" role="status">Connect your wallet to see what you can stake. Unclaimed rewards can be staked directly; wallet ANTS are stakeable once transfers are enabled.</div>
        {onClose ? <div className="stake-form-actions"><Button variant="outline" onClick={onClose}>Close</Button></div> : null}
      </form>
    );
  }

  return (
    <form className="stake-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {blockedReason ? <div className="status-line status-line--muted" role="status">{blockedReason}</div> : null}
      {rewardsError ? <p className="error-text">Rewards could not be loaded: {rewardsError}</p> : null}

      {sources.length === 0 ? (
        <div className="stake-empty" role="status">
          {loadingRewards ? <span>Loading unclaimed rewards…</span> : <>
            <strong>Nothing to stake yet</strong>
            {canTransfer
              ? 'Your wallet holds no ANTS and no eligible rewards are unclaimed.'
              : 'ANTS transfers are not enabled for this wallet, so staking from the wallet balance is unavailable. Rewards you earn buying, selling or staking can be staked here directly as they accrue.'}
            {hiddenBound > 0 ? ` ${hiddenBound} reward source${hiddenBound === 1 ? '' : 's'} belong to other pools.` : ''}
          </>}
        </div>
      ) : (
        <div className="field">
          <Field label="Stake from" hint={source ? sourceNote(source) : undefined}>
            <Select value={source?.id ?? ''} disabled={busy} onChange={(event) => { setSourceId(event.target.value); setError(null); }}>
              {sources.map((sourceOption) => (
                <option key={sourceOption.id} value={sourceOption.id}>
                  {sourceOption.label}{!sourceOption.available ? ' · other wallet' : ''} · {formatAnts(sourceOption.amount, 4)} ANTS
                </option>
              ))}
            </Select>
          </Field>
          {!canTransfer ? <span className="field__hint">Rewards only: wallet ANTS transfers are disabled.</span> : null}
          {hiddenBound > 0 ? <span className="field__hint">{hiddenBound} reward source{hiddenBound === 1 ? '' : 's'} bound to other pools {hiddenBound === 1 ? 'is' : 'are'} not shown here.</span> : null}
        </div>
      )}

      {source ? (
        <div className="form-row">
          {!lockedPool && source.agentId === undefined ? (
            <Field label="Seller pool" width="lg">
              <Select value={String(selectedAgentId || '')} onChange={(e) => setAgentId(e.target.value)} disabled={busy || noPools}>
                {noPools ? <option value="">No stakeable pools</option> : null}
                {pools.map((p) => (
                  <option key={p.agentId} value={p.agentId}>
                    {p.profile?.name?.trim() || `Agent ID ${p.agentId}`}
                  </option>
                ))}
              </Select>
            </Field>
          ) : source.agentId !== undefined && !lockedPool ? (
            <Field label="Seller pool" width="lg" hint="These rewards can only be staked into this seller pool.">
              <Select value={String(source.agentId)} disabled>
                <option value={source.agentId}>{pool?.profile?.name?.trim() || `Agent ID ${source.agentId}`}</option>
              </Select>
            </Field>
          ) : null}
          {isWallet ? (
            <Input
              label="Amount (ANTS)"
              hint={balance !== undefined ? (
                <>
                  Balance <span className="mono">{formatAnts(balance, 4)}</span> ·{' '}
                  <button type="button" className="link-button" onClick={fillMax} disabled={busy}>
                    Max
                  </button>
                </>
              ) : undefined}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              disabled={busy || noPools}
            />
          ) : null}
          <div className="stake-lock-settings">
            <LockSlider value={epochs} min={minEpochs} max={maxEpochs} startEpoch={activationEpoch} onChange={setEpochs} disabled={busy || !config || noPools} />
            <div className="lock-presets" aria-label="Lock presets">
              {LOCK_PRESETS.map((preset) => {
                const target = preset.days === 'max' ? maxEpochs : epochsForDays(preset.days);
                if (target === null) return null;
                return (
                  <button key={preset.label} type="button" className="lock-preset" aria-pressed={epochs === target} disabled={busy || !config} onClick={() => setEpochs(target)}>
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <div className="stake-apy" aria-live="polite">
              <span className="small">Estimated APY <strong className="mono">{formatYieldPercent(estimatedApy)}</strong><InfoHelp label="About estimated APY">Uses your initial power, restaking bonus and added pool power. Assumes past rewards repeat with per-epoch compounding—not automatic. Excludes declining power and activation delays. Returns aren’t guaranteed.</InfoHelp></span>
              {estimatedApy === null ? <span className="field__hint">{isWallet && !isPositiveDecimal(amount) ? 'Enter an amount to estimate APY.' : 'APY unavailable: missing reward history or staking data.'}</span> : null}
            </div>
          </div>
        </div>
      ) : null}
      {source && (config || !isWallet) ? <div className="hint">Staking details<InfoHelp label="About staking and early withdrawal">
        {config ? <>Longer locks increase power. Early exit burns {formatBps(config.minEarlyExitSlashBps)}–{formatBps(config.maxSlashBps)} of principal; preview shows the amount. Dates assume confirmation this epoch. </> : null}
        {!isWallet ? <>Stakes all eligible rewards, verified on-chain. Usage rewards may need approval per epoch.</> : null}
      </InfoHelp></div> : null}
      {error ? <div className="error-text" role="alert">{error}</div> : null}
      {source ? (
        <div className="stake-form-actions">
          <button type="submit" className="btn btn--primary btn--md" disabled={blocked || busy}>{busy ? 'Sending…' : block.label ?? (isWallet ? 'Stake' : 'Stake rewards')}</button>
          {onClose ? (
            <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          ) : null}
        </div>
      ) : onClose ? (
        <div className="stake-form-actions"><Button variant="outline" onClick={onClose}>Close</Button></div>
      ) : null}
    </form>
  );
}
