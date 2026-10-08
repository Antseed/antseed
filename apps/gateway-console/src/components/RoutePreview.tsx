import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, DataTable, TextField } from '@antseed/ui'
import { api } from '../api'
import type { ApiKey, Member, Preset, RoutePreview } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { formatPricePerMillion } from '../lib/format'
import { isOrgAdmin } from '../lib/nav'
import { describePolicy } from '../lib/policy'
import { modelsFromPeers, qk, useKeys, usePeers, usePresets, useWorkspaceMembers } from '../lib/queries'
import { copyModelIdItem, useCopy } from './copy-actions'
import { peerName } from './PeerPicker'
import { Badge, EmptyState, ErrorAlert, LoadingRows, Panel, SelectField } from './ui'

/** One level's policy in a row of levels; `result` marks the combined one. */
export function PolicySource({ level, children, result }: { level: ReactNode; children: ReactNode; result?: boolean }) {
  return (
    <div className={result ? 'gc-source gc-source--result' : 'gc-source'}>
      <div className="gc-source__level">{level}</div>
      <div className="gc-source__policy">{children}</div>
    </div>
  )
}

type Target = 'workspace' | 'key' | 'member' | 'preset'
type Option = { value: string; label: string }

function targetOptions(target: Target, keys: ApiKey[] | undefined, members: Array<{ member: Member }> | undefined, presets: Preset[] | undefined): Option[] {
  if (target === 'key') return (keys ?? []).filter((key) => key.status === 'active').map((key) => ({ value: key.id, label: key.label }))
  if (target === 'member') return (members ?? []).map(({ member }) => ({ value: member.id, label: member.label }))
  if (target === 'preset') return (presets ?? []).map((preset) => ({ value: preset.slug, label: preset.name }))
  return []
}

export function RoutePreviewPanel() {
  const { workspace, viewer } = useConsole()
  const scope = useScopeFilter()
  const peers = usePeers()
  const models = modelsFromPeers(peers.data)
  const orgAdmin = isOrgAdmin(viewer)
  const [target, setTarget] = useState<Target>('workspace')
  const [targetId, setTargetId] = useState('')
  const [model, setModel] = useState('')
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(null)
  const keys = useKeys(scope, target === 'key')
  const members = useWorkspaceMembers(workspace.id, target === 'member')
  const presets = usePresets(workspace.id, target === 'preset')
  const preview = useQuery({
    queryKey: qk.routePreview(submitted ?? {}),
    queryFn: () => api.network.routePreview(submitted as { model: string }),
    enabled: submitted !== null,
  })
  const options = targetOptions(target, keys.data, members.data, presets.data)

  function run() {
    const query: Record<string, string> = { model: model.trim(), workspace: workspace.id }
    if (target !== 'workspace' && targetId) query[target] = targetId
    setSubmitted(query)
  }

  return (
    <Panel title="Route preview" description="See which sellers a request would go to, and why.">
      <form className="gc-toolbar" onSubmit={(event) => { event.preventDefault(); run() }}>
        <SelectField size="sm" aria-label="Preview for" value={target} onChange={(value) => { setTarget(value as Target); setTargetId('') }}
          options={[
            { value: 'workspace', label: `Workspace: ${workspace.name}` },
            { value: 'key', label: 'A key' },
            ...(orgAdmin ? [{ value: 'member', label: 'A member' }] : []),
            { value: 'preset', label: 'A preset' },
          ]} />
        {target !== 'workspace' && (
          <SelectField size="sm" aria-label={`Choose a ${target}`} value={targetId} onChange={setTargetId}
            options={[{ value: '', label: `Choose a ${target}` }, ...options]} />
        )}
        <TextField size="sm" aria-label="Model" placeholder="Model id" list="gc-preview-models" value={model} onChange={(event) => setModel(event.target.value)} />
        <datalist id="gc-preview-models">{models.map((entry) => <option key={entry} value={entry} />)}</datalist>
        <Button type="submit" size="sm" disabled={!model.trim() || (target !== 'workspace' && !targetId)}>Preview</Button>
      </form>
      {preview.isFetching && <LoadingRows rows={4} />}
      {preview.error ? <ErrorAlert error={preview.error} /> : null}
      {preview.data && !preview.isFetching && <PreviewResult preview={preview.data} />}
    </Panel>
  )
}

