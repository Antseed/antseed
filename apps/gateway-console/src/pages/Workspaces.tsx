import { useState } from 'react'
import { Button, DataTable, Modal, TextField } from '@antseed/ui'
import { api } from '../api'
import type { Workspace } from '../api/types'
import { useConsole } from '../app/context'
import { usePolicySaveGuard } from '../components/PolicySaveGuard'
import { Icon } from '../components/icons'
import { LimitsEditor } from '../components/LimitsEditor'
import { PolicyFieldset, usePolicyDraft } from '../components/PolicyField'
import { Badge, ConfirmDialog, ErrorAlert, Mono, PageHeader, Panel, QueryView } from '../components/ui'
import { describeLimits, shortId } from '../lib/format'
import { draftToLimits, limitsToDraft } from '../lib/limits'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin } from '../lib/nav'
import { describePolicy } from '../lib/policy'
import { lacksOperator, useWorkspaceOperators } from '../lib/operator'
import { qk, useWorkspaces } from '../lib/queries'
import { navigate } from '../lib/router'

function WorkspaceForm({ initial, onDone }: { initial: Workspace | null; onDone: () => void }) {
  const { viewer } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  const [name, setName] = useState(initial?.name ?? '')
  const [limits, setLimits] = useState(limitsToDraft(initial?.limits))
  const [identity, setIdentity] = useState('')
  const policy = usePolicyDraft(initial?.routingPolicy)
  const guard = usePolicySaveGuard()
  const save = useConsoleMutation({
    mutationFn: () => {
      const input = { name: name.trim(), limits: draftToLimits(limits), routingPolicy: policy.build() }
      return guard.save([input.routingPolicy], (options) => {
        if (initial) {
          // Budgets are set by organization admins; workspace admins only rename and route.
          const { limits: budget, ...rest } = input
          return api.workspaces.update(initial.id, orgAdmin ? { ...rest, limits: budget } : rest, options)
        }
        return api.workspaces.create(identity.trim() ? { ...input, buyerIdentity: identity.trim() } : input, options)
      })
    },
    onSuccess: onDone,
    invalidate: [qk.group('workspaces'), qk.me],
    toast: initial ? 'Workspace saved' : 'Workspace created',
  })
  const submitLabel = initial ? 'Save' : 'Create workspace'
  return (
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <TextField label="Name" required value={name} onChange={(event) => setName(event.target.value)} />
      {!initial && (
        <TextField label="Buyer identity (optional)" value={identity} onChange={(event) => setIdentity(event.target.value)}
          hint="Leave blank to create a new wallet for this workspace. Enter an existing identity name to reuse its wallet." />
      )}
      {orgAdmin ? (
        <div>
          <div className="as-field__label gc-label-row">Workspace budgets (USD)</div>
          <LimitsEditor idPrefix="ws-limit" value={limits} onChange={setLimits} />
        </div>
      ) : (
        <p className="gc-muted">Budgets: {describeLimits(initial?.limits)}. Organization admins set them.</p>
      )}
      <PolicyFieldset draft={policy.draft} setDraft={policy.setDraft} />
      {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
      <div className="gc-actions">
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? 'Saving…' : submitLabel}</Button>
      </div>
      {guard.dialog}
    </form>
  )
}

