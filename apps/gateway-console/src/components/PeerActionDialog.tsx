import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Modal, useToast } from '@antseed/ui'
import { api, errorMessage, isApiError, type SaveOptions } from '../api'
import type { Peer, RoutingPolicy } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { applyPeerActionToScope, describePeerOutcome, loadScopePolicy, previewQueryFor, type PeerOutcome, type PeerScope } from '../lib/peer-actions'
import { narrowedSummary } from '../lib/key-layers'
import { blockEmptiesAllowList, describePolicy, type PeerAction } from '../lib/policy'
import { POLICY_GROUPS, useKeys, useMembers } from '../lib/queries'
import { peerName } from './PeerPicker'
import { ErrorAlert, LoadingRows, SelectField } from './ui'

type ScopeKind = PeerScope['kind']
type Outcome = PeerOutcome & { canForce?: boolean }

/** The scope to patch; null until a member or key is chosen. Admins change a key's admin layer, a non-admin owner their own. */
function scopeFor(kind: ScopeKind, targetId: string, workspaceId: string, workspaceAdmin: boolean): PeerScope | null {
  if (kind === 'gateway') return { kind }
  if (kind === 'workspace' || kind === 'workspace-org') return { kind, workspaceId }
  if (!targetId) return null
  if (kind === 'member') return { kind, memberId: targetId }
  return { kind: 'key', keyId: targetId, workspaceId, layer: workspaceAdmin ? 'admin' : 'owner' }
}

function outcomeTitle(outcome: Outcome): string {
  if (outcome.canForce) return 'Not allowed above'
  if (outcome.tone === 'warning') return 'Check the result'
  return 'Done'
}

/** The scope's current policy line: loading, the load error, or a summary once ready. */
function CurrentPolicy({ fetching, error, ready, policy }: { fetching: boolean; error: unknown; ready: boolean; policy: RoutingPolicy | null }) {
  if (fetching) return <LoadingRows rows={1} />
  if (error) return <ErrorAlert error={error} title="Could not load this scope's policy" />
  if (!ready) return null
  return <p className="gc-muted">Current policy: {describePolicy(policy)}</p>
}

const ACTION_COPY: Record<Exclude<PeerAction, 'clear'>, { title: string; verb: string }> = {
  allow: { title: 'Allow seller', verb: 'Allow' },
  block: { title: 'Block seller', verb: 'Block' },
  prefer: { title: 'Prefer seller', verb: 'Prefer' },
}

/**
 * Applies Allow / Block / Prefer for one seller to a chosen scope. The
 * scope's current policy is loaded fresh from the API right before the
 * patch, so the write never drops settings it did not mean to change.
 */
