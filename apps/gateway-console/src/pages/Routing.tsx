import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Modal, useToast } from '@antseed/ui'
import { api, type SaveOptions } from '../api'
import type { RoutePreview, RoutingPolicy } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { CANCELLED, usePolicySaveGuard } from '../components/PolicySaveGuard'
import { PolicyEditor } from '../components/PolicyEditor'
import { draftStatus } from '../components/PolicyField'
import { previewQuery, TryRequest, type TryRequestState } from '../components/RoutePreview'
import { PeerListsPanel } from '../components/PeerLists'
import { Badge, ErrorAlert, LoadingRows, PageHeader, PageLink, Panel } from '../components/ui'
import { isOrgAdmin, isWorkspaceAdmin } from '../lib/nav'
import { buyerPolicy, draftToPolicy, policyOrNull, policyToDraft, type PolicyDraft } from '../lib/policy'
import { exclusionCounts, policySentences } from '../lib/policy-explain'
import { combinePolicies, expandLists } from '../lib/policy-match'
import { qk, useBuyerLimits, useFavorites, useGatewayPolicy, useKeys, useModels, usePeerLists, usePeers, usePresets, useWorkspace } from '../lib/queries'
import { loadStored, saveStored } from '../lib/stored'

type Layer = 'gateway' | 'org' | 'workspace'
type Level = RoutePreview['sources'][number]['level']

const LAYER_COPY: Record<Layer, { title: string; description: (workspace: string) => string }> = {
  gateway: { title: 'Gateway default', description: () => 'Set by organization admins. Applies to every request through this gateway.' },
  org: { title: 'Organization policy', description: (ws) => `Set by organization admins for the ${ws} workspace. Workspace admins cannot loosen it.` },
  workspace: { title: 'Workspace policy', description: (ws) => `Set by ${ws}'s admins for their own keys.` },
}

const sameDraft = (a: PolicyDraft, b: PolicyDraft) => JSON.stringify(a) === JSON.stringify(b)

/** What a level does to the model being tried: how many of its sellers it keeps out. */
interface Impact { model: string; total: number; excluded: number }

