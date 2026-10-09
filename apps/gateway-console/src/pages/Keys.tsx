import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, DataTable, Modal, Pager, Sparkline, TextField, usePager } from '@antseed/ui'
import { api, hasOwnerLayer } from '../api'
import type { ApiKey, ApiKeyInput, RoutingPolicy } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { CANCELLED, usePolicySaveGuard } from '../components/PolicySaveGuard'
import { Icon } from '../components/icons'
import { KeySecretModal } from '../components/KeySecretModal'
import { LimitsEditor } from '../components/LimitsEditor'
import { PolicyFieldset, usePolicyDraft } from '../components/PolicyField'
import { Badge, ConfirmDialog, DetailList, EmptyState, ErrorAlert, NameWithHint, PageHeader, Panel, QueryView, SelectField, Switch } from '../components/ui'
import { toDateInput } from '../lib/dates'
import { describeLimits, formatDate, formatRelative, formatUsd, usdcToNumber } from '../lib/format'
import { draftToLimits, limitsToDraft, type LimitsDraft } from '../lib/limits'
import { useConsoleMutation } from '../lib/mutations'
import { isWorkspaceAdmin } from '../lib/nav'
import { describePolicy } from '../lib/policy'
import { keyEditRights, keyEffective, keyPatch } from '../lib/key-layers'
import { qk, useKeys, useWorkspace, useWorkspaceMembers } from '../lib/queries'
import { dailySeries, rangeFrom } from '../lib/usage'

const SPARK_DAYS = '30d'

type SavedKey = { key: ApiKey; secret?: string }
type KeyAction = { kind: 'rotate' | 'revoke'; key: ApiKey }

/** Daily spend for one key over the last 30 days (admins only). */
function KeySparkline({ keyId }: { keyId: string }) {
  const [now] = useState(() => Date.now())
  const from = rangeFrom(SPARK_DAYS, now)
  const report = useQuery({
    queryKey: qk.usage({ key: keyId, from, groupBy: 'day', spark: true }),
    queryFn: () => api.usage.report({ key: keyId, from, to: now, groupBy: 'day' }),
    staleTime: 60_000,
  })
  if (!report.data) return <span className="as-spark as-spark--empty" aria-hidden="true" />
  return <Sparkline label="Daily spend, last 30 days" format={formatUsd} per="a day" emptyText="no spend" values={dailySeries(report.data, from, now).map((point) => point.value)} />
}

function keyStatusBadge(key: ApiKey) {
  if (key.status === 'revoked') return <Badge tone="danger">Revoked</Badge>
  if (key.expiresAt && key.expiresAt < Date.now()) return <Badge tone="warning">Expired</Badge>
  if (key.expiresAt) return <Badge tone="neutral" title={`Expires ${formatDate(key.expiresAt)}`}>Until {formatDate(key.expiresAt)}</Badge>
  return <Badge tone="success">Active</Badge>
}

/** Read-only view of a restriction layer the viewer cannot change. */
function LayerSummary({ title, note, limits, policy }: { title: string; note: string; limits: ApiKey['limits'] | null | undefined; policy: RoutingPolicy | null | undefined }) {
  return (
    <div className="gc-layer gc-layer--readonly">
      <div className="gc-inline gc-inline--between"><div className="as-field__label">{title}</div><Badge>Read only</Badge></div>
      <DetailList items={[['Spend limits', describeLimits(limits ?? null)], ['Routing', describePolicy(policy ?? null)]]} />
      <p className="gc-fineprint">{note}</p>
    </div>
  )
}

/** One restriction layer the viewer edits: spend limits and a routing policy. */
function LayerFields({ title, idPrefix, limits, onLimitsChange, limitsNote, policy }: {
  title: string | null; idPrefix: string; limits: LimitsDraft; onLimitsChange: (value: LimitsDraft) => void; limitsNote: string
  policy: ReturnType<typeof usePolicyDraft>
}) {
  return (
    <div className="gc-layer">
      {title && <div className="as-field__label">{title}</div>}
      <div>
        <div className="as-field__label gc-label-row">Spend limits (USD)</div>
        <LimitsEditor idPrefix={idPrefix} value={limits} onChange={onLimitsChange} />
        <p className="gc-fineprint">{limitsNote}</p>
      </div>
      <PolicyFieldset draft={policy.draft} setDraft={policy.setDraft} />
    </div>
  )
}

