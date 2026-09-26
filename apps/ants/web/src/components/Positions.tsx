import { useMemo, useState, type MouseEvent } from 'react';
import type { ExtendRequest, MaxLockRequest, MergeRequest, MoveRequest, PoolConfigView, PoolView, PositionView, SplitRequest } from '../../../src/api-types';
import { positionActionEpoch, positionActionProblem, scheduledMaxLock, type PositionAction } from '../../../src/position-actions';
import { api } from '../api';
import { useEpochInfo } from '../app-context';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatBps, formatEpochLength, formatUtcDate, isPositiveDecimal, parseUnits, shortAddress, toBigInt } from '../format';
import { ActionButton, ActionDialog } from './Confirm';
import { EpochCell } from './Epoch';
import { ErrorBox } from './Feedback';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { Menu } from './Menu';
import { Panel } from './Panel';
import { Pill } from './Pill';
import { Table, type Column } from './Table';
import { Button } from './ui';
import { WithdrawAction } from './WithdrawAction';
import { InfoHelp } from './EarlyExitHelp';
import { formatYieldPercent, positionApy } from '../pool-yield';

export type RowActionKind = 'move' | 'extend' | 'withdraw' | 'split' | 'max-lock';
type BulkActionKind = 'merge' | 'withdraw';