/** One numbered step of the rule chain: who sets it, what it says in sentences, and what it does to the model being tried. */
function Step({ index, title, who, sentences, empty = 'No rules of its own.', impact, badge, action, result }: {
  index: ReactNode; title: ReactNode; who: ReactNode; sentences: string[]; empty?: string
  impact?: Impact | null; badge?: ReactNode; action?: ReactNode; result?: boolean
}) {
  return (
    <li className={result ? 'gc-funnel__step gc-funnel__step--result' : 'gc-funnel__step'}>
      <span className="gc-funnel__index" aria-hidden="true">{index}</span>
      <div className="gc-funnel__body">
        <div className="gc-funnel__head">
          <span className="gc-funnel__title">{title}</span>
          {badge}
          {action && <span className="gc-funnel__action">{action}</span>}
        </div>
        <div className="gc-fineprint">{who}</div>
        {sentences.length > 0
          ? <ul className="gc-funnel__rules">{sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
          : <p className="gc-funnel__none">{empty}</p>}
        {impact && (
          <p className={impact.excluded > 0 ? 'gc-funnel__impact gc-funnel__impact--on' : 'gc-funnel__impact'}>
            {impact.excluded > 0
              ? `Keeps ${impact.excluded} of ${impact.total} seller${impact.total === 1 ? '' : 's'} of ${impact.model} out.`
              : `Keeps no seller of ${impact.model} out.`}
          </p>
        )}
      </div>
    </li>
  )
}

/**
 * One editable policy level as a step. `source` is the saved policy; `parent` combines
 * the levels above it. Local edits survive refetches: when the saved policy
 * changes while the draft has unsaved edits, the editor says so and lets the
 * user reload it or keep editing instead of silently replacing their work.
 */
function LayerStep({ index, layer, source, parent, canEdit, impact, onSave }: {
  index: number; layer: Layer; source: RoutingPolicy | null; parent: RoutingPolicy | null; canEdit: boolean; impact: Impact | null
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
  const shown = dirty ? status.policy : source
  const empty = !source || Object.keys(source).length === 0
  return (
    <>
      <Step index={index} title={LAYER_COPY[layer].title} who={LAYER_COPY[layer].description(workspace.name)}
        sentences={dirty && status.error ? [] : policySentences(shown, peers.data, lists.data ?? [])}
        empty={dirty && status.error ? 'Has an invalid setting; open it to fix.' : 'No rules of its own: passes on everything above.'}
        impact={impact}
        badge={dirty ? <Badge tone="warning">Unsaved changes</Badge> : !canEdit ? <Badge>Read only</Badge> : undefined}
        action={<Button size="sm" variant={canEdit && empty ? 'outline' : 'ghost'} onClick={() => setEditing(true)}>{!canEdit ? 'View' : empty ? 'Add rules' : 'Edit'}</Button>} />
      {conflict && canEdit && !editing && (
        <li className="gc-funnel__note"><Alert tone="warning" title="Changed elsewhere">Someone saved this policy while you were editing it. Open it to reload theirs or keep yours.</Alert></li>
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
    </>
  )
}

/**
 * Every level of rules a request passes, top to bottom, each in plain
 * sentences with what it does to the model being tried; then what they add
 * up to for this workspace.
 */
function RuleChain({ preview }: { preview: RoutePreview | undefined }) {
  const { workspace, viewer } = useConsole()
  const queryClient = useQueryClient()
  const scope = useScopeFilter()
  const peers = usePeers()
  const lists = usePeerLists()
  const limits = useBuyerLimits()
  const gateway = useGatewayPolicy()
  const detail = useWorkspace(workspace.id)
  const keys = useKeys(scope)
  const presets = usePresets(workspace.id)
  const listData = lists.data ?? []
  const gatewayPolicy = gateway.data ? expandLists(gateway.data, listData) : null
  const orgPolicy = detail.data?.orgRoutingPolicy ?? null
  const wsPolicy = detail.data?.routingPolicy ?? null
  const buyer = useMemo(() => buyerPolicy(limits.data), [limits.data])
  const effective = useMemo(
    () => combinePolicies(buyer, gatewayPolicy, orgPolicy && expandLists(orgPolicy, listData), wsPolicy && expandLists(wsPolicy, listData)),
    [buyer, gatewayPolicy, orgPolicy, wsPolicy, listData],
  )
  const counts = useMemo(() => exclusionCounts(preview, peers.data, listData), [preview, peers.data, listData])
  const impact = (...levels: Level[]): Impact | null => preview && preview.modelAllowed
    ? { model: preview.model, total: preview.candidates.length, excluded: levels.reduce((sum, level) => sum + (counts.get(level) ?? 0), 0) }
    : null
  if (gateway.isLoading || detail.isLoading) return <Panel title="Rules that apply"><LoadingRows rows={6} /></Panel>
  if (gateway.error) return <ErrorAlert error={gateway.error} onRetry={() => void gateway.refetch()} />
  if (detail.error) return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />
  const refreshWorkspace = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.group('workspaces') })
    await queryClient.invalidateQueries({ queryKey: qk.group('routing') })
  }
  const keyRules = (keys.data ?? []).filter((key) => key.status === 'active' && key.routingPolicy).length
  const presetRules = (presets.data ?? []).filter((preset) => preset.routingPolicy).length
  const narrower = [
    keyRules ? `${keyRules} key${keyRules === 1 ? ' has its' : 's have their'} own rules.` : null,
    presetRules ? `${presetRules} preset${presetRules === 1 ? ' has' : 's have'} rules.` : null,
  ].filter((line): line is string => line !== null)

  return (
    <Panel title="Rules that apply" description="A request passes every level, top to bottom. Each level can only narrow the ones above it, never loosen them.">
      <ol className="gc-funnel">
        <Step index={1} title="Buyer config" who={<>The buyer&apos;s own limits{isOrgAdmin(viewer) ? <>, set under <PageLink to="settings">Settings</PageLink></> : ''}. Everything below can only narrow them.</>}
          sentences={policySentences(buyer, peers.data, listData)} empty="No limits." impact={impact('buyer')} />
        <LayerStep index={2} layer="gateway" source={gateway.data ?? null} parent={buyer} canEdit={isOrgAdmin(viewer)} impact={impact('gateway')}
          onSave={async (policy, options) => {
            await api.network.setGatewayPolicy(policy, options)
            await queryClient.invalidateQueries({ queryKey: qk.group('routing') })
          }} />
        <LayerStep index={3} layer="org" source={orgPolicy} parent={gatewayPolicy} canEdit={isOrgAdmin(viewer)} impact={impact('workspace-org')}
          onSave={async (policy, options) => { await api.workspaces.update(workspace.id, { orgRoutingPolicy: policyOrNull(policy) }, options); await refreshWorkspace() }} />
        <LayerStep index={4} layer="workspace" source={wsPolicy} parent={combinePolicies(gatewayPolicy, orgPolicy && expandLists(orgPolicy, listData))}
          canEdit={isWorkspaceAdmin(viewer)} impact={impact('workspace')}
          onSave={async (policy, options) => { await api.workspaces.update(workspace.id, { routingPolicy: policyOrNull(policy) }, options); await refreshWorkspace() }} />
        <Step index={5} title="Members, keys and presets" who={<>Can narrow the rules further for one member, one key or one preset: see <PageLink to="keys">Keys</PageLink> and <PageLink to="presets">Presets</PageLink>.</>}
          sentences={narrower} empty="None in this workspace narrows it." impact={impact('member', 'key', 'key-owner', 'preset')} />
        <Step index="=" result title={`Effective for ${workspace.name}`} who="What every key in this workspace gets before its own rules."
          sentences={policySentences(effective, peers.data, listData)} empty="No rules: every seller the network offers." />
      </ol>
    </Panel>
  )
}

const TRY_KEY = 'antseed-console-routing:try'

export default function Routing() {
  const { workspace } = useConsole()
  const peers = usePeers()
  const models = useModels()
  const favorites = useFavorites()
  const [state, setState] = useState<TryRequestState>(() => ({ target: 'workspace', targetId: '', model: loadStored<string | null>(TRY_KEY, null) }))
  useEffect(() => { saveStored(TRY_KEY, state.model) }, [state.model])
  // Start from a model so the page shows a real route at once: the first starred one, else the most offered.
  useEffect(() => {
    if (state.model || !models.data?.length) return
    const starred = favorites.data?.find((id) => models.data!.some((model) => model.id === id))
    const busiest = [...models.data].filter((model) => model.type === 'text').sort((a, b) => b.offers.length - a.offers.length)[0] ?? models.data[0]!
    setState((current) => ({ ...current, model: starred ?? busiest.id }))
  }, [models.data, favorites.data, state.model])
  // The preview runs once someone opens "Try a request"; the rules then show what each level does to that model.
  const [tryOpen, setTryOpen] = useState(false)
  const [tried, setTried] = useState(false)
  const openTry = () => { setTried(true); setTryOpen(true) }
  const query = tried ? previewQuery(state, workspace.id) : null
  const preview = useQuery({
    queryKey: qk.routePreview(query ?? {}),
    queryFn: () => api.network.routePreview(query as { model: string }),
    enabled: query !== null,
    staleTime: 15_000,
  })
  return (
    <div className="gc-page">
      <PageHeader title="Routing" description="The rules that decide which sellers serve your requests. Try a request to see where one for a model goes, and why."
        actions={<Button variant="brand" onClick={openTry}>Try a request</Button>} />
      <RuleChain preview={query && preview.data?.model === state.model ? preview.data : undefined} />
      <PeerListsPanel peers={peers.data} />
      <Modal isOpen={tryOpen} onClose={() => setTryOpen(false)} size="xl" title="Try a request"
        subtitle="Pick a model to see which sellers a request goes to, in what order, and what keeps the others out.">
        <TryRequest state={state} onChange={setState} preview={{ data: query ? preview.data : undefined, isFetching: preview.isFetching, error: preview.error }} />
      </Modal>
    </div>
  )
}