/** Create or edit form. Expiry is the end of the chosen UTC day. */
function KeyForm({ initial, layeredHint, onSaved, onCancel }: {
  initial: ApiKey | null; layeredHint: boolean; onSaved: (result: SavedKey) => void; onCancel: () => void
}) {
  const { workspace, viewer, me } = useConsole()
  const admin = isWorkspaceAdmin(viewer)
  const layers = hasOwnerLayer(initial) ? initial : null
  const [label, setLabel] = useState(initial?.label ?? '')
  const [adminLimits, setAdminLimits] = useState(limitsToDraft(initial?.limits))
  const [ownerLimits, setOwnerLimits] = useState(limitsToDraft(layers ? layers.ownerLimits : initial?.limits))
  const [expires, setExpires] = useState(toDateInput(initial?.expiresAt ?? null))
  const [topup, setTopup] = useState(initial?.topupEnabled ?? false)
  const [owner, setOwner] = useState(initial?.ownerMemberId ?? me.member.id)
  const adminPolicy = usePolicyDraft(initial?.routingPolicy)
  const ownerPolicy = usePolicyDraft(layers ? layers.ownerRoutingPolicy : initial?.routingPolicy)
  const rights = keyEditRights(initial, { memberId: me.member.id, workspaceAdmin: admin }, layeredHint)
  const detail = useWorkspace(workspace.id, admin)
  const defaultWallet = (initial?.buyerIdentity ?? detail.data?.buyerIdentity) === 'default'
  const members = useWorkspaceMembers(workspace.id, admin && !initial)
  const guard = usePolicySaveGuard()
  const [error, setError] = useState<unknown>(null)
  // On create there is one layer to fill: the admin layer for admins, the owner's own otherwise.
  const showAdmin = rights.admin
  const showOwner = initial ? rights.owner && (rights.layered || !rights.admin) : !rights.admin
  const editingLayers = initial !== null && rights.layered
  let ownerTitle: string | null = null
  if (editingLayers) ownerTitle = rights.admin ? 'Your restrictions as the key owner' : 'Your restrictions'
  const submitLabel = initial ? 'Save' : 'Create key'
  const ownerLimitsNote = rights.layered || !initial
    ? 'UTC periods; weeks start Monday. Workspace, member and admin limits apply too.'
    : 'You can only tighten your key: a higher or cleared limit is ignored.'
  const save = useConsoleMutation({
    mutationFn: async (): Promise<SavedKey | typeof CANCELLED> => {
      const expiresAt = expires ? Date.parse(`${expires}T23:59:59Z`) : null
      const aPolicy = showAdmin ? adminPolicy.build() : null
      const oPolicy = showOwner ? ownerPolicy.build() : null
      const aLimits = draftToLimits(adminLimits)
      const oLimits = draftToLimits(ownerLimits)
      if (initial) {
        const patch = keyPatch(rights, initial, { label: label.trim(), expiresAt, topupEnabled: topup, adminLimits: aLimits, adminPolicy: aPolicy, ownerLimits: oLimits, ownerPolicy: oPolicy })
        const saved = await guard.save([patch.routingPolicy, patch.ownerRoutingPolicy], (options) => api.keys.update(initial.id, patch, options))
        return saved === CANCELLED ? CANCELLED : { key: saved }
      }
      // A non-admin's limits and policy are stored as the owner layer of their new key.
      const input: ApiKeyInput = {
        label: label.trim(),
        workspaceId: workspace.id,
        limits: rights.admin ? aLimits : oLimits,
        routingPolicy: rights.admin ? aPolicy : oPolicy,
        topupEnabled: rights.admin ? topup : false,
        expiresAt,
      }
      if (rights.admin) input.ownerMemberId = owner || null
      return guard.save([input.routingPolicy], (options) => api.keys.create(input, options))
    },
    onSuccess: onSaved,
    invalidate: [qk.group('keys')],
    toast: (result) => (result.secret ? null : 'Key saved'),
    onError: setError,
  })

  return (
    <form className="gc-stack" onSubmit={(event) => { event.preventDefault(); setError(null); save.mutate() }}>
      <TextField label="Name" required placeholder="e.g. Production backend" value={label} onChange={(event) => setLabel(event.target.value)} />
      {!initial && admin && members.data && (
        <SelectField label="Owner" value={owner} onChange={setOwner}
          options={members.data.map(({ member }) => ({ value: member.id, label: member.id === me.member.id ? `${member.label} (you)` : member.label }))} />
      )}
      {showAdmin && (
        <LayerFields title={editingLayers ? 'Workspace admin restrictions' : null} idPrefix="key-limit" limits={adminLimits} onLimitsChange={setAdminLimits}
          limitsNote="UTC periods; weeks start Monday. The workspace and member budgets apply too." policy={adminPolicy} />
      )}
      {!showAdmin && editingLayers && (
        <LayerSummary title="Set by workspace admins" limits={initial.limits} policy={initial.routingPolicy}
          note="These always apply to this key. Your own restrictions below can only add to them." />
      )}
      {showOwner && (
        <LayerFields title={ownerTitle} idPrefix="key-owner-limit" limits={ownerLimits} onLimitsChange={setOwnerLimits} limitsNote={ownerLimitsNote}
          policy={ownerPolicy} />
      )}
      {editingLayers && !rights.owner && (
        <LayerSummary title="Set by the key owner" limits={layers?.ownerLimits} policy={layers?.ownerRoutingPolicy}
          note="Only the key's owner changes these. They apply on top of yours." />
      )}
      <TextField label="Expires" type="date" value={expires} onChange={(event) => setExpires(event.target.value)}
        hint={admin ? 'Leave blank for no expiry.' : 'You can set or bring forward an expiry; only an admin can extend or remove it.'} />
      {admin && (
        <Switch checked={topup} onChange={setTopup} disabled={defaultWallet && !topup} label="Allow top-ups"
          description={defaultWallet ? 'Keys paid from the default wallet cannot be topped up.' : 'Let the key holder add funds to this key with USDC (x402).'} />
      )}
      {error ? <ErrorAlert error={error} title="Could not save the key" /> : null}
      <div className="gc-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={save.isPending || !label.trim()}>{save.isPending ? 'Saving…' : submitLabel}</Button>
      </div>
      {guard.dialog}
    </form>
  )
}

