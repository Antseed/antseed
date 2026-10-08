import { useId, useMemo, useState } from 'react'
import { Alert, Button, ConfirmDialog, Disclosure, Segmented, SelectField, Switch, TextField } from '@antseed/ui'
import type { Peer, PeerList, RoutingPolicy, RoutingSort } from '../api/types'
import { modelsFromPeers } from '../lib/queries'
import {
  draftToPolicy, emptyDraft, mergeTemplate, POLICY_TEMPLATES, SORT_LABELS, templateConflicts, templateDraft, templatePolicy,
  type DraftRoute, type PolicyDraft, type TemplateId,
} from '../lib/policy'
import { combinePolicies, hasReputationData, matchingPeers } from '../lib/policy-match'
import { ChipsInput, PeerPicker } from './PeerPicker'

/** "Matches N of M sellers" for the draft combined with the levels above it; warns at zero. */
function MatchSummary({ draft, parent, peers, lists }: { draft: PolicyDraft; parent?: RoutingPolicy | null; peers?: readonly Peer[]; lists: readonly PeerList[] }) {
  const result = useMemo(() => {
    if (!peers || peers.length === 0) return null
    let own: RoutingPolicy
    try { own = draftToPolicy(draft, lists) } catch { return null }
    const matched = matchingPeers(combinePolicies(parent, own), peers, lists)
    return { matched: matched.length, total: peers.length }
  }, [draft, parent, peers, lists])
  if (!result) return null
  if (result.matched === 0) {
    return (
      <Alert tone="warning" title="No seller matches this policy">
        With {parent ? 'the levels above and ' : ''}these settings, none of the {result.total} sellers this gateway sees can serve a request. Requests will fail until you loosen it.
      </Alert>
    )
  }
  return <p className="gc-muted" aria-live="polite">Matches {result.matched} of {result.total} sellers{parent ? ' after the levels above' : ''}.</p>
}

/**
 * Routing policy editor, shared by keys, members, workspaces, presets and the
 * gateway default. Every field left blank inherits from the level above;
 * levels can only narrow what the level above allows.
 */
