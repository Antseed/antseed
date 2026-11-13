import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { formatEther, parseEther } from 'viem';

import { DiemLogo } from './icons';
import { FlowDiagram } from './FlowDiagram';

import {
  useDiemAllowance,
  usePoolStats,
  useUserStats,
  useEpochClock,
  useUnstakeState,
  type UnstakeState,
} from '../lib/hooks';
import {
  useApproveDiem,
  useStake,
  useInitiateUnstake,
  useFlush,
  useClaimUnstakeBatch,
  useClaimUsdc,
  useClaimAnts,
} from '../lib/actions';
import {
  fmtDiem,
  fmtDiemPrecise,
  fmtDuration,
  fmtNum,
  fmtPct,
  fmtUSD,
  toAntsNumber,
  toDiemNumber,
  toUsdcNumber,
} from '../lib/format';
import { DAYS_PER_YEAR } from '../lib/epoch';
import { MAX_USDC_PER_DIEM_PER_DAY } from '../lib/protocol';

type Tab = 'stake' | 'unstake' | 'claim';

const DEFAULT_STAKE_AMOUNT = parseEther('1');
const DIEM_TERMS_URL = 'https://diemantseed.com/terms-of-service.html';

function formatDiemInput(value: bigint): string {
  const formatted = formatEther(value);
  return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted;
}

// viem errors carry the full request dump (calldata hex and all) in
// `message`; `shortMessage` is the human-readable first line.
function errorText(err: Error | null | undefined): string {
  if (!err) return 'Transaction failed';
  const short = (err as { shortMessage?: string }).shortMessage;
  return short || err.message || 'Transaction failed';
}

export interface StakeCardProps {
  diemPrice: number | null;
  apy: number;
}

