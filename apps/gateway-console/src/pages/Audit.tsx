import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, DataTable, Drawer } from '@antseed/ui'
import { api, isApiError } from '../api'
import type { AuditEntry } from '../api/types'
import { Badge, CodeBlock, DetailList, EmptyState, ErrorAlert, LoadingRows, Mono, PageHeader, Panel, SelectField } from '../components/ui'
import { formatDateTime } from '../lib/format'
import { qk, useAdminTokens, useMembers } from '../lib/queries'
import { Icon } from '../components/icons'

const PAGE_SIZE = 50

/** Action families; the API matches a verb and everything under it ("key" → key.create, key.revoke, …). */
const ACTION_FILTERS = [
  { value: '', label: 'All actions' },
  { value: 'auth', label: 'Sign-ins' },
  { value: 'key', label: 'API keys' },
  { value: 'member', label: 'Members' },
  { value: 'invite', label: 'Invites' },
  { value: 'workspace', label: 'Workspaces' },
  { value: 'routing', label: 'Gateway routing' },
  { value: 'peer_list', label: 'Peer lists' },
  { value: 'preset', label: 'Presets' },
  { value: 'wallet', label: 'Wallets' },
  { value: 'channel', label: 'Channels' },
  { value: 'settings', label: 'Settings' },
  { value: 'token', label: 'Management tokens' },
]

const ACTOR_LABELS: Record<AuditEntry['actor']['kind'], string> = { member: 'Member', token: 'Token', key: 'API key', system: 'System', cli: 'CLI' }

function actorText(entry: AuditEntry): string {
  return entry.actor.label ?? entry.actor.id ?? ACTOR_LABELS[entry.actor.kind]
}

function useAuditLog(filter: { actor?: string; action?: string }) {
  return useInfiniteQuery({
    queryKey: qk.audit(filter),
    queryFn: ({ pageParam }) => api.audit.list({ ...filter, before: pageParam ?? undefined, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  })
}

function AuditEntries({ query, filtered, onSelect }: { query: ReturnType<typeof useAuditLog>; filtered: boolean; onSelect: (entry: AuditEntry) => void }) {
  if (query.isLoading) return <LoadingRows rows={8} />
  if (isApiError(query.error) && query.error.status === 404) {
    return <EmptyState icon={<Icon.audit size={18} />} title="Audit log not available" body="This gateway version does not record an audit log yet." />
  }
  if (query.error) return <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />
  const rows = query.data?.pages.flatMap((page) => page.entries) ?? []
  return (
    <>
      <DataTable<AuditEntry> label="Audit log" rows={rows} rowKey={(entry) => entry.id} onRowClick={onSelect}
        rowLabel={(entry) => `${entry.action} by ${actorText(entry)}`}
        empty={<EmptyState icon={<Icon.audit size={18} />} title={filtered ? 'No entries match' : 'Nothing recorded yet'} />}
        columns={[
          { key: 'at', header: 'When', render: (entry) => <span className="gc-nowrap">{formatDateTime(entry.at)}</span> },
          { key: 'actor', header: 'Who', secondary: true, render: (entry) => <span>{actorText(entry)} <Badge>{ACTOR_LABELS[entry.actor.kind]}</Badge></span> },
          { key: 'action', header: 'Action', render: (entry) => <><Mono>{entry.action}</Mono><div className="gc-narrow-only gc-muted">{actorText(entry)}</div></> },
          { key: 'target', header: 'Target', secondary: true, render: (entry) => entry.target ? (entry.target.label ?? entry.target.id ?? entry.target.kind) : '—' },
          { key: 'ip', header: 'IP', secondary: true, optional: true, render: (entry) => entry.ip ? <Mono>{entry.ip}</Mono> : '—' },
        ]} />
      {query.hasNextPage && (
        <div className="gc-load-more">
          <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
          </Button>
        </div>
      )}
    </>
  )
}

export default function Audit() {
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [selected, setSelected] = useState<AuditEntry | null>(null)
  const members = useMembers()
  const tokens = useAdminTokens()
  const actors = [
    { value: '', label: 'Anyone' },
    ...(members.data ?? []).map((member) => ({ value: member.id, label: member.label })),
    ...(tokens.data ?? []).map((token) => ({ value: token.id, label: `Token: ${token.label}` })),
  ]
  const filter = useMemo(() => ({ actor: actor || undefined, action: action || undefined }), [actor, action])
  const query = useAuditLog(filter)

  return (
    <div className="gc-page">
      <PageHeader title="Audit log" description="Who changed what in this organization: keys, members, workspaces, routing, wallets and settings." />
      <div className="gc-toolbar">
        <SelectField size="sm" aria-label="Filter by who" value={actor} onChange={setActor} options={actors} />
        <SelectField size="sm" aria-label="Filter by action" value={action} onChange={setAction} options={ACTION_FILTERS} />
        {(actor || action) && <Button variant="ghost" size="sm" onClick={() => { setActor(''); setAction('') }}>Clear filters</Button>}
      </div>
      <Panel flush>
        <AuditEntries query={query} filtered={Boolean(actor || action)} onSelect={setSelected} />
      </Panel>
      <Drawer isOpen={selected !== null} onClose={() => setSelected(null)} eyebrow="Audit entry" title={selected?.action ?? ''}
        subtitle={selected ? formatDateTime(selected.at) : undefined}>
        {selected && (
          <>
            <DetailList items={[
              ['Who', `${actorText(selected)} (${ACTOR_LABELS[selected.actor.kind]})`],
              ['Actor id', selected.actor.id ? <Mono key="a">{selected.actor.id}</Mono> : '—'],
              ['Target', selected.target ? `${selected.target.kind}: ${selected.target.label ?? selected.target.id ?? '—'}` : '—'],
              ['IP address', selected.ip ?? '—'],
              ['Entry id', <Mono key="i">{selected.id}</Mono>],
            ]} />
            {Object.keys(selected.details).length > 0 && (
              <div className="gc-stack gc-stack--tight">
                <div className="as-field__label">Details</div>
                <CodeBlock code={JSON.stringify(selected.details, null, 2)} />
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
