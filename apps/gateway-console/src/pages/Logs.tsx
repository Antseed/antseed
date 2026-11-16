import { useMemo, useState } from 'react'
import { Button, TextField } from '@antseed/ui'
import { api } from '../api'
import { useScopeFilter } from '../app/context'
import { Icon } from '../components/icons'
import { RequestLog, type RequestFilter } from '../components/RequestLog'
import { PageHeader, Panel, SelectField } from '../components/ui'
import { fromDateInput } from '../lib/dates'
import { peerName } from '../components/PeerPicker'
import { useKeys, usePeers, useUsedRouters } from '../lib/queries'
import { useDebounced } from '../lib/useDebounced'

export default function Logs() {
  const scope = useScopeFilter()
  const [keyId, setKeyId] = useState('')
  const [model, setModel] = useState('')
  const [router, setRouter] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const keys = useKeys(scope)
  const routers = useUsedRouters(scope)
  const peers = usePeers()
  const debouncedModel = useDebounced(model.trim())
  const debouncedSearch = useDebounced(search.trim())
  const from = fromDateInput(fromDate, 'start')
  const to = fromDateInput(toDate, 'end')
  const rangeError = from !== undefined && to !== undefined && from > to

  const filter = useMemo<RequestFilter>(() => ({
    ...scope,
    key: keyId || undefined,
    model: debouncedModel || undefined,
    router: router || undefined,
    status: status || undefined,
    q: debouncedSearch || undefined,
    from,
    to,
  }), [scope.workspace, scope.member, keyId, debouncedModel, router, status, debouncedSearch, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Boolean(keyId || model || router || status || search || fromDate || toDate)
  // Only offered once a routing service has ranked requests here (or a filter on one is set).
  const routerOptions = routers.data ?? []

  return (
    <div className="gc-page">
      <PageHeader title="Logs" description="Every request through this workspace's keys."
        actions={<Button variant="outline" size="sm" href={api.usage.exportUrl(filter)} download leadingIcon={<Icon.download size={14} />}>Export CSV</Button>} />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search requests" placeholder="Search model, key, end user or error" value={search}
          onChange={(event) => setSearch(event.target.value)} className="gc-toolbar__grow" />
        <SelectField size="sm" aria-label="Filter by key" value={keyId} onChange={setKeyId}
          options={[{ value: '', label: 'All keys' }, ...(keys.data ?? []).map((key) => ({ value: key.id, label: key.label }))]} />
        <TextField size="sm" aria-label="Filter by model" placeholder="Model" value={model} onChange={(event) => setModel(event.target.value)} />
        {(routerOptions.length > 0 || router) && (
          <SelectField size="sm" aria-label="Filter by router" value={router} onChange={setRouter}
            options={[{ value: '', label: 'Any router' }, ...routerOptions.map((peerId) => ({ value: peerId, label: peerName(peers.data, peerId) }))]} />
        )}
        <SelectField size="sm" aria-label="Filter by status" value={status} onChange={setStatus}
          options={[{ value: '', label: 'Any status' }, { value: 'success', label: 'Succeeded' }, { value: 'error', label: 'Failed' }]} />
        <TextField size="sm" type="date" aria-label="From date (UTC)" title="From (UTC)" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
        <TextField size="sm" type="date" aria-label="To date (UTC)" title="To (UTC)" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)}
          error={rangeError ? 'Ends before it starts' : undefined} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => { setKeyId(''); setModel(''); setRouter(''); setStatus(''); setSearch(''); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
      </div>
      <Panel flush>
        <RequestLog filter={filter} />
      </Panel>
    </div>
  )
}