export function StakeCard({ diemPrice, apy }: StakeCardProps) {
  const [tab, setTab] = useState<Tab>('stake');
  const [amt, setAmt] = useState('1');
  const [amtEdited, setAmtEdited] = useState(false);
  const { isConnected } = useAccount();
  const { epoch, remainingSecs } = useEpochClock();

  const pool = usePoolStats();
  const user = useUserStats();

  const stakeMaxAmount = useMemo(() => {
    if (!isConnected || user.walletDiem == null) return null;

    let maxStakeable = user.walletDiem;
    if (pool.maxTotalStake != null && pool.maxTotalStake !== 0n) {
      const poolTotal = pool.totalStaked ?? 0n;
      const capRemaining = pool.maxTotalStake > poolTotal ? pool.maxTotalStake - poolTotal : 0n;
      maxStakeable = maxStakeable < capRemaining ? maxStakeable : capRemaining;
    }
    return maxStakeable;
  }, [isConnected, pool.maxTotalStake, pool.totalStaked, user.walletDiem]);

  const stakeDefaultAmt = useMemo(() => formatDiemInput(DEFAULT_STAKE_AMOUNT), []);

  const setAmtFromUser = (next: string) => {
    setAmtEdited(true);
    setAmt(next);
  };

  useEffect(() => {
    if (tab !== 'stake' || amtEdited) return;
    setAmt(stakeDefaultAmt);
  }, [amtEdited, stakeDefaultAmt, tab]);

  const onChangeTab = (next: Tab) => {
    setTab(next);
    setAmtEdited(false);
    if (next === 'stake') setAmt(stakeDefaultAmt);
    if (next === 'unstake') setAmt(user.stakedDiem ? formatDiemInput(user.stakedDiem) : '0');
  };

  // Lets sections outside the card (e.g. the claim banner) open the Claim tab.
  useEffect(() => {
    const openClaim = () => {
      setTab('claim');
      setAmtEdited(false);
    };
    window.addEventListener('diem:open-claim', openClaim);
    return () => window.removeEventListener('diem:open-claim', openClaim);
  }, []);

  const diemValue = parseFloat(amt) || 0;
  const poolDiem = toDiemNumber(pool.totalStaked);
  const usdcPerWeek = diemValue * MAX_USDC_PER_DIEM_PER_DAY * 7;
  const usdcPerYear = diemValue * MAX_USDC_PER_DIEM_PER_DAY * DAYS_PER_YEAR;
  const usdcPerMonth = usdcPerYear / 12;
  const amtUsd = diemPrice != null ? diemValue * diemPrice : null;

  const quickSet = (v: string) => {
    setAmtEdited(true);
    if (v === 'max') {
      if (tab === 'stake' && stakeMaxAmount != null) setAmt(formatDiemInput(stakeMaxAmount));
      else if (tab === 'unstake' && user.stakedDiem != null) setAmt(formatDiemInput(user.stakedDiem));
    } else {
      setAmt(v);
    }
  };

  const countdown = fmtDuration(remainingSecs);

  return (
    <div className="stake-wrap">
      <div className="stake-card">
        <div className="stake-head">
          <h2>Lock DIEM</h2>
          <div className="pool">
            Program TVL · <strong>{pool.totalStaked != null ? fmtNum(poolDiem) : '—'} $DIEM</strong>
          </div>
        </div>

        <div className="epoch-ribbon">
          <div className="er-dot" />
          <div className="er-text">
            <span className="er-lbl">Next $ANTS epoch · USDC allocations vary</span>
            <span className="er-val">{countdown}</span>
          </div>
          <div className="er-epoch">Epoch <strong>#{epoch}</strong></div>
        </div>

        <div className="stake-tabs">
          <button className={tab === 'stake' ? 'on' : ''} onClick={() => onChangeTab('stake')}>Lock</button>
          <button className={tab === 'unstake' ? 'on' : ''} onClick={() => onChangeTab('unstake')}>Withdraw</button>
          <button className={tab === 'claim' ? 'on' : ''} onClick={() => onChangeTab('claim')}>Claim</button>
        </div>

        {tab === 'stake' && (
          <StakePanel
            amt={amt}
            setAmt={setAmtFromUser}
            setQuick={quickSet}
            isConnected={isConnected}
            amtUsd={amtUsd}
            walletDiem={user.walletDiem}
            poolTotalStaked={pool.totalStaked}
            maxTotalStake={pool.maxTotalStake}
            maxStakeable={stakeMaxAmount}
            usdcPerWeek={usdcPerWeek}
            usdcPerMonth={usdcPerMonth}
            usdcPerYear={usdcPerYear}
            apy={apy}
          />
        )}

        {tab === 'unstake' && (
          <UnstakePanel
            amt={amt}
            setAmt={setAmtFromUser}
            setQuick={quickSet}
            isConnected={isConnected}
            stakedDiem={user.stakedDiem}
            amtUsd={amtUsd}
            diemCooldownSecs={pool.diemCooldownSecs}
            minUnstakeBatchOpenSecs={pool.minUnstakeBatchOpenSecs}
            flushableAt={pool.flushableAt}
          />
        )}

        {tab === 'claim' && (
          <ClaimPanel
            isConnected={isConnected}
            pendingUsdc={user.pendingUsdc}
            pendingAnts={user.pendingAnts}
            claimableAntsEpochs={user.claimableAntsEpochs}
            hasMoreClaimableAntsEpochs={user.hasMoreClaimableAntsEpochs}
          />
        )}

        <div className="stake-foot">
          <span>
            Venice cooldown · {pool.diemCooldownSecs != null ? fmtDuration(pool.diemCooldownSecs) : '—'}
          </span>
          <span>Network · Base mainnet</span>
        </div>
      </div>

      <Metrics
        apy={apy}
        pool={pool}
      />

      <FlowDiagram />
    </div>
  );
}


interface StakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  amtUsd: number | null;
  walletDiem: bigint | null;
  poolTotalStaked: bigint | null;
  maxTotalStake: bigint | null;
  maxStakeable: bigint | null;
  usdcPerWeek: number | null;
  usdcPerMonth: number | null;
  usdcPerYear: number | null;
  apy: number;
}