export function PositionsCard({ pools, enabled = true }: { pools: PoolView[]; enabled?: boolean }) {
  const info = useEpochInfo();
  const page = usePageData(enabled ? 'positions:current' : null, api.positions);
  const [showClosed, setShowClosed] = useState(false);
  const [rowAction, setRowAction] = useState<{ id: number; kind: RowActionKind } | null>(null);
  const [bulkAction, setBulkAction] = useState<BulkActionKind | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  const data = page.data;
  const unavailable = page.reconciling || !!page.error;
  const allPositions = useMemo(() => data?.positions ?? [], [data]);
  const closedCount = useMemo(() => allPositions.filter((p) => !isOpen(p)).length, [allPositions]);
  const positions = useMemo(() => (showClosed ? allPositions : allPositions.filter(isOpen)), [allPositions, showClosed]);
  const actionRow = rowAction ? (positions.find((p) => p.id === rowAction.id) ?? null) : null;
  const poolById = useMemo(() => new Map(pools.map((p) => [p.agentId, p])), [pools]);
  const openPositions = useMemo(() => positions.filter(isOpen), [positions]);
  const selectedRows = useMemo(() => openPositions.filter((p) => selected.has(p.id)), [openPositions, selected]);
  const mergeProblem = mergeEligibility(selectedRows, info?.current);

  const openRowAction = (id: number, kind: RowActionKind) => setRowAction({ id, kind });
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected((current) => current.size === openPositions.length ? new Set() : new Set(openPositions.map((p) => p.id)));
  const clearSelection = () => setSelected(new Set());

  const stop = (e: MouseEvent) => e.stopPropagation();

  const columns: Array<Column<PositionView>> = [
    {
      key: 'select',
      className: 'col-select',
      label: openPositions.length > 0 ? (
        <input type="checkbox" aria-label="Select all open positions" disabled={unavailable} checked={selected.size > 0 && selected.size === openPositions.length} onChange={toggleAll} />
      ) : '',
      render: (p) => isOpen(p) ? <input type="checkbox" aria-label={`Select position ${p.id}`} disabled={unavailable} checked={selected.has(p.id)} onChange={() => toggle(p.id)} onClick={stop} /> : null,
    },
    {
      key: 'seller',
      label: 'Seller',
      render: (p) => {
        const pool = poolById.get(p.agentId);
        return (
          <span className="cell-stack" title={pool?.seller ?? undefined}>
            <span>{pool?.profile?.name?.trim() || (pool?.seller ? shortAddress(pool.seller) : 'Unknown seller')}</span>
            <span className="cell-sub">#{p.id}{maxLockLabel(p)}</span>
          </span>
        );
      },
    },
    { key: 'amount', label: 'Amount', align: 'right', mono: true, render: (p) => <span className="cell-stack">{formatAnts(p.amount, 4)}<span className="cell-sub" title={p.nextPower != null ? `Next epoch power: ${formatAnts(p.nextPower, 0)}` : undefined}>power {formatAnts(p.power ?? p.weightAmount, 0)}</span></span> },
    {
      key: 'apy',
      label: <>Est. APY<InfoHelp label="About position APY">Illustrative annualized return using the pool’s historical epoch reward budget and current pool power. Active positions use their current power, already included in the pool total. Pending positions use their activation power added to the current pool total; other pending changes are not projected. Assumes the rate repeats and compounds every epoch. Compounding is not automatic, normal-lock power declines, and activation delays are excluded. Missing data and closed or expired positions show —. Future rewards are not guaranteed.</InfoHelp></>,
      align: 'right',
      mono: true,
      render: (position) => {
        const pool = poolById.get(position.agentId);
        const epoch = data?.currentEpoch ?? info?.current;
        const apy = positionApy(position, pool, epoch, data?.config?.maxStakeEpochs);
        return <span title={apy === null ? 'APY unavailable for this position.' : `Based on ${pool?.yield?.status === 'estimated' ? 'estimated ' : ''}pool rewards in epoch ${pool?.yield?.epoch}.${epoch !== undefined && position.stakeStartEpoch > epoch ? ' Estimate for when this position activates.' : ''}`}>{formatYieldPercent(apy)}</span>;
      },
    },
    {
      key: 'unlocks',
      label: 'Unlocks',
      title: 'Epoch and date when the lock expires. Funds are not withdrawn automatically.',
      render: (p) => <PositionUnlock position={p} />,
    },
    { key: 'state', label: 'Status', title: 'The current stage of this staking position.', render: (p) => <StateBadge position={p} /> },
    { key: 'reward', label: 'Pending reward', align: 'right', mono: true, render: (p) => formatAnts(p.pendingReward, 4) },
    {
      key: 'actions',
      label: '',
      align: 'right',
      className: 'col-actions',
      render: (p) =>
        isOpen(p) && !unavailable ? (
          <span className="row-nowrap" onClick={stop}>
            <Menu
              label={`More actions for position ${p.id}`}
              items={[
                { label: 'Split', onSelect: () => openRowAction(p.id, 'split'), disabled: actionProblem(p, 'split', info?.current) !== null, title: actionProblem(p, 'split', info?.current) ?? undefined },
                { label: 'Extend lock', onSelect: () => openRowAction(p.id, 'extend'), disabled: actionProblem(p, 'extend', info?.current) !== null, title: actionProblem(p, 'extend', info?.current) ?? undefined },
                { label: willBeMaxLocked(p) ? 'Disable max lock' : 'Enable max lock', onSelect: () => openRowAction(p.id, 'max-lock') },
                { label: 'Move allocation', onSelect: () => openRowAction(p.id, 'move') },
                { label: 'Withdraw', onSelect: () => openRowAction(p.id, 'withdraw') },
              ]}
            />
          </span>
        ) : null,
    },
  ];

  return (
    <Panel
      title={`Your positions${data ? ` (${positions.length})` : ''}`}
      className="positions-card"
      actions={
        closedCount > 0 ? (
          <button type="button" className="link-button" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'hide closed' : `show ${closedCount} closed`}
          </button>
        ) : null
      }
    >
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {page.reconciling && !page.error ? <p role="status" className="hint">Updating… Waiting for the latest position data.</p> : null}
      {data?.historySource === 'local' ? <p className="hint">Includes closed positions from verified local transactions. Older history may be incomplete without an indexer.</p> : null}
      {data?.historySource === 'chain' ? <div className="status-line status-line--muted">Closed-position history is unavailable. Open positions are shown from the chain; rewards on closed positions may be missing.</div> : null}
      {selectedRows.length > 0 && !unavailable ? (
        <div className="bulk-bar" role="region" aria-label="Selected positions">
          <span className="bulk-bar-count">{selectedRows.length} selected · {formatAnts(sumAmounts(selectedRows), 4)} ANTS</span>
          <button type="button" className="link-button" onClick={clearSelection}>clear</button>
          <div className="bulk-bar-actions">
            <span className="btn-wrap" title={mergeProblem ?? 'Combine the selected positions into one.'}>
              <Button variant="outline" size="sm" disabled={mergeProblem !== null} onClick={() => setBulkAction('merge')}>Merge {selectedRows.length > 1 ? selectedRows.length : ''}</Button>
            </span>
            <Button variant="outline" size="sm" onClick={() => setBulkAction('withdraw')}>Withdraw {selectedRows.length}</Button>
          </div>
        </div>
      ) : null}
      {rowAction && actionRow && data && !unavailable ? <RowActionPanel key={`${rowAction.id}:${rowAction.kind}`} kind={rowAction.kind} position={actionRow} config={data.config} pools={pools} onClose={() => setRowAction(null)} /> : null}
      {bulkAction && data && selectedRows.length > 0 && !unavailable ? (
        <BulkActionPanel kind={bulkAction} positions={selectedRows} pools={pools} onClose={() => setBulkAction(null)} onStarted={() => { setBulkAction(null); clearSelection(); }} />
      ) : null}
      <Table
        columns={columns}
        rows={positions}
        rowKey={(p) => p.id}
        empty={!enabled ? 'Connect a wallet to see your positions.' : page.error ? 'Positions are currently unavailable.' : !data ? 'Loading positions…' : page.reconciling ? 'Updating positions…' : 'No open positions. Stake rewards into a seller to open one.'}
      />
      {data?.displaySource?.source === 'indexer' ? <p className="hint">Position status from Antscan. Withdrawal amounts and transaction eligibility are checked live before signing.</p> : null}
      {data?.rewardSource?.indexedBlock !== undefined ? <p className="hint">Reward estimates from Antscan at block {data.rewardSource.indexedBlock}.</p> : null}
      {data?.rewardSource?.error ? <p role="status" className="hint">Indexed rewards unavailable: {data.rewardSource.error}. Unknown amounts are shown as —, not zero.</p> : null}
    </Panel>
  );
}

