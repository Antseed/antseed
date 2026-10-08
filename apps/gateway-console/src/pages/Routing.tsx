import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Modal, useToast } from '@antseed/ui'
import { api, type SaveOptions } from '../api'
import type { RoutingPolicy } from '../api/types'
import { useConsole } from '../app/context'
import { CANCELLED, usePolicySaveGuard } from '../components/PolicySaveGuard'
import { PolicyEditor } from '../components/PolicyEditor'
import { draftStatus } from '../components/PolicyField'
import { PolicyChips } from '../components/PolicySummary'
import { PolicySource, RoutePreviewPanel } from '../components/RoutePreview'
import { Badge, ErrorAlert, LoadingRows, PageHeader, Panel, TabPanel, Tabs } from '../components/ui'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { describePolicy, draftToPolicy, policyOrNull, policyToDraft, type PolicyDraft } from '../lib/policy'
import { combinePolicies, expandLists } from '../lib/policy-match'
import { qk, useGatewayPolicy, useWorkspace, usePeerLists, usePeers } from '../lib/queries'

type Level = 'gateway' | 'workspace'
type Layer = 'gateway' | 'org' | 'workspace'

const LAYER_COPY: Record<Layer, { title: string; description: (workspace: string) => string }> = {
  gateway: { title: 'Gateway default', description: () => 'Applies to every request through this gateway. Workspaces, members, keys and presets can only narrow it.' },
  org: { title: 'Organization policy', description: (ws) => `Set by organization admins for ${ws}. Workspace admins can only narrow it.` },
  workspace: { title: 'Workspace policy', description: (ws) => `Set by ${ws}'s admins, on top of the gateway default and the organization policy.` },
}

const sameDraft = (a: PolicyDraft, b: PolicyDraft) => JSON.stringify(a) === JSON.stringify(b)

function layerBadge(canEdit: boolean, dirty: boolean) {
  if (!canEdit) return <Badge>Read only</Badge>
  if (dirty) return <Badge tone="warning">Unsaved changes</Badge>
  return undefined
}

/**
 * One editable policy level. `source` is the saved policy; `parent` combines
 * the levels above it. Local edits survive refetches: when the saved policy
 * changes while the draft has unsaved edits, the editor says so and lets the
 * user reload it or keep editing instead of silently replacing their work.
 */