function StakePanel(props: StakePanelProps) {
  const { allowance, refetch: refetchAllowance } = useDiemAllowance();
  const approve = useApproveDiem();
  const stake = useStake();

  let parsedAmt: bigint = 0n;
  let amtInvalid = false;
  try {
    parsedAmt = props.amt ? parseEther(props.amt) : 0n;
  } catch {
    amtInvalid = true;
  }

  const capRemaining = useMemo(() => {
    if (props.maxTotalStake == null) return null;
    if (props.maxTotalStake === 0n) return null; // unlimited
    const pool = props.poolTotalStaked ?? 0n;
    return props.maxTotalStake > pool ? props.maxTotalStake - pool : 0n;
  }, [props.maxTotalStake, props.poolTotalStaked]);

  const capExceeded = capRemaining != null && parsedAmt > capRemaining;
  const insufficientBalance = props.walletDiem != null && parsedAmt > props.walletDiem;
  const needsApproval = allowance != null && parsedAmt > 0n && allowance < parsedAmt;

  const quickOptions = useMemo(() => {
    const fixed = [
      { label: '1', value: '1', amount: parseEther('1') },
      { label: '10', value: '10', amount: parseEther('10') },
      { label: '100', value: '100', amount: parseEther('100') },
      { label: '1,000', value: '1000', amount: parseEther('1000') },
    ];
    const shouldDisable = (amount: bigint) => {
      if (!props.isConnected) return false;
      if (props.maxStakeable == null) return true;
      return amount > props.maxStakeable;
    };

    return [
      ...fixed.map(({ label, value, amount }) => ({ label, value, disabled: shouldDisable(amount) })),
      { label: 'Max', value: 'max', disabled: props.isConnected && (props.maxStakeable == null || props.maxStakeable === 0n) },
    ];
  }, [props.isConnected, props.maxStakeable]);

  const disabled =
    !props.isConnected ||
    amtInvalid ||
    parsedAmt === 0n ||
    insufficientBalance ||
    capExceeded ||
    stake.isPending ||
    approve.isPending;

  return (
    <div className="panel-v2 stake-panel-v2">
      <InputField
        label="You lock"
        balanceLabel="Wallet"
        balanceValue={props.isConnected ? `${fmtDiem(toDiemNumber(props.walletDiem))} $DIEM` : 'Connect'}
        amt={props.amt}
        setAmt={props.setAmt}
        amtUsd={props.amtUsd}
      />
      <QuickSet options={quickOptions} onSet={props.setQuick} />

      <div className="stake-reward-summary">
        <div className="reward-summary-head">
          <span>Maximum estimate</span>
          <strong>Max {MAX_USDC_PER_DIEM_PER_DAY} USDC / DIEM / day</strong>
        </div>
        <div className="reward-summary-grid">
          <div className="reward-summary-card primary">
            <span>USDC / week*</span>
            <strong>{props.usdcPerWeek != null ? fmtUSD(props.usdcPerWeek) : '—'}</strong>
          </div>
          <div className="reward-summary-card">
            <span>Month</span>
            <strong>{props.usdcPerMonth != null ? fmtUSD(props.usdcPerMonth) : '—'}</strong>
          </div>
          <div className="reward-summary-card">
            <span>Year</span>
            <strong>{props.usdcPerYear != null ? fmtUSD(props.usdcPerYear) : '—'}</strong>
          </div>
          <div className="reward-summary-card accent">
            <span>Max rate</span>
            <strong>{fmtPct(props.apy)}</strong>
          </div>
        </div>
        <p className="reward-summary-note">
          *Informational only. Not a forecast, target, promise, APY, or guaranteed return.
          Future USDC allocations may be lower or zero.
        </p>
      </div>

      <div className="claim-note">
        DIEM participation is experimental. USDC allocations are not guaranteed and may be zero.
        Participation involves smart-contract risk, operator risk, token volatility and liquidity risk. By continuing, you agree to the{' '}
        <a href={DIEM_TERMS_URL} target="_blank" rel="noopener noreferrer">DIEM Provider Capacity Program Terms</a>.
      </div>

      {capExceeded && (
        <div className="claim-note">
          <strong>Over Program cap.</strong> Only {fmtDiem(toDiemNumber(capRemaining))} $DIEM of headroom remaining before the owner-set cap.
        </div>
      )}

      {props.isConnected ? (
        needsApproval ? (
          <button
            className="stake-cta"
            disabled={approve.isPending}
            onClick={async () => {
              await approve.run();
              refetchAllowance();
            }}
          >
            {approve.isPending ? 'Approving…' : `Approve $DIEM →`}
          </button>
        ) : (
          <button
            className="stake-cta"
            disabled={disabled}
            onClick={async () => {
              await stake.run(props.amt);
              props.setAmt('0');
            }}
          >
            {stake.isPending ? 'Locking…' : `Lock ${props.amt || '0'} $DIEM →`}
          </button>
        )
      ) : (
        <ConnectCta label="Connect wallet to lock DIEM →" />
      )}

      {(stake.error || approve.error) && (
        <div className="claim-note" style={{ color: '#c62828' }}>
          {errorText(stake.error ?? approve.error)}
        </div>
      )}
    </div>
  );
}


