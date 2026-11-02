import { useId, useMemo, useState, type ReactNode } from 'react'
import { Alert, Button, ConfirmDialog, Disclosure, Segmented, SelectField, Switch, TextField } from '@antseed/ui'
import type { Peer, PeerList, RoutingPolicy, RoutingSort } from '../api/types'
import { modelsFromPeers, useBuyerLimits } from '../lib/queries'
import { useConsole } from '../app/context'
import { canOpen } from '../lib/nav'
import { href, linkHandler } from '../lib/router'
import { Icon } from './icons'
import {
  buyerPolicy, draftToPolicy, emptyDraft, mergeTemplate, POLICY_TEMPLATES, SORT_LABELS, templateConflicts, templateDraft, templatePolicy,
  type DraftRoute, type PolicyDraft, type TemplateId,
} from '../lib/policy'
import { formatPricePerMillion } from '../lib/format'
import { combinePolicies, matchingPeers } from '../lib/policy-match'
import { ChipsInput, PeerPicker } from './PeerPicker'
import { TrustTip } from './TrustInfo'
import { SellerListLink, SellerListsButton } from './PeerLists'
import { policySentences } from '../lib/policy-explain'

/**
 * What this level does, in sentences, and how many sellers are left once it
 * is combined with the buyer config and the levels above; warns at zero.
 */
