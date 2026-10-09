import { useMemo, useState } from 'react'
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { Alert, ShareBars } from '@antseed/ui'
import { useWalletAttention } from '../lib/attention'
import { api } from '../api'
import type { GatewayStatus, LimitPeriod, SpendLimits, UsageReport, Wallet } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { chartDescription, METRICS, UsageByModel } from '../components/UsageByModel'
import { Badge, EmptyState, ErrorAlert, Figure, LoadingRows, PageHeader, PageLink, Panel, Segmented, StatTile } from '../components/ui'
import { formatDuration, formatNumber, formatUsd, periodStart, usdcToNumber } from '../lib/format'
import { isWorkspaceAdmin } from '../lib/nav'
import { budgetWarnings, runway } from '../lib/budget'
import { qk, useStatus, useWallet, useWorkspace } from '../lib/queries'
import type { SeriesMetric } from '../lib/usage'

const PERIODS: Array<{ period: Exclude<LimitPeriod, 'total'>; label: string }> = [
  { period: 'daily', label: 'Today' },
  { period: 'weekly', label: 'This week' },
  { period: 'monthly', label: 'This month' },
]

type Runway = ReturnType<typeof runway>

/** Share of the budget used: full for a zero budget, none without a budget or spend figure. */
function budgetMeter(spent: number | null, cap: number | null): number | null {
  if (cap && spent !== null) return spent / cap
  if (cap === 0) return 1
  return null
}

function BudgetTile({ label, spent, limit }: { label: string; spent: number | null; limit: string | null }) {
  const cap = limit === null ? null : usdcToNumber(limit)
  return (
    <StatTile label={`Spend ${label.toLowerCase()}`} value={spent === null ? '…' : formatUsd(spent)}
      sub={cap === null ? 'No budget' : `of ${formatUsd(cap)} budget`}
      meter={budgetMeter(spent, cap)} />
  )
}

function runwayText(funds: Runway | null): string {
  if (!funds) return '…'
  if (funds.days === null) return 'No recent spend'
  return formatRunway(funds.days)
}

function BalanceFigures({ wallet, funds }: { wallet: UseQueryResult<Wallet>; funds: Runway | null }) {
  if (wallet.isLoading) return <LoadingRows rows={1} height={48} />
  if (wallet.error) return <ErrorAlert error={wallet.error} onRetry={() => void wallet.refetch()} />
  if (!wallet.data) return null
  return (
    <div className="gc-grid gc-grid--4 gc-figures">
      <Figure label="Available" value={formatUsd(wallet.data.available)} strong />
      <Figure label="Reserved in channels" value={formatUsd(wallet.data.reserved)} />
      <Figure label="In wallet, not deposited" value={formatUsd(wallet.data.walletUsdc)} />
      <Figure label="Runway" value={runwayText(funds)} />
    </div>
  )
}

function GatewayFigures({ status }: { status: UseQueryResult<GatewayStatus> }) {
  if (status.isLoading) return <LoadingRows rows={1} height={40} />
  if (status.error) return <ErrorAlert error={status.error} />
  if (!status.data) return null
  const { buyer } = status.data
  return (
    <div className="gc-grid gc-grid--4 gc-figures">
      <Figure label="Buyer" value={buyer.reachable ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Unreachable</Badge>} />
      <Figure label="Sellers seen" value={formatNumber(buyer.peers)} />
      <Figure label="DHT nodes" value={formatNumber(buyer.dhtNodes)} />
      <Figure label="Buyer uptime" value={buyer.uptimeMs === null ? '—' : formatDuration(buyer.uptimeMs)} />
    </div>
  )
}

