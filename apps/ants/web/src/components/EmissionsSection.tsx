import type { NetworkSnapshot } from '../../../src/api-types';
import { formatAnts, formatShare, formatUsdc } from '../format';
import { emissionPercent } from '../network-display';
import { Details } from './Details';
import { InfoHelp } from './EarlyExitHelp';
import { Facts, Panel } from './Panel';
import { Table, type Column } from './Table';

export function networkAnts(value: string | null): string {
  return value === null ? 'Unavailable' : `${formatAnts(value)} ANTS`;
}

const NAMES: Record<string, string> = { 'seller-pools': 'Seller pools', usage: 'Usage rewards', team: 'Team', reserve: 'Reserve — base allowance', verification: 'Verification' };

export function EmissionsSection({ data }: { data: NetworkSnapshot }) {
  const columns: Array<Column<NetworkSnapshot['buckets'][number]>> = [
    { key: 'name', label: 'Bucket', render: bucket => NAMES[bucket.name] ?? bucket.name },
    { key: 'share', label: 'Share of scheduled emission', align: 'right', mono: true, render: bucket => emissionPercent(bucket.budget, data.emission) },
    { key: 'budget', label: 'Bucket allowance', align: 'right', mono: true, render: bucket => networkAnts(bucket.budget) },
  ];
  const rewardRows = [
    { name: 'Staker rewards', budget: data.budgets.staker },
    { name: 'Buyer usage rewards', budget: data.budgets.buyer },
    { name: 'Seller usage rewards', budget: data.budgets.seller },
  ];
  const changedBuckets = data.buckets.filter(bucket => bucket.budget !== null && bucket.nextBudget !== null && bucket.budget !== bucket.nextBudget);
  const staker = data.stakerConfig;
  const usage = data.usageConfig;
  const nextStaker = data.nextStakerConfig;
  const nextUsage = data.nextUsageConfig;
  const stakerChanged = staker && nextStaker && JSON.stringify(staker) !== JSON.stringify(nextStaker);
  const usageChanged = usage && nextUsage && JSON.stringify(usage) !== JSON.stringify(nextUsage);
  const range = (minimum: number, maximum: number) => `${formatShare(minimum, data.shareDenominator)} – ${formatShare(maximum, data.shareDenominator)}`;
  return <>
    <Panel title={<>{`Current epoch reward budgets · epoch ${data.epoch.current}`} <InfoHelp label="When reward budgets become final" symbol="i">Budgets can change during the epoch. After it ends, each reward contract fixes its budgets on the first claim or settlement—not at rollover.</InfoHelp></>}>
      <p className="hint">Live network-wide budgets—not your wallet rewards or amounts already paid.</p>
      <Table columns={[
        { key: 'name', label: 'Recipient', render: row => row.name },
        { key: 'budget', label: 'Calculated epoch budget', align: 'right', mono: true, render: row => networkAnts(row.budget) },
        { key: 'share', label: 'Share of epoch emission', align: 'right', mono: true, render: row => emissionPercent(row.budget, data.emission) },
      ]} rows={rewardRows} rowKey={row => row.name} />
      <Details summary="How these budgets are calculated">
        <div className="section-label">Staker rewards</div>
        {staker ? <Facts items={[
          ['Configured share range', range(staker.minShareBps, staker.maxShareBps)],
          ['Network active stake used by the contract', networkAnts(data.totalActiveStake)],
          ['Stake target for this epoch', networkAnts(data.scaledStakeTarget)],
          ['Initial-emission stake target', networkAnts(staker.stakeShareTarget)],
          ['Seller-pools budget cap', networkAnts(data.buckets.find(bucket => bucket.name === 'seller-pools')?.budget ?? null)],
        ]} /> : <p className="muted">Staker configuration unavailable.</p>}
        <p className="hint">With positive active stake, the share rises toward the configured maximum as stake grows. The stake target scales with the epoch emission; it is not a hard threshold. Zero active stake produces a zero budget.</p>
        <div className="section-label mt">Buyer and seller rewards</div>
        {usage ? <Facts items={[
          ['Buyer share range', range(usage.buyerMinShareBps, usage.buyerMaxShareBps)],
          ['Seller share range', range(usage.sellerMinShareBps, usage.sellerMaxShareBps)],
          ['Accounted usage input', data.usageVolume === null ? 'Unavailable' : `${formatUsdc(data.usageVolume)} USDC-equivalent`],
          ['Usage target', `${formatUsdc(usage.volumeShareTarget)} USDC-equivalent / epoch`],
          ['Combined usage budget cap', networkAnts(data.buckets.find(bucket => bucket.name === 'usage')?.budget ?? null)],
        ]} /> : <p className="muted">Usage configuration unavailable.</p>}
        <p className="hint">The usage input is the larger of the epoch’s total buyer points and total seller points—not their sum. With positive usage, each share rises toward its maximum. If the combined desired budgets exceed the usage bucket limit, the contract scales them proportionally. Zero usage produces zero budgets.</p>
        <p className="hint">For a positive input, the curve is minimum + (maximum − minimum) × input / (input + target), with contract integer rounding. A zero target selects the maximum. Displayed budgets come directly from contract getters, not a browser calculation.</p>
      </Details>
    </Panel>
    <Panel title={`Emission bucket allowances · epoch ${data.epoch.current}`}>
      <p className="hint">Bucket limits, not payouts. Shares use this epoch’s scheduled emission.</p>
      <Table columns={columns} rows={data.buckets} rowKey={bucket => bucket.id} empty="No emission buckets available." />
      <p className="hint mt">Unallocated seller-pool and usage allowances go to the burn destination (combined cap: 30% of scheduled emission), then Reserve on top of its base allowance. Requires an on-chain settlement.</p>
      {(changedBuckets.length > 0 || stakerChanged || usageChanged || data.nextEmission !== data.emission) && <Details summary={`Next epoch · ${data.epoch.current + 1}`}>
        <Facts items={[
          ['Scheduled emission', networkAnts(data.nextEmission)],
          ...changedBuckets.map(bucket => [NAMES[bucket.name] ?? bucket.name, `${networkAnts(bucket.nextBudget)} · ${emissionPercent(bucket.nextBudget, data.nextEmission)}`] as [string, string]),
          ...(stakerChanged ? [['Staker share range', range(nextStaker.minShareBps, nextStaker.maxShareBps)], ['Staker target at initial emission', networkAnts(nextStaker.stakeShareTarget)]] as [string, string][] : []),
          ...(usageChanged ? [['Buyer share range', range(nextUsage.buyerMinShareBps, nextUsage.buyerMaxShareBps)], ['Seller share range', range(nextUsage.sellerMinShareBps, nextUsage.sellerMaxShareBps)], ['Usage target', `${formatUsdc(nextUsage.volumeShareTarget)} USDC-equivalent / epoch`]] as [string, string][] : []),
        ]} />
        <p className="hint">Next-epoch allowances and configuration are shown separately. They are not a prediction of next epoch’s earned rewards.</p>
      </Details>}
    </Panel>
  </>;
}