function sumAmounts(positions: PositionView[]): string {
  return positions.reduce((sum, position) => sum + (toBigInt(position.amount) ?? 0n), 0n).toString();
}

export function mergeEligibility(positions: PositionView[], currentEpoch?: number): string | null {
  if (positions.length < 2) return 'Select at least two positions to merge.';
  if (new Set(positions.map(position => position.id)).size !== positions.length) return 'Select each position only once.';
  if (new Set(positions.map((p) => p.agentId)).size !== 1) return 'Merged positions must stake the same seller.';
  const effectiveEpoch = currentEpoch === undefined ? null : positionActionEpoch('merge', currentEpoch, positions);
  for (const position of positions) {
    const problem = positionActionProblem(position, 'merge', effectiveEpoch);
    if (problem) return problem;
  }
  if (new Set(positions.map((p) => p.stakeEndEpoch)).size !== 1) return 'Merged positions must share the same unlock epoch. Extend the shorter ones first.';
  return null;
}

/** Max-lock state the next action must reverse: the contract applies changes from the next epoch. */
export function willBeMaxLocked(p: PositionView): boolean {
  return scheduledMaxLock(p);
}

function maxLockLabel(p: PositionView): string {
  const next = willBeMaxLocked(p);
  if (next && p.maxLocked) return ' · max lock';
  if (next) return ' · max lock from next epoch';
  if (p.maxLocked) return ' · max lock ends next epoch';
  return '';
}

/** Open positions can be acted on; closed sources (split, merge, move) and withdrawn positions sit behind the toggle. */
function isOpen(p: PositionView): boolean {
  return !p.withdrawn && p.closedAtEpoch === 0 && p.state !== 'withdrawn' && p.state !== 'closed';
}

const STATE_TONE: Record<PositionView['state'], 'accent' | 'amber' | 'muted'> = { pending: 'amber', active: 'accent', matured: 'muted', closed: 'muted', withdrawn: 'muted' };
const STATE_DESCRIPTION: Record<PositionView['state'], string> = {
  pending: 'Waiting for the stake activation epoch.',
  active: 'The staking position is active and its lock has not expired.',
  matured: 'The lock has expired. Withdraw to receive your funds; withdrawal is not automatic.',
  closed: 'This position has been closed, for example by a split, merge, or move.',
  withdrawn: 'Funds have been withdrawn from this position.',
};

