import { useState } from 'react';
import type { UsageEpochView } from '../../../src/api-types';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePageData } from '../data';
import { formatAnts, formatInt } from '../format';
import { AddressLink } from './AddressLink';
import { Details } from './Details';
import { EpochCell } from './Epoch';
import { ErrorBox } from './Feedback';
import { Select } from './Field';
import { Facts, Panel } from './Panel';
import { Table, type Column } from './Table';

const EPOCH_OPTIONS = [4, 8, 12, 26, 52];

/** Your usage points per epoch with network totals; weighted columns and policies are opt-in. */
export function UsageSection() {
  const { overview } = useApp();
  const [epochs, setEpochs] = useState(8);
  const [weighted, setWeighted] = useState(false);
  const page = usePageData(`usage:${epochs}`, () => api.usage(epochs));
  const data = page.data;

  const columns: Array<Column<UsageEpochView>> = [
    { key: 'epoch', label: 'Epoch', render: (r) => <EpochCell epoch={r.epoch} /> },
    { key: 'buyer', label: 'Your buyer pts', align: 'right', mono: true, render: (r) => formatInt(r.buyerPoints) },
    ...(weighted ? [{ key: 'wbuyer', label: 'Weighted', align: 'right', mono: true, title: 'Buyer points after pool weighting', render: (r: UsageEpochView) => formatInt(r.weightedBuyerPoints) } satisfies Column<UsageEpochView>] : []),
    { key: 'seller', label: 'Your seller pts', align: 'right', mono: true, render: (r) => formatInt(r.sellerPoints) },
    { key: 'nbuyer', label: 'Network buyer', align: 'right', mono: true, render: (r) => formatInt(r.totalBuyerPoints) },
    { key: 'nseller', label: 'Network seller', align: 'right', mono: true, render: (r) => formatInt(r.totalSellerPoints) },
    { key: 'pool', label: 'Pool pts', align: 'right', mono: true, render: (r) => formatInt(r.totalPoolPoints) },
    ...(weighted ? [{ key: 'wpool', label: 'Weighted pool pts', align: 'right', mono: true, render: (r: UsageEpochView) => formatInt(r.totalWeightedPoolPoints) } satisfies Column<UsageEpochView>] : []),
  ];

  const startEpoch = data?.firstRewardedEpoch ?? overview?.epoch.effective ?? null;
  const emptyText =
    startEpoch !== null && (data ? data.currentEpoch < startEpoch : true)
      ? `Usage accounting starts at epoch ${startEpoch}.`
      : 'No usage has been recorded for this wallet in the selected epochs.';

  return (
    <Panel
      title="Your usage · historical network comparisons"
      actions={
        <>
          <label className="check small">
            <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} />
            weighted columns
          </label>
          <label className="row small">
            <span className="muted">epochs</span>
            <Select value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} style={{ width: 72, minHeight: 30, padding: '4px 8px' }}>
              {EPOCH_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        </>
      }
    >
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {data && <p className="hint">{data.source === 'indexer' ? 'Historical rows are indexed data and may lag the current contract snapshot.' : 'Historical rows are unavailable without the explorer; current totals are read from the chain.'}{data.sourceError ? ` ${data.sourceError}` : ''}</p>}
      <Facts
        items={[
          ['Your buyer points', data ? formatInt(data.totals.buyerPoints) : '…'],
          ['Network buyer points', data ? formatInt(data.totals.networkBuyerPoints) : '…'],
          ['Network seller points', data ? formatInt(data.totals.networkSellerPoints) : '…'],
          ['First rewarded epoch', data ? (data.firstRewardedEpoch ?? '—') : '…'],
        ]}
      />
      <div className="mt">
        <Table
          columns={columns}
          rows={data?.epochs ?? []}
          rowKey={(r) => r.epoch}
          loading={page.loading && !data}
          empty={emptyText}
          footer={
            data && data.epochs.length > 0 ? (
              <tr>
                <td>Total</td>
                <td className="num mono">{formatInt(data.totals.buyerPoints)}</td>
                {weighted ? <td className="num mono">{formatInt(data.totals.buyerWeightedPoints)}</td> : null}
                <td className="num mono">{formatInt(sumPoints(data.epochs.map((e) => e.sellerPoints)))}</td>
                <td className="num mono">{formatInt(data.totals.networkBuyerPoints)}</td>
                <td className="num mono">{formatInt(data.totals.networkSellerPoints)}</td>
                <td />
                {weighted ? <td /> : null}
              </tr>
            ) : null
          }
        />
      </div>
      <Details summary="Policies">
        <Facts
          items={[
            ['Points policy', data?.pointsPolicy ? <AddressLink value={data.pointsPolicy} short={false} /> : <span className="muted">not set</span>],
            ['Pool weight policy', data?.poolWeightPolicy ? <AddressLink value={data.poolWeightPolicy} short={false} /> : <span className="muted">not set</span>],
            ['Minimum accounted pool power', data?.minimumAccountedPoolPower ? `${formatAnts(data.minimumAccountedPoolPower, 4)} ANTS` : '—'],
            ['Your weighted buyer points', data ? formatInt(data.totals.buyerWeightedPoints) : '…'],
          ]}
        />
        <p className="hint mt">Points are raw usage units recorded on chain per epoch. Weighted points apply the pool weight policy; pools below the minimum accounted power earn no usage rewards.</p>
      </Details>
    </Panel>
  );
}

function sumPoints(values: string[]): string {
  return values
    .reduce<bigint>((sum, v) => {
      try {
        return sum + BigInt(v);
      } catch {
        return sum;
      }
    }, 0n)
    .toString();
}