export default function Overview() {
  const { workspace, viewer } = useConsole()
  const scope = useScopeFilter()
  const admin = isWorkspaceAdmin(viewer)
  const detail = useWorkspace(workspace.id)
  const wallet = useWallet(workspace.id, admin)
  const status = useStatus()
  const now = Date.now()
  const [chartNow] = useState(now)
  const [metric, setMetric] = useState<SeriesMetric>('spend')
  const chartFilter = useMemo(() => ({ ...scope }), [scope.workspace, scope.member])
  const spend = useQueries({
    queries: PERIODS.map(({ period }) => {
      const from = periodStart(period, now)
      return { queryKey: qk.usage({ ...scope, from, groupBy: 'day' }), queryFn: () => api.usage.report({ ...scope, from, groupBy: 'day' }) }
    }),
  })
  const monthFrom = periodStart('monthly', now)
  const byKey = useQuery({ queryKey: qk.usage({ ...scope, from: monthFrom, groupBy: 'key' }), queryFn: () => api.usage.report({ ...scope, from: monthFrom, groupBy: 'key' }) })
  const byModel = useQuery({ queryKey: qk.usage({ ...scope, from: monthFrom, groupBy: 'model' }), queryFn: () => api.usage.report({ ...scope, from: monthFrom, groupBy: 'model' }) })

  // The 7 full UTC days before today, so the key stays stable between renders.
  const weekTo = periodStart('daily', now)
  const weekFrom = weekTo - 7 * 86_400_000
  const lastWeek = useQuery({
    queryKey: qk.usage({ workspace: workspace.id, from: weekFrom, to: weekTo, groupBy: 'day' }),
    queryFn: () => api.usage.report({ workspace: workspace.id, from: weekFrom, to: weekTo - 1, groupBy: 'day' }),
    enabled: admin,
  })

  const attention = useWalletAttention()
  const limits: SpendLimits | null = detail.data?.limits ?? null
  const month = spend[2]?.data
  const spentIn = (index: number): number | null => {
    const report = spend[index]?.data
    return report ? usdcToNumber(report.totals.spent) : null
  }
  const warnings = budgetWarnings(limits, PERIODS.map(({ period }, index) => [period, spentIn(index)]))
  const funds = wallet.data && lastWeek.data ? runway(usdcToNumber(wallet.data.available), usdcToNumber(lastWeek.data.totals.spent), 7) : null

  return (
    <div className="gc-page">
      <PageHeader title="Overview" description={`${workspace.name} workspace${scope.member ? ' · your usage' : ''}`} />

      {funds?.low && (
        <Alert tone={funds.days !== null && funds.days < 1 ? 'danger' : 'warning'} title="Balance is running low"
          action={<PageLink to="wallet">Add funds</PageLink>}>
          {funds.days === null
            ? `Only ${formatUsd(funds.available)} is available.`
            : `${formatUsd(funds.available)} available lasts about ${formatRunway(funds.days)} at last week's pace (${formatUsd(funds.dailySpend)} a day).`}
        </Alert>
      )}
      {attention.currentMissingOperator && (
        <Alert tone="warning" title="No authorized wallet" action={<PageLink to="wallet">{attention.canAuthorize ? 'Authorize a wallet' : 'View wallet'}</PageLink>}>
          {attention.canAuthorize
            ? `Nobody can withdraw ${workspace.name}'s funds or claim its ANTS rewards until you authorize one of your wallets. Requests keep working.`
            : `Nobody can withdraw ${workspace.name}'s funds or claim its ANTS rewards until the organization owner authorizes a wallet. Requests keep working.`}
        </Alert>
      )}
      {attention.withdrawable.count > 0 && (
        <Alert tone="warning" title={`${attention.withdrawable.count} channel${attention.withdrawable.count === 1 ? '' : 's'} ready to withdraw`} action={<PageLink to="wallet">Withdraw</PageLink>}>
          About {formatUsd(attention.withdrawable.amount)} of unused reserve can return to the balance.
        </Alert>
      )}
      {warnings.map((warning) => (
        <Alert key={warning.period} tone={warning.reached ? 'danger' : 'warning'} title={warning.reached ? `${warning.label} budget reached` : `${warning.label} budget almost used`}>
          {warning.reached
            ? `${workspace.name} has spent ${formatUsd(warning.spent)} of its ${formatUsd(warning.limit)} ${warning.label.toLowerCase()} budget. New requests are refused until the period resets.`
            : `${Math.round(warning.fraction * 100)}% of the ${formatUsd(warning.limit)} ${warning.label.toLowerCase()} budget is used.`}
        </Alert>
      ))}

      <div className="gc-grid gc-grid--4">
        {PERIODS.map(({ period, label }, index) => (
          <BudgetTile key={period} label={label} spent={spentIn(index)} limit={limits?.[period] ?? null} />
        ))}
        <StatTile label="Requests this month" value={month ? formatNumber(month.totals.requests) : '…'}
          sub={month ? `${formatNumber(month.totals.failedRequests)} failed` : undefined} />
      </div>

      <Panel title="Last 7 days" description={chartDescription(metric, '7d')}
        actions={<>
          <Segmented label="Chart metric" value={metric} onChange={setMetric} options={METRICS} />
          <PageLink to="activity">All activity</PageLink>
        </>}>
        <UsageByModel filter={chartFilter} range="7d" now={chartNow} metric={metric} height={200} />
      </Panel>

      {admin && (
        <Panel title="Balance" actions={<PageLink to="wallet">Add funds</PageLink>}>
          <BalanceFigures wallet={wallet} funds={funds} />
        </Panel>
      )}

      <div className="gc-grid gc-grid--2">
        <Panel title="Top keys this month">
          <TopList report={byKey.data} loading={byKey.isLoading} error={byKey.error} empty="No spend this month." />
        </Panel>
        <Panel title="Top models this month">
          <TopList report={byModel.data} loading={byModel.isLoading} error={byModel.error} empty="No spend this month." />
        </Panel>
      </div>

      <Panel title="Gateway">
        <GatewayFigures status={status} />
      </Panel>
    </div>
  )
}

function formatRunway(days: number): string {
  if (days < 1) return 'under a day'
  if (days < 60) return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`
  return `${Math.floor(days / 30)} months`
}

function TopList({ report, loading, error, empty }: { report?: UsageReport; loading: boolean; error: unknown; empty: string }) {
  if (loading) return <LoadingRows rows={4} height={22} />
  if (error) return <ErrorAlert error={error} />
  const items = (report?.groups ?? [])
    .map((group) => ({ label: group.label || group.group, value: usdcToNumber(group.spent), sub: `${formatNumber(group.requests)} requests` }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
  if (items.length === 0) return <EmptyState title={empty} />
  return <ShareBars items={items} format={formatUsd} />
}