function StateBadge({ position }: { position: PositionView }) {
  const { state } = position;
  const activating = isOpen(position) && (state === 'pending' || position.changePending);
  return <Pill tone={activating ? 'amber' : STATE_TONE[state]} title={activating ? 'The transaction is confirmed. This position starts contributing staking power at its activation epoch.' : STATE_DESCRIPTION[state]}>{activating ? `Activates epoch ${position.stakeStartEpoch}` : state}</Pill>;
}

function actionProblem(position: PositionView, action: PositionAction, currentEpoch?: number): string | null {
  const effective = currentEpoch === undefined ? null : positionActionEpoch(action, currentEpoch, [position]);
  return positionActionProblem(position, action, effective);
}

function PositionUnlock({ position, dateOnly = false }: { position: PositionView; dateOnly?: boolean }) {
  const info = useEpochInfo();
  if (!isOpen(position)) return <span className="muted">—</span>;
  const nextEpoch = info ? `epoch ${info.current + 1}` : 'next epoch';
  if (willBeMaxLocked(position)) return <span className="cell-stack"><span className="muted" title="Disable max lock to start the countdown.">Max lock</span>{!position.maxLocked && <span className="cell-sub">Max lock starts {nextEpoch}</span>}</span>;
  return <span className="cell-stack"><EpochCell epoch={position.stakeEndEpoch} dateOnly={dateOnly} />{position.maxLocked && <span className="cell-sub">Countdown starts {nextEpoch}</span>}</span>;
}

function allocationSellerName(agentId: number, pools: PoolView[]): string {
  const pool = pools.find(pool => pool.agentId === agentId);
  return pool?.profile?.name?.trim() || (pool?.seller ? shortAddress(pool.seller) : 'Unknown seller');
}

export function PositionSummary({ position, pools }: { position: PositionView; pools: PoolView[] }) {
  const info = useEpochInfo();
  const remaining = position.epochsRemaining;
  const unlockDate = info ? formatUtcDate(epochStartAt(position.stakeEndEpoch, info.genesis, info.epochDuration)) : null;
  const startDate = info ? formatUtcDate(epochStartAt(position.stakeStartEpoch, info.genesis, info.epochDuration)) : null;
  return (
    <div>
      <div>{allocationSellerName(position.agentId, pools)} · <span className="mono">{formatAnts(position.amount, 4)} ANTS</span></div>
      <div className="muted small">
        {!isOpen(position) ? 'Position closed' : willBeMaxLocked(position) || position.maxLocked ? <PositionUnlock position={position} dateOnly /> : position.state === 'matured' ? 'Lock expired' : <>
          {position.state === 'pending' ? 'Lock duration' : 'Remaining lock'}: {remaining} {remaining === 1 ? 'epoch' : 'epochs'}
          {info ? ` (${position.state === 'pending' ? '' : 'up to '}${formatEpochLength(remaining * info.epochDuration)})` : ''}
          {position.state === 'pending' ? ` · starts ${startDate ? `${startDate} UTC` : `epoch ${position.stakeStartEpoch}`}` : ''}
        </>}
        {!position.maxLocked && isOpen(position) ? ` · ${position.state === 'matured' ? 'unlocked' : 'unlocks'} ${unlockDate ? `${unlockDate} UTC` : `epoch ${position.stakeEndEpoch}`}` : ''}
      </div>
    </div>
  );
}

