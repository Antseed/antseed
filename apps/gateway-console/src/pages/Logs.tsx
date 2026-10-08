import { useMemo, useState } from 'react'
import { Button, TextField } from '@antseed/ui'
import { api } from '../api'
import { useScopeFilter } from '../app/context'
import { Icon } from '../components/icons'
import { RequestLog, type RequestFilter } from '../components/RequestLog'
import { PageHeader, Panel, SelectField } from '../components/ui'
import { fromDateInput } from '../lib/dates'
import { useKeys } from '../lib/queries'
import { useDebounced } from '../lib/useDebounced'

export default function Logs() {
  const scope = useScopeFilter()
  const [keyId, setKeyId] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const keys = useKeys(scope)
  const debouncedModel = useDebounced(model.trim())
  const debouncedSearch = useDebounced(search.trim())
  const from = fromDateInput(fromDate, 'start')
  const to = fromDateInput(toDate, 'end')
  const rangeError = from !== undefined && to !== undefined && from > to

  const filter = useMemo<RequestFilter>(() => ({
    ...scope,
    key: keyId || undefined,
    model: debouncedModel || undefined,
    status: status || undefined,
    q: debouncedSearch || undefined,
    from,
    to,
  }), [scope.workspace, scope.member, keyId, debouncedModel, status, debouncedSearch, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Boolean(keyId || model || status || search || fromDate || toDate)

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
        <SelectField size="sm" aria-label="Filter by status" value={status} onChange={setStatus}
          options={[{ value: '', label: 'Any status' }, { value: 'success', label: 'Succeeded' }, { value: 'error', label: 'Failed' }]} />
        <TextField size="sm" type="date" aria-label="From date (UTC)" title="From (UTC)" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
        <TextField size="sm" type="date" aria-label="To date (UTC)" title="To (UTC)" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)}
          error={rangeError ? 'Ends before it starts' : undefined} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => { setKeyId(''); setModel(''); setStatus(''); setSearch(''); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
      </div>
      <Panel flush>
        <RequestLog filter={filter} />
      </Panel>
    </div>
  )
}