interface UnstakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  stakedDiem: bigint | null;
  amtUsd: number | null;
  diemCooldownSecs: number | null;
  minUnstakeBatchOpenSecs: number | null;
  flushableAt: number | null;
}

function UnstakePanel(props: UnstakePanelProps) {
  const initiate = useInitiateUnstake();
  const { state } = useUnstakeState();

  const stakedNum = toDiemNumber(props.stakedDiem);
  const unstakeQuickOptions = useMemo(() => {
    const staked = props.stakedDiem ?? 0n;
    const disabled = props.isConnected && staked === 0n;
    const pct = (value: bigint) => formatDiemInput((staked * value) / 100n);

    return [
      { label: '25%', value: pct(25n), disabled },
      { label: '50%', value: pct(50n), disabled },
      { label: '75%', value: pct(75n), disabled },
      { label: 'Max', value: 'max', disabled },
    ];
  }, [props.isConnected, props.stakedDiem]);

  let parsedAmt: bigint = 0n;
  try {
    parsedAmt = props.amt ? parseEther(props.amt) : 0n;
  } catch {
  }
  const amountTooLarge = props.stakedDiem != null && parsedAmt > props.stakedDiem;
  const disabled = !props.isConnected || parsedAmt === 0n || amountTooLarge || initiate.isPending;

  return (
    <div className="panel-v2 unstake-panel-v2">
      <div className="unstake-flow-card">
        <div className="unstake-flow-copy">
          <span className="panel-kicker">Withdraw $DIEM</span>
          <h3>Withdraw through a shared batch.</h3>
          <p>
            Withdrawal requests move through three on-chain states. Anyone in the batch can advance
            it, so the cost is shared instead of every participant paying alone.
          </p>
          <div className="unstake-timing">
            <span>Batch window · <strong>{props.minUnstakeBatchOpenSecs != null ? fmtDuration(props.minUnstakeBatchOpenSecs) : '—'}</strong></span>
            <span>Venice cooldown · <strong>{props.diemCooldownSecs != null ? fmtDuration(props.diemCooldownSecs) : '—'}</strong></span>
          </div>
        </div>
        <ol className="unstake-steps" aria-label="Withdrawal flow">
          <li><span>01</span><strong>Queued</strong><em>Join the open batch</em></li>
          <li><span>02</span><strong>Cooling</strong><em>Sent to Venice</em></li>
          <li><span>03</span><strong>Claimable</strong><em>Withdraw to wallet</em></li>
        </ol>
      </div>

      {/* Input only makes sense while the user has no active withdrawal in flight. */}
      {state.status === 'none' && (
        <>
          <InputField
            label="You withdraw"
            balanceLabel="Locked"
            balanceValue={props.isConnected ? `${fmtDiem(stakedNum)} $DIEM` : 'Connect'}
            amt={props.amt}
            setAmt={props.setAmt}
            amtUsd={props.amtUsd}
          />
          <QuickSet options={unstakeQuickOptions} onSet={props.setQuick} />
          {props.isConnected ? (
            <button
              className="stake-cta ghost unstake-cta"
              disabled={disabled}
              onClick={async () => {
                await initiate.run(props.amt);
                props.setAmt('0');
              }}
            >
              {initiate.isPending ? 'Queuing…' : 'Request withdrawal →'}
            </button>
          ) : (
            <ConnectCta label="Connect wallet to withdraw →" />
          )}
          {initiate.error && (
            <div className="claim-note" style={{ color: '#c62828' }}>
              {errorText(initiate.error)}
            </div>
          )}
        </>
      )}

      {/* Active state machine */}
      {state.status !== 'none' && (
        <UnstakeStateView state={state} flushableAt={props.flushableAt} />
      )}
    </div>
  );
}