function MoveForm({ position, config, pools, onStarted }: { position: PositionView; config: PoolConfigView; pools: PoolView[]; onStarted: () => void }) {
  const info = useEpochInfo();
  const targets = pools.filter((pool) => pool.stakeable && pool.agentId !== position.agentId);
  const [toAgent, setToAgent] = useState(() => String(targets[0]?.agentId ?? ''));
  const target = targets.find((p) => String(p.agentId) === toAgent) ?? null;
  const body: MoveRequest = { positionIds: [position.id], toAgentId: Number(toAgent) };
  const problem = actionProblem(position, 'move', info?.current);
  const effective = Math.max((info?.current ?? 0) + 1, position.stakeStartEpoch);
  return (
    <div className="form-row">
      <p className="hint">Move your allocation directly to another seller. Principal stays staked and the lock end date is preserved. Accrued rewards remain claimable on the source position.</p>
      <p className="hint">Effective {info ? `${formatUtcDate(epochStartAt(effective, info.genesis, info.epochDuration))} UTC (epoch ${effective})` : `epoch ${effective}`}. One transaction; your wallet will ask you to approve it.</p>
      {problem && <p className="error-text">{problem}</p>}
      <Field label="To seller" hint={config.moveWeightPenaltyBps === 0 ? 'No move penalty is currently configured. Moving does not burn your ANTS.' : `Moving reduces future staking power by ${formatBps(config.moveWeightPenaltyBps)}. Your ANTS principal is not burned.`} width="lg">
        <Select value={toAgent} onChange={(e) => setToAgent(e.target.value)} disabled={targets.length === 0}>
          {targets.length === 0 ? <option value="">No other seller to move to</option> : null}
          {targets.map((p) => (
            <option key={p.agentId} value={p.agentId}>
              {allocationSellerName(p.agentId, pools)}
            </option>
          ))}
        </Select>
      </Field>
      <ActionButton
        label="Move allocation"
        disabled={problem !== null}
        disabledReason={problem ?? undefined}
        variant="primary"
        path="/api/positions/move"
        body={body}
        validate={() => !target ? 'Choose a target seller.' : null}
        onStarted={onStarted}
      />
    </div>
  );
}

/** Carve `amount` out of a position into a new position with the same lock; both parts keep proportional power. */
function SplitForm({ position, onStarted }: { position: PositionView; onStarted: () => void }) {
  const info = useEpochInfo();
  const total = toBigInt(position.amount) ?? 0n;
  const weight = toBigInt(position.weightAmount) ?? 0n;
  const [amount, setAmount] = useState('');
  const units = isPositiveDecimal(amount) ? parseUnits(amount, 18) : null;
  const valid = units !== null && units > 0n && units < total;
  const secondWeight = valid ? (weight * units) / total : 0n;
  const problem = actionProblem(position, 'split', info?.current);
  const percent = (fraction: number) => setAmount(formatAnts((total * BigInt(Math.round(fraction * 10_000))) / 10_000n, 18).replace(/,/g, ''));
  const body: SplitRequest = { positionId: position.id, amount: amount.trim() };
  return (
    <div className="stack">
      <p className="hint">Splitting replaces this position with two positions with the same seller and lock terms. Power splits in proportion to the amount, so total power is unchanged. Disable max lock before splitting; you can enable it on the new positions before they activate.</p>
      {problem && <p className="error-text">{problem}</p>}
      <div className="form-row">
        <Input label="Amount to split off (ANTS)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" hint={<>
          of <span className="mono">{formatAnts(position.amount, 4)}</span> ·{' '}
          {[0.25, 0.5, 0.75].map((fraction) => <button key={fraction} type="button" className="link-button" style={{ marginRight: 8 }} onClick={() => percent(fraction)}>{fraction * 100}%</button>)}
        </>} />
      </div>
      <div className="split-preview" aria-live="polite">
        <div className="split-part">
          <span className="tile-label">Keeps position #{position.id}</span>
          <strong>{valid ? formatAnts(total - units, 4) : formatAnts(total, 4)} ANTS</strong>
          <span className="small muted">power {valid ? formatAnts(weight - secondWeight, 0) : formatAnts(weight, 0)}</span>
        </div>
        <div className="split-part split-part--new">
          <span className="tile-label">New position</span>
          <strong>{valid ? formatAnts(units, 4) : '—'} ANTS</strong>
          <span className="small muted">power {valid ? formatAnts(secondWeight, 0) : '—'}</span>
        </div>
      </div>
      <ActionButton
        label="Split position"
        variant="primary"
        path="/api/positions/split"
        body={body}
        disabled={problem !== null}
        disabledReason={problem ?? undefined}
        validate={() => {
          if (!isPositiveDecimal(amount)) return 'Amount must be a positive decimal number of ANTS.';
          if (units === null) return 'Amount must have no more than 18 decimal places.';
          if (units >= total) return `Amount must be below the position's ${formatAnts(position.amount, 4)} ANTS.`;
          if (secondWeight === 0n || weight - secondWeight === 0n) return 'Amount is too small: both parts need non-zero power.';
          return null;
        }}
        onStarted={onStarted}
      />
    </div>
  );
}