export function PeerActionDialog({ peer, action, onClose, peers }: { peer: Peer | null; action: Exclude<PeerAction, 'clear'>; onClose: () => void; peers?: readonly Peer[] }) {
  const { viewer, workspace, me } = useConsole()
  const scopeFilter = useScopeFilter()
  const queryClient = useQueryClient()
  const toast = useToast()
  const orgAdmin = isOrgAdmin(viewer)
  const wsAdmin = isWorkspaceAdmin(viewer)
  const scopes: Array<{ value: ScopeKind; label: string }> = [
    ...(orgAdmin ? [{ value: 'gateway' as const, label: 'Gateway default (everyone)' }] : []),
    ...(orgAdmin ? [{ value: 'workspace-org' as const, label: `${workspace.name}: organization policy` }] : []),
    ...(wsAdmin ? [{ value: 'workspace' as const, label: `${workspace.name}: workspace policy` }] : []),
    ...(orgAdmin ? [{ value: 'member' as const, label: 'A member' }] : []),
    { value: 'key', label: 'An API key' },
  ]
  const [kind, setKind] = useState<ScopeKind>(scopes[0]!.value)
  const [targetId, setTargetId] = useState('')
  const [model, setModel] = useState('')
  const members = useMembers(kind === 'member')
  const keys = useKeys(scopeFilter, kind === 'key')

  useEffect(() => { setTargetId('') }, [kind])
  useEffect(() => { setModel(peer?.services[0]?.service ?? '') }, [peer])

  const keyOptions = (keys.data ?? []).filter((key) => key.status === 'active' && (wsAdmin || key.ownerMemberId === me.member.id))
  const scope = scopeFor(kind, targetId, workspace.id, wsAdmin)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  useEffect(() => { setOutcome(null) }, [kind, targetId, peer])
  const current = useQuery({
    queryKey: ['routing', 'scope-policy', scope],
    queryFn: () => loadScopePolicy(api, scope!),
    enabled: scope !== null && peer !== null,
    staleTime: 0,
  })
  const ready = scope !== null && current.isSuccess && (action !== 'prefer' || model !== '')
  const policy = current.data ?? null
  const createsAllowList = action === 'allow' && ready && !policy?.allowedPeerIds && !policy?.allowedPeerLists
  const dropsAllowList = action === 'block' && ready && peer !== null && blockEmptiesAllowList(policy, peer.peerId)

  let targetLabel = scopes.find((entry) => entry.value === kind)?.label.replace(/^A[n]? /, 'the ') ?? 'this scope'
  if (kind === 'key') targetLabel = `key “${keyOptions.find((key) => key.id === targetId)?.label ?? targetId}”`
  if (kind === 'member') targetLabel = `member “${members.data?.find((member) => member.id === targetId)?.label ?? targetId}”`
  const save = useMutation({
    mutationFn: async (options: SaveOptions = {}): Promise<PeerOutcome | null> => {
      if (!peer || !scope) return null
      const previewModel = model || peer.services[0]?.service || ''
      const { changed } = await applyPeerActionToScope(api, scope, action, peer.peerId, model || undefined, options)
      // What the scope's requests actually get now: other levels may still exclude the seller.
      let preview = null
      let previewError: string | null = null
      if (previewModel) {
        try { preview = await api.network.routePreview(previewQueryFor(scope, previewModel, workspace.id)) } catch (error) { previewError = errorMessage(error) }
      }
      return describePeerOutcome({ action, name: peerName(peers, peer.peerId), scopeLabel: targetLabel, changed, model: previewModel, preview, peerId: peer.peerId, previewError })
    },
    onSuccess: (result) => {
      for (const group of POLICY_GROUPS) void queryClient.invalidateQueries({ queryKey: [group] })
      if (!result) return
      if (result.tone === 'success') {
        toast(result.text)
        onClose()
      } else {
        setOutcome(result)
      }
    },
    onError: (error) => {
      const name = peer ? peerName(peers, peer.peerId) : 'this seller'
      // Nothing was stored: say why instead of claiming success.
      if (isApiError(error, 'narrowed')) {
        setOutcome({ tone: 'warning', canForce: true, text: `Nothing changed yet. The levels above ${targetLabel} do not allow ${name}, so saving this would not let it serve. ${narrowedSummary(error.details).join(' ')}`.trim() })
      } else if (isApiError(error, 'empty_allow_list')) {
        const change = action === 'block' ? `Blocking ${name}` : `Allowing only ${name}`
        setOutcome({ tone: 'warning', text: `Nothing changed. ${change} on ${targetLabel} would leave no seller that the levels above allow, so requests would fail. Change the policy on the Routing page if you really want that.` })
      }
    },
  })

  const name = peer ? peerName(peers, peer.peerId) : ''
  return (
    <Modal isOpen={peer !== null} onClose={onClose} title={ACTION_COPY[action].title} subtitle={name}>
      <div className="gc-stack">
        <SelectField label="Apply to" value={kind} onChange={(value) => setKind(value as ScopeKind)} options={scopes} />
        {kind === 'member' && (
          <SelectField label="Member" value={targetId} onChange={setTargetId}
            options={[{ value: '', label: 'Choose a member' }, ...(members.data ?? []).filter((member) => member.status !== 'disabled').map((member) => ({ value: member.id, label: member.label }))]} />
        )}
        {kind === 'key' && (
          <SelectField label="Key" value={targetId} onChange={setTargetId}
            options={[{ value: '', label: keyOptions.length ? 'Choose a key' : 'No keys you can edit' }, ...keyOptions.map((key) => ({ value: key.id, label: key.label }))]} />
        )}
        {action === 'prefer' && peer && (
          <SelectField label="For model" value={model} onChange={setModel}
            options={peer.services.map((service) => ({ value: service.service, label: service.service }))}
            hint="The seller goes first in this model's fallback chain." />
        )}
        <CurrentPolicy fetching={current.isFetching} error={current.error} ready={ready} policy={policy} />
        {createsAllowList && (
          <Alert tone="warning">This scope has no allow list yet. Allowing {name} creates one, so only allowed sellers can serve it.</Alert>
        )}
        {dropsAllowList && (
          <Alert tone="warning" title="This is the only allowed seller">
            Blocking {name} empties this scope's allow list, so the allow list is removed: any seller that is not blocked may serve it again.
          </Alert>
        )}
        {action === 'block' && <p className="gc-muted">Blocked sellers never serve this scope or anything under it.</p>}
        {kind === 'key' && !wsAdmin && (
          <p className="gc-muted">This changes your own restrictions on the key. Restrictions a workspace admin set still apply.</p>
        )}
        {save.error && !isApiError(save.error, 'narrowed') && !isApiError(save.error, 'empty_allow_list') ? <ErrorAlert error={save.error} title="Could not update the policy" /> : null}
        {outcome ? (
          <>
            <Alert tone={outcome.tone} title={outcomeTitle(outcome)}>{outcome.text}</Alert>
            <div className="gc-actions">
              {outcome.canForce && <Button variant="ghost" disabled={save.isPending} onClick={() => { setOutcome(null); save.mutate({ acceptNarrowed: true }) }}>Save it anyway</Button>}
              <Button onClick={onClose}>{outcome.canForce ? 'Cancel' : 'Done'}</Button>
            </div>
          </>
        ) : (
          <div className="gc-actions">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant={action === 'block' ? 'danger' : 'primary'} disabled={!ready || save.isPending} onClick={() => save.mutate({})}>
              {save.isPending ? 'Saving…' : ACTION_COPY[action].verb}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