const KEYS_PAGE = 25

/** Search and paginate the key list; `render` gets the visible page. */
function KeyRows({ list, search, showRevoked, ownerLabel, render }: {
  list: ApiKey[]; search: string; showRevoked: boolean; ownerLabel: (key: ApiKey) => string
  render: (rows: ApiKey[], filtered: boolean) => React.ReactNode
}) {
  const needle = search.trim().toLowerCase()
  const rows = useMemo(() => list.filter((key) => (showRevoked || key.status === 'active')
    && (!needle || key.label.toLowerCase().includes(needle) || key.hint.toLowerCase().includes(needle) || ownerLabel(key).toLowerCase().includes(needle))),
  [list, showRevoked, needle, ownerLabel])
  const pager = usePager(rows, KEYS_PAGE, `${needle}|${showRevoked}`)
  return (
    <>
      {render(pager.items, rows.length === 0 && list.length > 0)}
      <Pager pager={pager} noun="keys" />
    </>
  )
}

function confirmCopy(confirm: KeyAction | null) {
  if (confirm?.kind === 'rotate') {
    return {
      title: 'Rotate this key?', confirmLabel: 'Rotate key', tone: 'primary' as const,
      body: <>The current secret for <strong>{confirm.key.label}</strong> stops working now. You get a new secret to replace it.</>,
    }
  }
  return {
    title: 'Revoke this key?', confirmLabel: 'Revoke key', tone: 'danger' as const,
    body: <>Requests with <strong>{confirm?.key.label}</strong> fail from now on. This cannot be undone.</>,
  }
}