function MaxLockForm({ position, config, onStarted }: { position: PositionView; config: PoolConfigView; onStarted: () => void }) {
  const info = useEpochInfo();
  const enable = !willBeMaxLocked(position);
  const body: MaxLockRequest = { positionId: position.id, enable };
  const problem = actionProblem(position, enable ? 'enable-max-lock' : 'disable-max-lock', info?.current);
  const restartEnd = info ? info.current + 1 + config.maxStakeEpochs : null;
  return (
    <div className="stack">
      {enable ? (
        <>
          <p className="hint">Max lock pins this position at the maximum lock ({config.maxStakeEpochs} epochs{info ? `, ${formatEpochLength(config.maxStakeEpochs * info.epochDuration)}` : ''}) so its staking power stays at the maximum instead of decaying as the lock runs down.</p>
          <p className="hint">The lock no longer counts down. To withdraw later, disable max lock first: a fresh full countdown then starts from the next epoch. Disabling before activation does not restore the original shorter lock. Moves and merges require max lock to be disabled at their effective epoch.</p>
        </>
      ) : (
        <>
          <p className="hint">Disabling max lock starts a fresh {config.maxStakeEpochs}-epoch countdown from the next epoch{restartEnd !== null ? <> (unlocks <EpochCell epoch={restartEnd} dateOnly />)</> : null}. Power then decays as the lock runs down.</p>
          <p className="hint">Withdrawing before that countdown ends is an early exit and burns part of the principal.</p>
        </>
      )}
      {problem && <p className="error-text">{problem}</p>}
      <ActionButton
        label={enable ? 'Enable max lock' : 'Disable max lock'}
        variant={enable ? 'primary' : 'default'}
        path="/api/positions/max-lock"
        body={body}
        disabled={problem !== null}
        disabledReason={problem ?? undefined}
        onStarted={onStarted}
      />
    </div>
  );
}

interface RowActionProps {
  kind: RowActionKind;
  position: PositionView;
  config: PoolConfigView;
  pools?: PoolView[];
  onClose: () => void;
}

export function RowActionPanel({ kind, position, config, pools = [], onClose }: RowActionProps) {
  const info = useEpochInfo();
  const effectiveEpoch = info ? positionActionEpoch('extend', info.current, [position]) : null;
  const extensionStart = effectiveEpoch === null ? null : position.stakeEndEpoch;
  const maxAdd = extensionStart === null || effectiveEpoch === null ? 0 : Math.max(config.maxStakeEpochs - (extensionStart - effectiveEpoch), 0);
  const extendProblem = actionProblem(position, 'extend', info?.current);
  const [epochs, setEpochs] = useState(Math.min(1, maxAdd) || 1);
  const titles: Record<RowActionKind, string> = {
    move: 'Move allocation',
    extend: 'Extend position',
    split: 'Split position',
    'max-lock': willBeMaxLocked(position) ? 'Disable max lock' : 'Enable max lock',
    withdraw: 'Withdraw positions',
  };

  const extendBody: ExtendRequest = { positionId: position.id, epochs };
  const validateExtend = (): string | null => {
    if (extendProblem) return extendProblem;
    if (maxAdd <= 0) return `This position is already at the maximum lock (${config.maxStakeEpochs} epochs).`;
    if (epochs < 1 || epochs > maxAdd) return `At most ${maxAdd} more epoch(s) can be added (max lock ${config.maxStakeEpochs}).`;
    return null;
  };

  return (
    <ActionDialog title={titles[kind]} onClose={onClose}>
      {kind !== 'extend' ? <div className="small mb">
        <PositionSummary position={position} pools={pools} />
      </div> : null}
      {kind === 'withdraw' ? (
        <div className="stack">
          {position.changePending ? <div className="error-text">Withdrawals are blocked until activation epoch {position.withdrawableEpoch}. The position change is already confirmed.</div> : null}
          <WithdrawAction positionId={position.id} autoOpen onStarted={onClose} onCancel={onClose} />
        </div>
      ) : null}
      {kind === 'move' ? <MoveForm position={position} config={config} pools={pools} onStarted={onClose} /> : null}
      {kind === 'split' ? <SplitForm position={position} onStarted={onClose} /> : null}
      {kind === 'max-lock' ? <MaxLockForm position={position} config={config} onStarted={onClose} /> : null}
      {kind === 'extend' ? (
        <div className="stack">
          <dl className="facts">
            <dt>Amount</dt>
            <dd>{formatAnts(position.amount, 4)} ANTS</dd>
            <dt>Current unlock time</dt>
            <dd><PositionUnlock position={position} dateOnly /></dd>
          </dl>
          {extendProblem && <p className="error-text">{extendProblem}</p>}
          <LockSlider label="Add" value={epochs} min={1} max={Math.max(maxAdd, 1)} startEpoch={extensionStart} onChange={setEpochs} disabled={extendProblem !== null || maxAdd <= 0} showUnlockDate={false} />
          <dl className="facts" aria-live="polite">
            <dt>New unlock date</dt>
            <dd><EpochCell epoch={extensionStart !== null && maxAdd > 0 && !extendProblem ? extensionStart + epochs : null} dateOnly /></dd>
          </dl>
          <ActionButton
            label="Extend"
            variant="primary"
            path="/api/positions/extend"
            body={extendBody}
            disabled={extendProblem !== null || maxAdd <= 0}
            disabledReason={extendProblem ?? (maxAdd <= 0 ? 'This position is already at the maximum lock.' : undefined)}
            validate={validateExtend}
            onStarted={onClose}
          />
        </div>
      ) : null}
    </ActionDialog>
  );
}