export function PolicyEditor({ value, onChange, peers, lists, showTemplates = true, parent, disabled }: {
  value: PolicyDraft; onChange: (value: PolicyDraft) => void; peers?: readonly Peer[]; lists: readonly PeerList[]; showTemplates?: boolean
  /** The combined policy of the levels above, for the match count. */
  parent?: RoutingPolicy | null
  disabled?: boolean
}) {
  const [ownListId, setOwnListId] = useState('')
  const [pending, setPending] = useState<{ label: string; template: Partial<PolicyDraft>; conflicts: string[] } | null>(null)
  const set = <K extends keyof PolicyDraft>(key: K, next: PolicyDraft[K]) => onChange({ ...value, [key]: next })
  const models = modelsFromPeers(peers as Peer[] | undefined)
  const listOptions = lists.map((list) => ({ value: list.id, label: `${list.name} (${list.peerIds.length})` }))
  const showReputation = hasReputationData(peers) || value.minReputation !== ''

  function applyTemplate(id: TemplateId) {
    let template: Partial<PolicyDraft>
    if (id === 'own') {
      const list = lists.find((entry) => entry.id === ownListId)
      if (!list) return
      template = { allowMode: 'only', allowedPeerIds: [], allowedListIds: [list.id] }
    } else {
      template = templateDraft(templatePolicy(id))
    }
    const conflicts = templateConflicts(value, template)
    const label = POLICY_TEMPLATES.find((entry) => entry.id === id)?.label ?? id
    if (conflicts.length > 0) setPending({ label, template, conflicts })
    else onChange(mergeTemplate(value, template))
  }

  function updateRoute(index: number, route: DraftRoute) {
    set('routes', value.routes.map((entry, current) => (current === index ? route : entry)))
  }

  const capCount = [value.maxInputUsdPerMillion, value.maxOutputUsdPerMillion, value.maxCachedInputUsdPerMillion, value.maxImageUsdPerImage].filter((entry) => entry.trim() !== '').length
  const capField = (key: 'maxInputUsdPerMillion' | 'maxOutputUsdPerMillion' | 'maxCachedInputUsdPerMillion' | 'maxImageUsdPerImage', label: string) => (
    <TextField size="sm" className="gc-num" label={label} inputMode="decimal" placeholder="No cap" value={value[key]}
      onChange={(event) => set(key, event.target.value)} />
  )

  // Inline JSX, not nested components, so inputs keep focus across renders.
  const content = (
    <>
      <MatchSummary draft={value} parent={parent} peers={peers} lists={lists} />
      {showTemplates && !disabled && (
        <div className="gc-policy__templates">
          <span className="gc-muted">Start from</span>
          {POLICY_TEMPLATES.filter((template) => template.id !== 'own').map((template) => (
            <Button key={template.id} size="sm" variant="outline" title={template.description} onClick={() => applyTemplate(template.id)}>{template.label}</Button>
          ))}
          {lists.length > 0 && (
            <span className="gc-inline">
              <SelectField size="sm" aria-label="Peer list for Own peers only" value={ownListId} onChange={setOwnListId}
                options={[{ value: '', label: 'Own peer list…' }, ...listOptions]} />
              <Button size="sm" variant="outline" disabled={!ownListId} onClick={() => applyTemplate('own')}>Use</Button>
            </span>
          )}
          <Button size="sm" variant="link" className="gc-policy__clear" onClick={() => onChange(emptyDraft())}>Clear policy</Button>
        </div>
      )}

      <div className="gc-policy__cols">
        <section className="gc-policy__section">
          <h3>Sellers</h3>
          <Segmented label="Which sellers may serve" value={value.allowMode} onChange={(mode) => set('allowMode', mode)}
            options={[{ value: 'any', label: 'Any seller' }, { value: 'only', label: 'Only these' }]} />
          {value.allowMode === 'only' && (
            <>
              <PeerPicker label="Allowed sellers" value={value.allowedPeerIds} onChange={(next) => set('allowedPeerIds', next)} peers={peers} />
              <ListPicker label="Allowed peer lists" lists={lists} value={value.allowedListIds} onChange={(next) => set('allowedListIds', next)} />
              {value.allowedPeerIds.length === 0 && value.allowedListIds.length === 0 && (
                <p className="gc-warn">An empty allow list means no seller can serve.</p>
              )}
            </>
          )}
          <PeerPicker label="Blocked sellers" value={value.blockedPeerIds} onChange={(next) => set('blockedPeerIds', next)} peers={peers} />
          <ListPicker label="Blocked peer lists" lists={lists} value={value.blockedListIds} onChange={(next) => set('blockedListIds', next)} />
        </section>

        <section className="gc-policy__section">
          <h3>Quality and ranking</h3>
          <Slider label="Minimum trust score" value={value.minTrustScore} onChange={(next) => set('minTrustScore', next)} />
          <div className="gc-policy__switches">
            <Switch checked={value.requireTee} onChange={(next) => set('requireTee', next)} label="TEE sellers only" />
            <Switch checked={value.requireVerified} onChange={(next) => set('requireVerified', next)} label="Verified sellers only" />
          </div>
          <div className="gc-policy__pair">
            <SelectField size="sm" label="Sort by" value={value.sort} onChange={(next) => set('sort', next as RoutingSort | '')}
              options={[{ value: '', label: 'Inherit' }, ...(Object.keys(SORT_LABELS) as RoutingSort[]).map((sort) => ({ value: sort, label: SORT_LABELS[sort] }))]} />
            <SelectField size="sm" label="Free sellers first" value={value.preferFreePeers} onChange={(next) => set('preferFreePeers', next as PolicyDraft['preferFreePeers'])}
              options={[{ value: 'inherit', label: 'Inherit' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
          </div>
          <Segmented label="Which models may be used" value={value.modelsMode} onChange={(mode) => set('modelsMode', mode)}
            options={[{ value: 'any', label: 'Any model' }, { value: 'only', label: 'Only these models' }]} />
          {value.modelsMode === 'only' && (
            <ChipsInput label="Allowed models" value={value.allowedModels} onChange={(next) => set('allowedModels', next)} suggestions={models} placeholder="Model id" />
          )}
        </section>
      </div>

      <div className="gc-policy__advanced">
        <Disclosure title="Price caps" summary={capCount ? `${capCount} set` : 'None'} defaultOpen={disabled && capCount > 0}>
          <div className="gc-policy__caps">
            {capField('maxInputUsdPerMillion', 'Input $/M')}
            {capField('maxOutputUsdPerMillion', 'Output $/M')}
            {capField('maxCachedInputUsdPerMillion', 'Cached input $/M')}
            {capField('maxImageUsdPerImage', '$ per image')}
          </div>
        </Disclosure>
        <Disclosure title="Fallback chains" summary={value.routes.length ? `${value.routes.length} chain${value.routes.length === 1 ? '' : 's'}` : 'None'}
          defaultOpen={disabled && value.routes.length > 0}>
          <p className="gc-fineprint">Sellers to try first for a model, in order. After the chain, normal ranking continues unless the chain is strict.</p>
          {value.routes.map((route, index) => (
            <div key={index} className="gc-route">
              <div className="gc-inline">
                <TextField size="sm" label="Model" list="gc-policy-models" value={route.model} placeholder="Model id"
                  onChange={(event) => updateRoute(index, { ...route, model: event.target.value })} />
                <Switch checked={route.strict} onChange={(strict) => updateRoute(index, { ...route, strict })} label="Strict" />
                <Button variant="ghost" size="sm" onClick={() => set('routes', value.routes.filter((_, current) => current !== index))}>Remove</Button>
              </div>
              <PeerPicker label="Sellers, in order" ordered value={route.peerIds} onChange={(peerIds) => updateRoute(index, { ...route, peerIds })} peers={peers} />
            </div>
          ))}
          <datalist id="gc-policy-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
          <div><Button variant="outline" size="sm" onClick={() => set('routes', [...value.routes, { model: '', peerIds: [], strict: false }])}>Add fallback chain</Button></div>
        </Disclosure>
        {showReputation && (
          <Disclosure title="Reputation" summary={value.minReputation !== '' ? `≥ ${value.minReputation}` : 'Inherit'} defaultOpen={disabled && value.minReputation !== ''}>
            <Slider label="Minimum reputation" value={value.minReputation} onChange={(next) => set('minReputation', next)} />
          </Disclosure>
        )}
      </div>
      <ConfirmDialog isOpen={pending !== null} tone="primary" title={`Apply “${pending?.label ?? ''}”?`} confirmLabel="Replace and apply"
        body={<>This template changes settings you already set: <strong>{pending?.conflicts.join(', ')}</strong>. Your other settings stay.</>}
        onClose={() => setPending(null)}
        onConfirm={() => { if (pending) onChange(mergeTemplate(value, pending.template)); setPending(null) }} />
    </>
  )

  if (disabled) return <fieldset className="gc-policy gc-policy--readonly" disabled>{content}</fieldset>
  return <div className="gc-policy">{content}</div>
}

function Slider({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const labelId = useId()
  const enabled = value !== ''
  return (
    <div className="gc-slider">
      <div className="gc-slider__head">
        <span className="as-field__label" id={labelId}>{label}</span>
        <span className="gc-slider__value">{enabled ? value : 'Inherit'}</span>
      </div>
      <div className="gc-inline">
        <input type="range" min={0} max={100} step={5} value={enabled ? Number(value) : 0} aria-labelledby={labelId}
          onChange={(event) => onChange(event.target.value)} />
        {enabled && <Button variant="ghost" size="sm" onClick={() => onChange('')}>Clear</Button>}
      </div>
    </div>
  )
}

function ListPicker({ label, lists, value, onChange }: { label: string; lists: readonly PeerList[]; value: string[]; onChange: (value: string[]) => void }) {
  if (lists.length === 0) return null
  return (
    <fieldset className="gc-checks">
      <legend className="as-field__label">{label}</legend>
      {lists.map((list) => (
        <label key={list.id} className="gc-check">
          <input type="checkbox" checked={value.includes(list.id)}
            onChange={(event) => onChange(event.target.checked ? [...value, list.id] : value.filter((id) => id !== list.id))} />
          {list.name} <span className="gc-muted">({list.peerIds.length})</span>
        </label>
      ))}
    </fieldset>
  )
}