export default function Keys() {
  const { workspace, me, viewer } = useConsole()
  const scope = useScopeFilter()
  const admin = isWorkspaceAdmin(viewer)
  const members = useWorkspaceMembers(workspace.id, admin)
  const [editing, setEditing] = useState<ApiKey | 'new' | null>(null)
  const [secret, setSecret] = useState<{ key: ApiKey; secret: string } | null>(null)
  const [confirm, setConfirm] = useState<KeyAction | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)
  const [search, setSearch] = useState('')
  const keys = useKeys(scope)

  const action = useConsoleMutation({
    mutationFn: async ({ kind, key }: KeyAction) => {
      if (kind === 'rotate') setSecret(await api.keys.rotate(key.id))
      else await api.keys.revoke(key.id)
    },
    onSuccess: () => setConfirm(null),
    invalidate: [qk.group('keys')],
    toast: (_, { kind }) => (kind === 'revoke' ? 'Key revoked' : null),
  })

  const ownerLabel = (key: ApiKey) => {
    if (!key.ownerMemberId) return '—'
    if (key.ownerMemberId === me.member.id) return 'You'
    return members.data?.find(({ member }) => member.id === key.ownerMemberId)?.member.label ?? 'Another member'
  }

  return (
    <div className="gc-page">
      <PageHeader title="API keys" description={`Keys for the ${workspace.name} workspace. Each key spends from this workspace's wallet.`}
        actions={<Button variant="brand" leadingIcon={<Icon.plus size={14} />} onClick={() => setEditing('new')}>Create key</Button>} />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search keys" placeholder="Search name, hint or owner" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Switch checked={showRevoked} onChange={setShowRevoked} label="Show revoked" />
      </div>
      <Panel flush>
        <QueryView query={keys}>
          {(list) => (
            <KeyRows list={list} search={search} showRevoked={showRevoked} ownerLabel={ownerLabel} render={(rows, filtered) => (
              <DataTable<ApiKey> label="API keys" rows={rows} rowKey={(key) => key.id} rowLabel={(key) => key.label}
                onRowClick={(key) => key.status === 'active' && setEditing(key)}
                actions={(key) => key.status === 'active' ? [
                  { label: 'Edit', onSelect: () => setEditing(key) },
                  { label: 'Rotate secret', onSelect: () => setConfirm({ kind: 'rotate', key }) },
                  { label: 'Revoke', tone: 'danger' as const, onSelect: () => setConfirm({ kind: 'revoke', key }) },
                ] : []}
                empty={filtered
                  ? <EmptyState icon={<Icon.keys size={18} />} title="No keys match" body="Try another search, or show revoked keys." />
                  : <EmptyState icon={<Icon.keys size={18} />} title="No keys yet" body="Create a key to call models through this gateway." action={<Button onClick={() => setEditing('new')}>Create key</Button>} />}
                columns={[
                  { key: 'label', header: 'Name', sortValue: (key) => key.label, render: (key) => <NameWithHint name={key.label} hint={key.hint} /> },
                  { key: 'owner', header: 'Owner', secondary: true, render: ownerLabel },
                  { key: 'limits', header: 'Limits', secondary: true, optional: true, render: (key) => <span className="gc-muted">{describeLimits(keyEffective(key).limits)}</span> },
                  { key: 'policy', header: 'Routing', secondary: true, optional: true, render: (key) => <span className="gc-muted">{describePolicy(keyEffective(key).policy)}</span> },
                  ...(admin ? [{ key: 'trend', header: '30 days', secondary: true, render: (key: ApiKey) => <KeySparkline keyId={key.id} /> }] : []),
                  { key: 'month', header: 'This month', align: 'right', sortValue: (key) => usdcToNumber(key.usage.spentThisMonth), render: (key) => formatUsd(key.usage.spentThisMonth) },
                  { key: 'used', header: 'Last used', secondary: true, optional: true, sortValue: (key) => key.lastUsedAt, render: (key) => formatRelative(key.lastUsedAt) },
                  { key: 'status', header: 'Status', secondary: true, render: keyStatusBadge },
                ]} />
            )} />
          )}
        </QueryView>
      </Panel>

      <Modal isOpen={editing !== null} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'Create API key' : 'Edit API key'}>
        {editing !== null && (
          <KeyForm initial={editing === 'new' ? null : editing} layeredHint={(keys.data ?? []).some(hasOwnerLayer)} onCancel={() => setEditing(null)} onSaved={(result) => {
            setEditing(null)
            if (result.secret) setSecret({ key: result.key, secret: result.secret })
          }} />
        )}
      </Modal>

      <KeySecretModal result={secret} onClose={() => setSecret(null)} />

      <ConfirmDialog isOpen={confirm !== null} busy={action.isPending} error={action.error}
        onClose={() => { setConfirm(null); action.reset() }}
        onConfirm={() => confirm && action.mutate(confirm)}
        {...confirmCopy(confirm)} />
    </div>
  )
}