function LayerEditor({ layer, source, parent, canEdit, onSave }: {
  layer: Layer; source: RoutingPolicy | null; parent: RoutingPolicy | null; canEdit: boolean
  onSave: (policy: RoutingPolicy, options: SaveOptions) => Promise<unknown>
}) {
  const { workspace } = useConsole()
  const toast = useToast()
  const peers = usePeers()
  const lists = usePeerLists()
  const guard = usePolicySaveGuard()
  const [draft, setDraft] = useState<PolicyDraft>(() => policyToDraft(source))
  // The saved policy the draft started from; a newer one arriving while dirty is a conflict.
  const [base, setBase] = useState<PolicyDraft>(() => policyToDraft(source))
  const [conflict, setConflict] = useState<PolicyDraft | null>(null)
  const [editing, setEditing] = useState(false)
  const incoming = useMemo(() => policyToDraft(source), [source])
  const dirty = !sameDraft(draft, base)
  useEffect(() => {
    if (sameDraft(incoming, base)) return
    if (!dirty || sameDraft(incoming, draft)) {
      setDraft(incoming)
      setBase(incoming)
      setConflict(null)
    } else {
      setConflict(incoming)
    }
    // Only a change of the saved policy should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming])
  const save = useMutation({
    mutationFn: async () => {
      const policy = draftToPolicy(draft, lists.data ?? null)
      const result = await guard.save([policy], (options) => onSave(policy, options))
      return result === CANCELLED ? null : policy
    },
    onSuccess: (policy) => {
      if (!policy) return
      const saved = policyToDraft(policy)
      setDraft(saved)
      setBase(saved)
      setConflict(null)
      setEditing(false)
      toast(`${LAYER_COPY[layer].title} saved`)
    },
  })
  const status = draftStatus(draft, lists.data ?? null)
  return (
    <Panel title={LAYER_COPY[layer].title} description={LAYER_COPY[layer].description(workspace.name)}
      actions={layerBadge(canEdit, dirty)}>
      <div className="gc-policy-row">
        <div className="gc-policy-row__text">
          <PolicyChips policy={dirty ? status.policy : source} invalid={dirty && status.error !== null} />
          {dirty && <span className="gc-fineprint">Showing your unsaved edits.</span>}
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{canEdit ? 'Edit' : 'View'}</Button>
      </div>
      {conflict && canEdit && !editing && (
        <Alert tone="warning" title="Changed elsewhere">Someone saved this policy while you were editing it. Open it to reload theirs or keep yours.</Alert>
      )}
      <Modal isOpen={editing} onClose={() => setEditing(false)} size="xl" title={LAYER_COPY[layer].title} subtitle={LAYER_COPY[layer].description(workspace.name)}
        footer={canEdit ? <>
          {status.error && <span className="gc-warn gc-footer-note">{status.error}</span>}
          <Button variant="ghost" disabled={!dirty} onClick={() => { setDraft(base); setConflict(null) }}>Discard changes</Button>
          <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save policy'}</Button>
        </> : <Button variant="outline" onClick={() => setEditing(false)}>Close</Button>}>
        <div className="gc-stack">
          {conflict && canEdit && (
            <Alert tone="warning" title="Changed elsewhere"
              action={<div className="gc-inline gc-inline--wrap">
                <Button size="sm" variant="outline" onClick={() => { setDraft(conflict); setBase(conflict); setConflict(null) }}>Reload</Button>
                <Button size="sm" variant="ghost" onClick={() => { setBase(conflict); setConflict(null) }}>Keep editing</Button>
              </div>}>
              Someone saved this policy while you were editing it. Reload to see their version (your edits are dropped), or keep editing and save to replace it.
            </Alert>
          )}
          {save.error ? <ErrorAlert error={save.error} title="Could not save" /> : null}
          <PolicyEditor value={draft} onChange={setDraft} peers={peers.data} lists={lists.data ?? []} parent={parent} disabled={!canEdit} />
        </div>
      </Modal>
      {guard.dialog}
    </Panel>
  )
}

function GatewayLevel() {
  const queryClient = useQueryClient()
  const gateway = useGatewayPolicy()
  if (gateway.isLoading) return <LoadingRows rows={6} />
  if (gateway.error) return <ErrorAlert error={gateway.error} onRetry={() => void gateway.refetch()} />
  return (
    <LayerEditor layer="gateway" source={gateway.data ?? null} parent={null} canEdit
      onSave={async (policy, options) => {
        await api.network.setGatewayPolicy(policy, options)
        await queryClient.invalidateQueries({ queryKey: qk.group('routing') })
      }} />
  )
}

function WorkspaceLevel() {
  const { workspace, viewer } = useConsole()
  const queryClient = useQueryClient()
  const lists = usePeerLists()
  const detail = useWorkspace(workspace.id)
  const gateway = useGatewayPolicy()
  const listData = lists.data ?? []
  const gatewayPolicy = gateway.data ? expandLists(gateway.data, listData) : null
  const orgPolicy = detail.data?.orgRoutingPolicy ?? null
  const wsPolicy = detail.data?.routingPolicy ?? null
  const effective = useMemo(
    () => combinePolicies(gatewayPolicy, orgPolicy && expandLists(orgPolicy, listData), wsPolicy && expandLists(wsPolicy, listData)),
    [gatewayPolicy, orgPolicy, wsPolicy, listData],
  )
  if (detail.isLoading) return <LoadingRows rows={6} />
  if (detail.error) return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.group('workspaces') })
    await queryClient.invalidateQueries({ queryKey: qk.group('routing') })
  }
  return (
    <div className="gc-stack">
      <Panel title="Effective for this workspace" description="What keys in this workspace get before member, key and preset policies narrow it further.">
        <div className="gc-sources">
          <PolicySource level="Gateway default">{describePolicy(gateway.data)}</PolicySource>
          <PolicySource level="Organization">{describePolicy(orgPolicy)}</PolicySource>
          <PolicySource level="Workspace">{describePolicy(wsPolicy)}</PolicySource>
          <PolicySource level="Effective" result><PolicyChips policy={effective} /></PolicySource>
        </div>
      </Panel>
      <LayerEditor layer="org" source={orgPolicy} parent={gatewayPolicy} canEdit={isOrgAdmin(viewer)}
        onSave={async (policy, options) => { await api.workspaces.update(workspace.id, { orgRoutingPolicy: policyOrNull(policy) }, options); await refresh() }} />
      <LayerEditor layer="workspace" source={wsPolicy} parent={combinePolicies(gatewayPolicy, orgPolicy && expandLists(orgPolicy, listData))}
        canEdit={isWorkspaceAdmin(viewer)}
        onSave={async (policy, options) => { await api.workspaces.update(workspace.id, { routingPolicy: policyOrNull(policy) }, options); await refresh() }} />
    </div>
  )
}

/** Org admins switch between the gateway default and this workspace; everyone else sees the workspace. */
function PolicyLevels() {
  const { viewer } = useConsole()
  const orgAdmin = isOrgAdmin(viewer)
  const [level, setLevel] = useState<Level>(orgAdmin ? 'gateway' : 'workspace')
  if (!orgAdmin) return <WorkspaceLevel />
  return (
    <>
      <Tabs id="gc-routing-level" label="Policy level" value={level} onChange={setLevel}
        tabs={[{ id: 'gateway', label: 'Gateway default' }, { id: 'workspace', label: 'This workspace' }]} />
      <TabPanel tabsId="gc-routing-level" tab={level}>{level === 'gateway' ? <GatewayLevel /> : <WorkspaceLevel />}</TabPanel>
    </>
  )
}

export default function Routing() {
  return (
    <div className="gc-page">
      <PageHeader title="Routing" description="Which sellers serve your requests and how they are ranked. Each level can only narrow the one above." />
      <PolicyLevels />
      <RoutePreviewPanel />
    </div>
  )
}