type Source = RoutePreview['sources'][number]

const LEVEL_LABELS: Record<Source['level'], string> = {
  buyer: 'Buyer', gateway: 'Gateway', 'workspace-org': 'Workspace (org policy)', workspace: 'Workspace', member: 'Member', key: 'Key (admin)', 'key-owner': 'Key (owner)', preset: 'Preset',
}

function sourcePolicy(source: Source): ReactNode {
  if (source.policy !== null) return describePolicy(source.policy)
  return <span className="gc-muted">{source.level === 'buyer' ? 'Buyer config' : 'Inherits'}</span>
}

function PreviewResult({ preview }: { preview: RoutePreview }) {
  const { me } = useConsole()
  const peers = usePeers()
  const copy = useCopy()
  const eligible = preview.candidates.filter((candidate) => candidate.eligible).length
  const sourceName = (source: Source) => {
    if (!source.id) return null
    if (source.level === 'workspace' || source.level === 'workspace-org') return me.workspaces.find((entry) => entry.workspace.id === source.id)?.workspace.name ?? source.id
    return source.id
  }
  return (
    <div className="gc-stack">
      {!preview.modelAllowed && <Alert tone="danger" title="Model not allowed">The policy does not allow {preview.model}. Requests for it get a 403.</Alert>}
      <div className="gc-sources">
        {preview.sources.map((source, index) => (
          <PolicySource key={`${source.level}-${index}`}
            level={<>{LEVEL_LABELS[source.level]}{sourceName(source) ? <span className="gc-muted"> · {sourceName(source)}</span> : null}</>}>
            {sourcePolicy(source)}
          </PolicySource>
        ))}
        <PolicySource level="Effective" result>{describePolicy(preview.policy)}</PolicySource>
      </div>
      <p className="gc-muted">{eligible} of {preview.candidates.length} sellers eligible.</p>
      {eligible === 0 && preview.candidates.length > 0 && (
        <Alert tone="warning" title="No eligible seller">Requests for {preview.model} fail with this policy. The reasons below show what excludes each seller.</Alert>
      )}
      <DataTable label="Candidates" rows={[...preview.candidates].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))} rowKey={(row) => row.peerId}
        rowLabel={(row) => row.displayName ?? peerName(peers.data, row.peerId)}
        actions={(row) => [copyModelIdItem(copy, row.peerId, preview.model)]}
        empty={<EmptyState title="No seller offers this model" />}
        columns={[
          { key: 'rank', header: '#', render: (row) => row.rank ?? '—', width: '3rem' },
          { key: 'seller', header: 'Seller', render: (row) => row.displayName ?? peerName(peers.data, row.peerId) },
          { key: 'eligible', header: 'Eligible', render: (row) => row.eligible ? <Badge tone="success">Yes</Badge> : <Badge tone="neutral">No</Badge> },
          { key: 'reasons', header: 'Why', render: (row) => <span className="gc-muted">{row.reasons.join(' · ') || '—'}</span> },
          { key: 'input', header: 'Input $/M', align: 'right', secondary: true, render: (row) => formatPricePerMillion(row.inputUsdPerMillion) },
          { key: 'output', header: 'Output $/M', align: 'right', secondary: true, render: (row) => formatPricePerMillion(row.outputUsdPerMillion) },
          { key: 'trust', header: 'Trust', align: 'right', secondary: true, render: (row) => row.trustScore === null ? '—' : Math.round(row.trustScore) },
        ]} />
    </div>
  )
}