export default function Workspaces() {
  const { viewer, setWorkspaceId, workspace: current, me } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  // PATCH /workspaces/:id needs admin in that workspace, not just in the one open.
  const canEdit = (ws: Workspace) => orgAdmin || me.workspaces.some((entry) => entry.workspace.id === ws.id && entry.role === 'admin')
  const workspaces = useWorkspaces()
  const operators = useWorkspaceOperators()
  const operatorOf = (ws: Workspace) => operators.data?.find((row) => row.workspaceId === ws.id)
  const [editing, setEditing] = useState<Workspace | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const remove = useConsoleMutation({
    mutationFn: (workspace: Workspace) => api.workspaces.remove(workspace.id),
    onSuccess: () => setDeleting(null),
    invalidate: [qk.group('workspaces'), qk.me],
  })

  return (
    <div className="gc-page">
      <PageHeader title="Workspaces" description="Each workspace has its own wallet, budgets, routing policy, members and keys."
        actions={orgAdmin && <Button leadingIcon={<Icon.plus size={14} />} onClick={() => setEditing('new')}>New workspace</Button>} />
      <Panel flush>
        <QueryView query={workspaces}>
          {(rows) => (
            <DataTable<Workspace> label="Workspaces" rows={rows} rowKey={(ws) => ws.id} rowLabel={(ws) => ws.name}
              onRowClick={(ws) => canEdit(ws) && setEditing(ws)}
              actions={(ws) => [
                ws.id !== current.id && { label: 'Open', onSelect: () => setWorkspaceId(ws.id) },
                { label: 'Members', onSelect: () => { setWorkspaceId(ws.id); navigate('members') } },
                canEdit(ws) && { label: 'Edit', onSelect: () => setEditing(ws) },
                orgAdmin && !ws.isDefault && { label: 'Delete', tone: 'danger' as const, onSelect: () => setDeleting(ws) },
              ]}
              columns={[
                { key: 'name', header: 'Name', sortValue: (ws) => ws.name, render: (ws) => (
                  <span className="gc-strong">{ws.name} {ws.isDefault && <Badge>Default</Badge>} {ws.id === current.id && <Badge tone="info">Open</Badge>}</span>
                ) },
                { key: 'wallet', header: 'Wallet', secondary: true, render: (ws) => ws.walletAddress ? <Mono title={ws.walletAddress}>{shortId(ws.walletAddress)}</Mono> : <span className="gc-muted">{ws.buyerIdentity}</span> },
                { key: 'operator', header: 'Authorized wallet', secondary: true, render: (ws) => {
                  const summary = operatorOf(ws)
                  if (!summary) return <span className="gc-muted">{operators.isLoading ? '…' : '—'}</span>
                  if (summary.relation === null) return <span className="gc-muted" title="The wallet or the chain could not be read">unknown</span>
                  if (lacksOperator(summary)) {
                    return (
                      <span className="gc-inline">
                        <Badge tone="warning">Not set</Badge>
                        {summary.canAuthorize && <Button variant="link" size="sm" onClick={(event) => { event.stopPropagation(); setWorkspaceId(ws.id); navigate('wallet') }}>Authorize</Button>}
                      </span>
                    )
                  }
                  return summary.relation === 'self' ? <span className="gc-muted">Workspace wallet</span> : <Mono title={summary.operator ?? undefined}>{shortId(summary.operator)}</Mono>
                } },
                { key: 'members', header: 'Members', align: 'right', secondary: true, sortValue: (ws) => ws.memberCount, render: (ws) => ws.memberCount },
                { key: 'keys', header: 'Keys', align: 'right', sortValue: (ws) => ws.keyCount, render: (ws) => ws.keyCount },
                { key: 'limits', header: 'Budgets', secondary: true, optional: true, render: (ws) => <span className="gc-muted">{describeLimits(ws.limits)}</span> },
                { key: 'policy', header: 'Routing', secondary: true, optional: true, render: (ws) => <span className="gc-muted">{describePolicy(ws.routingPolicy)}</span> },
              ]} />
          )}
        </QueryView>
      </Panel>
      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'New workspace' : 'Edit workspace'}>
        {editing !== null && <WorkspaceForm initial={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog isOpen={deleting !== null} busy={remove.isPending} error={remove.error}
        onClose={() => { setDeleting(null); remove.reset() }} onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete this workspace?" confirmLabel="Delete workspace"
        body={<>Deleting <strong>{deleting?.name}</strong> is only possible once it has no active keys and no balance. Withdraw funds and revoke keys first.</>} />
    </div>
  )
}
