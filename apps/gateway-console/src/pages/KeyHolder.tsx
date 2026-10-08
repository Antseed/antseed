import { useQuery } from '@tanstack/react-query'
import { BarChart, Button } from '@antseed/ui'
import { api } from '../api'
import type { LimitPeriod } from '../api/types'
import { RequestLog } from '../components/RequestLog'
import { Brand, ThemeToggle, useSignOut } from '../components/Shell'
import { Badge, DetailList, PageHeader, Panel, QueryView, StatTile } from '../components/ui'
import { Icon } from '../components/icons'
import { formatDate, formatNumber, formatRelative, formatUsd, LIMIT_PERIODS, PERIOD_LABELS, periodStart, usdcToNumber } from '../lib/format'
import { describePolicy } from '../lib/policy'
import { qk, useMe } from '../lib/queries'
import { dailySeries, rangeFrom } from '../lib/usage'

/** Read-only view for someone signed in with an API key: that key's limits, usage and requests. */
export default function KeyHolder() {
  const signOut = useSignOut()
  const me = useMe()
  const key = me.data?.kind === 'key' ? me.data.me.key : null
  const now = Date.now()
  const from = rangeFrom('30d', now)
  const daily = useQuery({ queryKey: qk.usage({ key: key?.id, from, groupBy: 'day' }), queryFn: () => api.usage.report({ key: key!.id, from, to: now, groupBy: 'day' }), enabled: !!key })
  const periods = useQuery({
    queryKey: ['key-periods', key?.id],
    enabled: !!key,
    queryFn: async () => {
      const entries = await Promise.all((['daily', 'weekly', 'monthly'] as const).map(async (period) => {
        const report = await api.usage.report({ key: key!.id, from: periodStart(period, now) })
        return [period, usdcToNumber(report.totals.spent)] as const
      }))
      return Object.fromEntries([...entries, ['total', usdcToNumber(key!.usage.spent)]]) as Record<LimitPeriod, number>
    },
  })

  return (
    <div className="gc-keyholder">
      <header className="gc-topbar">
        <div className="gc-topbar__inner">
          <Brand to={null} tagged />
          <div className="gc-topbar__spacer" />
          <ThemeToggle />
          <Button variant="outline" size="sm" leadingIcon={<Icon.logout size={14} />} onClick={() => void signOut()}>Sign out</Button>
        </div>
      </header>
      <main className="gc-main" id="gc-main">
        {key && (
          <div className="gc-page">
            <PageHeader title={key.label} description={<>Key <code>{key.hint}</code> · {key.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Revoked</Badge>}</>} />
            <div className="gc-grid gc-grid--4">
              {LIMIT_PERIODS.map((period) => {
                const limit = key.limits[period]
                const spent = periods.data?.[period] ?? null
                const cap = limit === null ? null : usdcToNumber(limit)
                return (
                  <StatTile key={period} label={`${PERIOD_LABELS[period]} spend`} value={spent === null ? '…' : formatUsd(spent)}
                    sub={cap === null ? 'No limit' : `${formatUsd(Math.max(cap - (spent ?? 0), 0))} left of ${formatUsd(cap)}`}
                    meter={cap && spent !== null ? spent / cap : null} />
                )
              })}
            </div>
            <Panel title="Spend, last 30 days">
              <QueryView query={daily} rows={1}>{(report) => <BarChart format={formatUsd} label="Daily spend" points={dailySeries(report, from, now)} />}</QueryView>
            </Panel>
            <Panel title="Key details">
              <DetailList items={[
                ['Requests', formatNumber(key.usage.requests)],
                ['Spent in total', formatUsd(key.usage.spent)],
                ['Last used', formatRelative(key.lastUsedAt)],
                ['Expires', key.expiresAt ? formatDate(key.expiresAt) : 'Never'],
                ['Top-ups', key.topupEnabled ? 'Allowed' : 'Off'],
                ['Routing', describePolicy(key.routingPolicy)],
              ]} />
            </Panel>
            <Panel flush title="Requests"><RequestLog filter={{ key: key.id }} showKey={false} /></Panel>
          </div>
        )}
      </main>
    </div>
  )
}