function UnstakeStateView({
  state,
  flushableAt,
}: {
  state: UnstakeState;
  flushableAt: number | null;
}) {
  const flush = useFlush();
  const claim = useClaimUnstakeBatch();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (state.status !== 'cooling' && state.status !== 'queued') return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  if (state.status === 'none') return null;

  const amountDiem = fmtDiem(toDiemNumber(state.amount));

  if (state.status === 'queued') {
    const waitingForWindow = flushableAt != null && now < flushableAt;
    const windowRemaining = waitingForWindow ? flushableAt! - now : 0;
    const canFlush = !state.waitingForPriorBatch && !waitingForWindow;

    let message: string;
    if (state.waitingForPriorBatch) {
      message =
        'Waiting for the previous batch to finish claiming before your batch can start the cooldown. Anyone in that batch can click their Claim button to advance it.';
    } else if (waitingForWindow) {
      message =
        'Batch is still in its open window so other participants can join before it leaves for Venice. The counter below is the earliest time anyone can flush it — including you.';
    } else {
      message =
        'Your batch is ready to be sent to Venice. Click below to start the cooldown. Anyone in your batch can do this — pay once for the whole group.';
    }

    return (
      <div className="yield-box" style={{ marginTop: 8 }}>
        <div className="yield-row hero-row">
          <span className="lbl">Queued<span className="sub">batch #{state.batchId}</span></span>
          <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">Accrual</span>
          <span className="val">Stopped</span>
        </div>
        {waitingForWindow && (
          <div className="yield-row">
            <span className="lbl">Flushable in</span>
            <span className="val">{fmtDuration(windowRemaining)}</span>
          </div>
        )}
        <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--muted)' }}>
          {message}
        </p>
        <button
          className="stake-cta"
          disabled={!canFlush || flush.isPending}
          onClick={() => flush.run()}
        >
          {flush.isPending
            ? 'Starting cooldown…'
            : waitingForWindow
              ? `Flushable in ${fmtDuration(windowRemaining)}`
              : 'Start cooldown →'}
        </button>
        {flush.error && (
          <div className="claim-note" style={{ color: '#c62828' }}>{errorText(flush.error)}</div>
        )}
      </div>
    );
  }

  if (state.status === 'cooling') {
    const remaining = Math.max(0, state.unlockAt - now);
    return (
      <div className="yield-box" style={{ marginTop: 8 }}>
        <div className="yield-row hero-row">
          <span className="lbl">Cooling down<span className="sub">batch #{state.batchId}</span></span>
          <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">Ready in</span>
          <span className="val">{fmtDuration(remaining)}</span>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Venice's native withdrawal cooldown is counting down. Nothing to do — refresh when the timer hits zero.
        </p>
      </div>
    );
  }

  return (
    <div className="yield-box" style={{ marginTop: 8 }}>
      <div className="yield-row hero-row">
        <span className="lbl">Ready to withdraw<span className="sub">batch #{state.batchId}</span></span>
        <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
      </div>
      <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--muted)' }}>
        Your DIEM is ready. Clicking below finalises the withdrawal for your whole batch in one tx — this is cheaper than everyone paying individually.
      </p>
      <button
        className="stake-cta brand-fill"
        disabled={claim.isPending}
        onClick={() => claim.run(state.batchId)}
      >
        {claim.isPending ? 'Finalising…' : `Withdraw ${amountDiem} $DIEM →`}
      </button>
      {claim.error && (
        <div className="claim-note" style={{ color: '#c62828' }}>{errorText(claim.error)}</div>
      )}
    </div>
  );
}