/** Merge or withdraw several selected positions at once. */
export function BulkActionPanel({ kind, positions, pools, onClose, onStarted }: { kind: BulkActionKind; positions: PositionView[]; pools: PoolView[]; onClose: () => void; onStarted: () => void }) {
  const info = useEpochInfo();
  const ids = positions.map((p) => p.id);
  const mergeProblem = mergeEligibility(positions, info?.current);
  const mergeBody: MergeRequest = { positionIds: ids };
  const first = positions[0]!;
  return (
    <ActionDialog title={kind === 'merge' ? `Merge ${positions.length} positions` : `Withdraw ${positions.length} positions`} onClose={onClose}>
      <div className="stack">
        <dl className="facts">
          {positions.map((position) => (
            <PositionFact key={position.id} position={position} pools={pools} />
          ))}
          <dt>Total</dt>
          <dd>{formatAnts(sumAmounts(positions), 4)} ANTS</dd>
        </dl>
        {kind === 'merge' ? (
          <>
            <p className="hint">Merging combines these positions into one position of {formatAnts(sumAmounts(positions), 4)} ANTS in {allocationSellerName(first.agentId, pools)} with the shared unlock epoch {first.stakeEndEpoch}. Power is preserved. The source positions close; their accrued rewards stay claimable. The contract verifies matching underlying lock start and end terms before wallet approval; matching unlock dates alone are not sufficient.</p>
            {mergeProblem ? <p className="error-text">{mergeProblem}</p> : null}
            <ActionButton label="Merge positions" variant="primary" path="/api/positions/merge" body={mergeBody} disabled={mergeProblem !== null} disabledReason={mergeProblem ?? undefined} onStarted={onStarted} />
          </>
        ) : (
          <>
            {positions.some((p) => p.changePending) ? <div className="error-text">A selected position has not activated. Withdrawals remain blocked until its activation epoch.</div> : null}
            <WithdrawAction positionIds={ids} autoOpen onStarted={onStarted} onCancel={onClose} />
          </>
        )}
      </div>
    </ActionDialog>
  );
}

function PositionFact({ position, pools }: { position: PositionView; pools: PoolView[] }) {
  return (
    <>
      <dt>#{position.id} · {allocationSellerName(position.agentId, pools)}</dt>
      <dd>{formatAnts(position.amount, 4)} ANTS · <PositionUnlock position={position} dateOnly /></dd>
    </>
  );
}
