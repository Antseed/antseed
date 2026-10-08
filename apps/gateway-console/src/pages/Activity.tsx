import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, DataTable } from '@antseed/ui'
import { api } from '../api'
import type { UsageGroupBy, UsageReport } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { Icon } from '../components/icons'
import { chartDescription, METRICS, UsageByModel } from '../components/UsageByModel'
import { EmptyState, PageHeader, Panel, QueryView, Segmented, SelectField, StatTile } from '../components/ui'
import { formatNumber, formatTokens, formatUsd, usdcToNumber } from '../lib/format'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { qk, useKeys, useWorkspaceMembers } from '../lib/queries'
import { rangeFrom, RANGES, type RangeId, type SeriesMetric } from '../lib/usage'

const GROUPS: Array<{ value: UsageGroupBy; label: string; admin?: boolean; org?: boolean }> = [
  { value: 'model', label: 'Model' },
  { value: 'key', label: 'Key' },
  { value: 'peer', label: 'Seller' },
  { value: 'user', label: 'End user' },
  { value: 'member', label: 'Member', admin: true },
  { value: 'workspace', label: 'Workspace', org: true },
  { value: 'day', label: 'Day' },
]

type Row = UsageReport['groups'][number]

export default function Activity() {
  const { viewer, workspace } = useConsole()
  const scope = useScopeFilter()
  const [range, setRange] = useState<RangeId>('30d')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('model')
  const [metric, setMetric] = useState<SeriesMetric>('spend')
  const [keyId, setKeyId] = useState('')
  const [memberId, setMemberId] = useState('')
  const admin = isWorkspaceAdmin(viewer)
  const now = useMemo(() => Date.now(), [range])
  const from = rangeFrom(range, now)
  const filter = { ...scope, key: keyId || undefined, member: memberId || scope.member, from, to: now }
  const keys = useKeys({ workspace: workspace.id, member: scope.member })
  const members = useWorkspaceMembers(workspace.id, admin)
  const daily = useQuery({ queryKey: qk.usage({ ...filter, groupBy: 'day' }), queryFn: () => api.usage.report({ ...filter, groupBy: 'day' }) })
  const grouped = useQuery({ queryKey: qk.usage({ ...filter, groupBy }), queryFn: () => api.usage.report({ ...filter, groupBy }) })
  const totals = daily.data?.totals

  return (
    <div className="gc-page">
      <PageHeader title="Activity" description="Spend and token usage over time."
        actions={<Button variant="outline" size="sm" href={api.usage.exportUrl({ ...filter, groupBy })} download leadingIcon={<Icon.download size={14} />}>Export CSV</Button>} />

      <div className="gc-toolbar">
        <Segmented label="Time range" value={range} onChange={setRange} options={RANGES.map((entry) => ({ value: entry.id, label: entry.label }))} />
        <SelectField size="sm" aria-label="Filter by key" value={keyId} onChange={setKeyId}
          options={[{ value: '', label: 'All keys' }, ...(keys.data ?? []).map((key) => ({ value: key.id, label: key.label }))]} />
        {admin && (
          <SelectField size="sm" aria-label="Filter by member" value={memberId} onChange={setMemberId}
            options={[{ value: '', label: 'All members' }, ...(members.data ?? []).map(({ member }) => ({ value: member.id, label: member.label }))]} />
        )}
        {(keyId || memberId) && <Button variant="ghost" size="sm" onClick={() => { setKeyId(''); setMemberId('') }}>Clear filters</Button>}
      </div>

      <div className="gc-grid gc-grid--4">
        <StatTile label="Spend" value={totals ? formatUsd(totals.spent) : '…'} />
        <StatTile label="Requests" value={totals ? formatNumber(totals.requests) : '…'} sub={totals ? `${formatNumber(totals.failedRequests)} failed` : undefined} />
        <StatTile label="Input tokens" value={totals ? formatTokens(totals.inputTokens) : '…'} sub={totals ? `${formatTokens(totals.cachedInputTokens)} cached` : undefined} />
        <StatTile label="Output tokens" value={totals ? formatTokens(totals.outputTokens) : '…'} />
      </div>

      <Panel title={metric === 'tokens' ? 'Tokens by type' : 'Usage by model'} description={chartDescription(metric, range)}
        actions={<Segmented label="Chart metric" value={metric} onChange={setMetric} options={METRICS} />}>
        <UsageByModel filter={{ ...scope, key: keyId || undefined, member: memberId || scope.member }} range={range} now={now} metric={metric} />
      </Panel>

      <Panel title="Breakdown" flush actions={
        <SelectField size="sm" aria-label="Group by" value={groupBy} onChange={(value) => setGroupBy(value as UsageGroupBy)}
          options={GROUPS.filter((group) => (!group.admin || admin) && (!group.org || isOrgAdmin(viewer))).map((group) => ({ value: group.value, label: `By ${group.label.toLowerCase()}` }))} />
      }>
        <QueryView query={grouped}>
          {(report) => (
            <DataTable<Row> label="Usage breakdown" rows={report.groups} rowKey={(row) => row.group}
              initialSort={{ key: 'spent', direction: 'desc' }}
              empty={<EmptyState icon={<Icon.activity size={18} />} title="No usage in this range" body="Requests made with this workspace's keys show up here." />}
              columns={[
                { key: 'label', header: GROUPS.find((group) => group.value === groupBy)?.label ?? 'Group', render: (row) => <span className="gc-ellipsis" title={row.group}>{row.label || row.group}</span>, sortValue: (row) => row.label || row.group },
                { key: 'requests', header: 'Requests', align: 'right', render: (row) => formatNumber(row.requests), sortValue: (row) => row.requests },
                { key: 'failed', header: 'Failed', align: 'right', secondary: true, render: (row) => formatNumber(row.failedRequests), sortValue: (row) => row.failedRequests },
                { key: 'input', header: 'Input', align: 'right', secondary: true, render: (row) => formatTokens(row.inputTokens), sortValue: (row) => row.inputTokens },
                { key: 'cached', header: 'Cached', align: 'right', secondary: true, render: (row) => formatTokens(row.cachedInputTokens), sortValue: (row) => row.cachedInputTokens },
                { key: 'output', header: 'Output', align: 'right', secondary: true, render: (row) => formatTokens(row.outputTokens), sortValue: (row) => row.outputTokens },
                { key: 'spent', header: 'Spend', align: 'right', render: (row) => formatUsd(row.spent), sortValue: (row) => usdcToNumber(row.spent) },
              ]} />
          )}
        </QueryView>
      </Panel>
    </div>
  )
}