interface ClaimPanelProps {
  isConnected: boolean;
  pendingUsdc: bigint | null;
  pendingAnts: bigint | null;
  claimableAntsEpochs: number[];
  hasMoreClaimableAntsEpochs: boolean;
}

function ClaimPanel(props: ClaimPanelProps) {
  const claimUsdc = useClaimUsdc();
  const claimAnts = useClaimAnts();

  const pendingUsdcNum = toUsdcNumber(props.pendingUsdc);
  const pendingAntsNum = toAntsNumber(props.pendingAnts);

  const claimableEpochs = props.claimableAntsEpochs.length;

  return (
    <div className="claim-panel-v2">
      <div className="claim-intro">
        <span className="claim-intro-kicker">Claims</span>
        <h3>Claim USDC and $ANTS right here.</h3>
        <p>
          Your wallet may have two allocation types. Both are claimed from this Program page:
          USDC whenever it is available, and eligible $ANTS incentives by completed epoch.
        </p>
      </div>

      <div className="claim-destination-card usdc-destination">
        <div className="claim-destination-top">
          <span className="destination-tag">This page</span>
          <span className="destination-type">USDC allocation</span>
        </div>
        <div className="destination-main">
          <div>
            <span className="destination-label">Claimable USDC</span>
            <strong>{pendingUsdcNum.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>
            <span className="destination-sub">Variable · claim when available</span>
          </div>
          <div className="mini-route" aria-hidden="true">
            <span>program</span>
            <i />
            <span>wallet</span>
          </div>
        </div>
        {props.isConnected ? (
          <button
            className="stake-cta brand-fill"
            disabled={props.pendingUsdc == null || props.pendingUsdc === 0n || claimUsdc.isPending}
            onClick={() => claimUsdc.run()}
          >
            {claimUsdc.isPending
              ? 'Claiming USDC…'
              : `Claim ${fmtUSD(pendingUsdcNum)} USDC →`}
          </button>
        ) : null}
      </div>

      <div className="claim-destination-card ants-destination">
        <div className="claim-destination-copy">
          <div className="claim-destination-top">
            <span className="destination-tag green">This page</span>
            <span className="destination-type">$ANTS emissions</span>
          </div>
          <div className="destination-main">
            <div>
              <span className="destination-label">Pending $ANTS</span>
              <strong>{fmtNum(pendingAntsNum)}</strong>
              <span className="destination-sub">
                {claimableEpochs > 0 ? `${claimableEpochs} unprocessed epoch${claimableEpochs === 1 ? '' : 's'}` : 'No unprocessed epochs'}
              </span>
            </div>
            <div className="mini-route" aria-hidden="true">
              <span>epochs</span>
              <i />
              <span>wallet</span>
            </div>
          </div>
          {props.isConnected ? (
            <button
              className="stake-cta brand-fill"
              disabled={claimableEpochs === 0 || claimAnts.isPending}
              onClick={() => claimAnts.run(props.claimableAntsEpochs)}
            >
              {claimAnts.isPending
                ? 'Claiming $ANTS…'
                : claimableEpochs === 0
                  ? 'No $ANTS epochs to claim'
                  : pendingAntsNum > 0
                    ? `Claim ${fmtNum(pendingAntsNum)} $ANTS →`
                    : `Process ${claimableEpochs} epoch${claimableEpochs === 1 ? '' : 's'} →`}
            </button>
          ) : null}
        </div>
      </div>

      {props.hasMoreClaimableAntsEpochs && (
        <div className="claim-note ants-claim-note">
          More $ANTS epochs may become claimable here after this batch is processed.
        </div>
      )}

      {claimableEpochs > 0 && props.pendingAnts === 0n && (
        <div className="claim-note ants-claim-note">
          Some claimable epochs may have no $ANTS payout, but processing them still clears
          the queue so later epochs appear.
        </div>
      )}

      {claimUsdc.error && (
        <div className="claim-note" style={{ color: '#c62828' }}>
          {errorText(claimUsdc.error)}
        </div>
      )}

      {claimAnts.error && (
        <div className="claim-note" style={{ color: '#c62828' }}>
          {errorText(claimAnts.error)}
        </div>
      )}

      {!props.isConnected && <ConnectCta label="Connect wallet to view claims →" />}
    </div>
  );
}


function ConnectCta({ label }: { label: string }) {
  return (
    <ConnectButton.Custom>
      {({ openConnectModal }) => (
        <button className="stake-cta" onClick={openConnectModal}>
          {label}
        </button>
      )}
    </ConnectButton.Custom>
  );
}

function InputField(props: {
  label: string;
  balanceLabel: string;
  balanceValue: string;
  amt: string;
  setAmt: (v: string) => void;
  amtUsd: number | null;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{props.label}</span>
        <span className="bal">{props.balanceLabel}: <strong>{props.balanceValue}</strong></span>
      </div>
      <div className="field-row">
        <input
          type="number"
          inputMode="decimal"
          placeholder="0.0"
          min="0"
          step="0.1"
          value={props.amt}
          onChange={(e) => props.setAmt(e.target.value)}
          disabled={props.disabled}
        />
        <span className="token-pill">
          <span className="icon-slot"><DiemLogo size={24} /></span>
          $DIEM
        </span>
      </div>
      <div className="field-usd">
        ≈ ${props.amtUsd != null ? props.amtUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} USD
      </div>
    </div>
  );
}

function QuickSet({
  options,
  onSet,
}: {
  options: Array<{ label: string; value: string; disabled?: boolean }>;
  onSet: (v: string) => void;
}) {
  return (
    <div className="quick-set">
      {options.map((o) => (
        <button key={`${o.label}-${o.value}`} disabled={o.disabled} onClick={() => onSet(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}


function Metrics(props: {
  apy: number;
  pool: ReturnType<typeof usePoolStats>;
}) {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="lbl">Total locked</div>
        <div className="val">{props.pool.totalStaked != null ? fmtDiemPrecise(toDiemNumber(props.pool.totalStaked)) : '—'}</div>
        <div className="delta">$DIEM</div>
      </div>
      <div className="metric">
        <div className="lbl">USDC allocated</div>
        <div className="val">
          {props.pool.totalUsdcDistributedEver != null
            ? fmtUSD(toUsdcNumber(props.pool.totalUsdcDistributedEver))
            : '—'}
        </div>
        <div className="delta">all time</div>
      </div>
      <div className="metric">
        <div className="lbl">Max rate</div>
        <div className="val" style={{ color: 'var(--brand-dark)' }}>{fmtPct(props.apy)}</div>
        <div className="delta">{MAX_USDC_PER_DIEM_PER_DAY} USDC / DIEM / day</div>
      </div>
      <div className="metric">
        <div className="lbl">Active participants</div>
        <div className="val">{props.pool.stakerCount != null ? fmtNum(props.pool.stakerCount) : '—'}</div>
        <div className="delta">live</div>
      </div>
    </div>
  );
}