function DraftSummary({ draft, parent, above, peers, lists }: {
  draft: PolicyDraft; parent: RoutingPolicy | null; above: string; peers?: readonly Peer[]; lists: readonly PeerList[]
}) {
  const own = useMemo(() => { try { return draftToPolicy(draft, lists) } catch { return null } }, [draft, lists])
  const match = useMemo(() => {
    if (!own || !peers || peers.length === 0) return null
    return { matched: matchingPeers(combinePolicies(parent, own), peers, lists).length, total: peers.length }
  }, [own, parent, peers, lists])
  const sentences = own ? policySentences(own, peers, lists) : []
  return (
    <section className="gc-policy__summary" aria-live="polite">
      <div className="gc-policy__summary-head">
        <span className="gc-strong">What this level does</span>
        {match && match.matched > 0 && <span className="gc-muted">{match.matched} of {match.total} sellers can serve{above ? ` after ${above}` : ''}</span>}
      </div>
      {sentences.length
        ? <ul className="gc-funnel__rules">{sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
        : <p className="gc-funnel__none">Nothing of its own yet: it passes on everything above.</p>}
      {match && match.matched === 0 && (
        <Alert tone="warning" title="No seller matches this policy">
          With {above ? `${above} and ` : ''}these settings, none of the {match.total} sellers this gateway sees can serve a request. Requests will fail until you loosen it.
        </Alert>
      )}
    </section>
  )
}

/** One labelled group of settings: the label and a line of help on the left, the controls on the right. */
function Group({ title, help, children }: { title: string; help: ReactNode; children: ReactNode }) {
  return (
    <section className="gc-policy__group">
      <div className="gc-policy__group-head">
        <h3>{title}</h3>
        <p className="gc-fineprint">{help}</p>
      </div>
      <div className="gc-policy__group-body">{children}</div>
    </section>
  )
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
  const buyer = buyerPolicy(useBuyerLimits().data)
  // What this level narrows: the buyer's own config, then the gateway levels above it.
  const above = useMemo(() => (buyer || parent ? combinePolicies(buyer, parent) : null), [buyer, parent])
  const aboveLabel = buyer && parent ? 'the buyer config and the levels above' : buyer ? 'the buyer config' : parent ? 'the levels above' : ''
  const floorSource = (key: 'minTrustScore' | 'minReputation') =>
    buyer?.[key] !== undefined && buyer[key] === above?.[key] ? 'The buyer config' : 'The levels above'
  // The buyer's floor is changed in Settings → Buyer, by whoever may open Settings.
  const { viewer } = useConsole()
  const changeBuyerFloor = canOpen('settings', viewer)
    ? <a className="gc-link" href={href('settings?tab=buyer')} onClick={linkHandler('settings?tab=buyer')}>Change</a>
    : null
  const floorAction = (key: 'minTrustScore' | 'minReputation') => (floorSource(key) === 'The buyer config' ? changeBuyerFloor : null)

  function applyTemplate(id: TemplateId, listId = ownListId) {
    let template: Partial<PolicyDraft>
    if (id === 'own') {
      const list = lists.find((entry) => entry.id === listId)
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

  const capField = (key: 'maxInputUsdPerMillion' | 'maxOutputUsdPerMillion' | 'maxCachedInputUsdPerMillion' | 'maxImageUsdPerImage', label: string) => (
    <TextField size="sm" className="gc-num" label={label} inputMode="decimal" value={value[key]}
      placeholder={above?.[key] !== undefined ? `≤ ${formatPricePerMillion(above[key]!)} above` : 'No cap'}
      onChange={(event) => set(key, event.target.value)} />
  )

  const templateValue = ''
  const pickTemplate = (choice: string) => {
    if (choice === 'clear') return onChange(emptyDraft())
    if (choice.startsWith('list:')) { setOwnListId(choice.slice(5)); return applyTemplate('own', choice.slice(5)) }
    if (choice) applyTemplate(choice as TemplateId)
  }

  // Inline JSX, not nested components, so inputs keep focus across renders.
  const content = (
    <>
      <div className="gc-policy__top">
        <DraftSummary draft={value} parent={above} above={aboveLabel} peers={peers} lists={lists} />
        {showTemplates && !disabled && (
          <SelectField size="sm" aria-label="Start from a template" value={templateValue} onChange={pickTemplate}
            options={[
              { value: '', label: 'Start from…' },
              ...POLICY_TEMPLATES.filter((template) => template.id !== 'own').map((template) => ({ value: template.id, label: `${template.label}: ${template.description}` })),
              ...lists.map((list) => ({ value: `list:${list.id}`, label: `Only the “${list.name}” list (${list.peerIds.length})` })),
              { value: 'clear', label: 'Clear every setting' },
            ]} />
        )}
      </div>

      <Group title="Sellers" help={<>Who may serve requests. Blocked sellers never serve. <SellerListsButton peers={peers} /></>}>
        <Segmented label="Which sellers may serve" value={value.allowMode} onChange={(mode) => set('allowMode', mode)}
          options={[{ value: 'any', label: 'Any seller' }, { value: 'only', label: 'Only these' }]} />
        {value.allowMode === 'only' && (
          <>
            <ListPicker label="Seller lists" lists={lists} value={value.allowedListIds} onChange={(next) => set('allowedListIds', next)} peers={peers} />
            <PeerPicker label={lists.length ? 'And these sellers' : 'Allowed sellers'} value={value.allowedPeerIds} onChange={(next) => set('allowedPeerIds', next)} peers={peers} />
            {value.allowedPeerIds.length === 0 && value.allowedListIds.length === 0 && (
              <p className="gc-warn">An empty allow list means no seller can serve.</p>
            )}
          </>
        )}
        <PeerPicker label="Never use" value={value.blockedPeerIds} onChange={(next) => set('blockedPeerIds', next)} peers={peers} />
        <ListPicker label="Never use these lists" lists={lists} value={value.blockedListIds} onChange={(next) => set('blockedListIds', next)} peers={peers} />
      </Group>

      <Group title="Quality" help="How trusted a seller must be, and what it must run, to serve.">
        <Slider label="Minimum trust score" info={<TrustTip />} value={value.minTrustScore} onChange={(next) => set('minTrustScore', next)}
          floor={above?.minTrustScore} floorSource={floorSource('minTrustScore')} floorAction={floorAction('minTrustScore')} />
        {value.minReputation !== '' && (
          <p className="gc-fineprint">
            This policy also asks for reputation {value.minReputation} or more, an older score the trust score replaces.{' '}
            <Button variant="link" size="sm" onClick={() => set('minReputation', '')}>Remove it</Button>
          </p>
        )}
        <div className="gc-policy__switches">
          <Switch checked={value.requireTee || !!above?.requireTee} disabled={!!above?.requireTee}
            onChange={(next) => set('requireTee', next)} label="TEE sellers only" />
          <Switch checked={value.requireVerified || !!above?.requireVerified} disabled={!!above?.requireVerified}
            onChange={(next) => set('requireVerified', next)} label="Verified sellers only" />
        </div>
        {(above?.requireTee || above?.requireVerified) && (
          <span className="as-field__hint">
            {above.requireTee && above.requireVerified ? 'TEE and verified sellers are' : above.requireTee ? 'TEE sellers are' : 'Verified sellers are'} already required above.
          </span>
        )}
      </Group>

      <Group title="Price limits" help="Sellers asking more are skipped. Leave a field empty for no limit.">
        <div className="gc-policy__caps">
          {capField('maxInputUsdPerMillion', 'Input $/M')}
          {capField('maxOutputUsdPerMillion', 'Output $/M')}
          {capField('maxCachedInputUsdPerMillion', 'Cached input $/M')}
          {capField('maxImageUsdPerImage', '$ per image')}
        </div>
      </Group>

      <Group title="Models" help="Requests for any other model are refused.">
        <Segmented label="Which models may be used" value={value.modelsMode} onChange={(mode) => set('modelsMode', mode)}
          options={[{ value: 'any', label: 'Any model' }, { value: 'only', label: 'Only these models' }]} />
        {value.modelsMode === 'only' && (
          <ChipsInput label="Allowed models" value={value.allowedModels} onChange={(next) => set('allowedModels', next)} suggestions={models} placeholder="Model id" />
        )}
      </Group>

      <Group title="Ranking" help="The order the allowed sellers are tried in. Inherit keeps automatic routing, which ranks by expected cost and success rate.">
        <div className="gc-policy__pair">
          <SelectField size="sm" label="Sort by" value={value.sort} onChange={(next) => set('sort', next as RoutingSort | '')}
            options={[{ value: '', label: 'Inherit' }, ...(Object.keys(SORT_LABELS) as RoutingSort[]).map((sort) => ({ value: sort, label: SORT_LABELS[sort] }))]} />
          <SelectField size="sm" label="Free sellers first" value={value.preferFreePeers} onChange={(next) => set('preferFreePeers', next as PolicyDraft['preferFreePeers'])}
            options={[{ value: 'inherit', label: 'Inherit' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
        </div>
        <Disclosure title="Fallback chains" summary={value.routes.length ? `${value.routes.length} chain${value.routes.length === 1 ? '' : 's'}` : 'None'}
          defaultOpen={value.routes.length > 0}>
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
      </Group>
      <ConfirmDialog isOpen={pending !== null} tone="primary" title={`Apply “${pending?.label ?? ''}”?`} confirmLabel="Replace and apply"
        body={<>This template changes settings you already set: <strong>{pending?.conflicts.join(', ')}</strong>. Your other settings stay.</>}
        onClose={() => setPending(null)}
        onConfirm={() => { if (pending) onChange(mergeTemplate(value, pending.template)); setPending(null) }} />
    </>
  )

  if (disabled) return <fieldset className="gc-policy gc-policy--readonly" disabled>{content}</fieldset>
  return <div className="gc-policy">{content}</div>
}

/**
 * A 0–100 score slider. Policies can clear it back to "Inherit"; the buyer's
 * own settings always hold a value (`clearable={false}`), and `hint` goes
 * under it. `floor` is the minimum already required above this level: the
 * slider cannot go under it (it says it is locked there, with `floorAction`
 * as the way to change the floor itself), and an inheriting slider sits on it.
 */
export function Slider({ label, info, value, onChange, clearable = true, hint, floor, floorSource = 'The levels above', floorAction }: {
  label: string
  /** An ⓘ tooltip next to the label (`TrustTip`). */
  info?: ReactNode
  value: string; onChange: (value: string) => void; clearable?: boolean; hint?: ReactNode
  floor?: number; floorSource?: string; floorAction?: ReactNode
}) {
  const labelId = useId()
  const enabled = value !== ''
  const hasFloor = floor !== undefined && floor > 0
  const redundant = hasFloor && enabled && Number(value) <= floor
  // A saved value under the floor has no effect: the slider shows the floor it is locked at.
  const shown = redundant ? String(floor) : enabled ? value : hasFloor ? `${floor} inherited` : 'Inherit'
  return (
    <div className="gc-slider">
      <div className="gc-slider__head">
        <span className="gc-info-label">
          <span className="as-field__label" id={labelId}>{label}</span>
          {info}
        </span>
        <span className={enabled ? 'gc-slider__value' : 'gc-slider__value gc-slider__value--inherit'}>{shown}</span>
      </div>
      <div className="gc-inline">
        <input type="range" min={0} max={100} step={5} value={enabled ? Math.max(Number(value), hasFloor ? floor : 0) : hasFloor ? floor : 0} aria-labelledby={labelId}
          onChange={(event) => onChange(String(Math.max(Number(event.target.value), hasFloor ? floor : 0)))} />
        {clearable && enabled && <Button variant="ghost" size="sm" onClick={() => onChange('')}>Clear</Button>}
      </div>
      {hasFloor && (enabled && !redundant
        ? <span className="as-field__hint">{floorSource} requires ≥ {floor}. Only a higher value narrows it.</span>
        : (
          <span className="as-field__hint gc-override">
            <Icon.lock size={12} /> Locked at {floor} by {floorSource.replace(/^The /, 'the ')}.{floorAction ? <> {floorAction}</> : null}
          </span>
        ))}
      {hint && <span className="as-field__hint">{hint}</span>}
    </div>
  )
}

/** Seller lists to tick; a list's name opens it, to edit or see its sellers. */
function ListPicker({ label, lists, value, onChange, peers }: {
  label: string; lists: readonly PeerList[]; value: string[]; onChange: (value: string[]) => void; peers?: readonly Peer[]
}) {
  if (lists.length === 0) return null
  return (
    <fieldset className="gc-checks">
      <legend className="as-field__label">{label}</legend>
      {lists.map((list) => (
        <span key={list.id} className="gc-check">
          <input type="checkbox" aria-label={`${label}: ${list.name}`} checked={value.includes(list.id)}
            onChange={(event) => onChange(event.target.checked ? [...value, list.id] : value.filter((id) => id !== list.id))} />
          <SellerListLink list={list} peers={peers} /> <span className="gc-muted">({list.peerIds.length})</span>
        </span>
      ))}
    </fieldset>
  )
}
