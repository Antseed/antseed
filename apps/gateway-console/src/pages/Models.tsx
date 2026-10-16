import { useMemo, useState } from 'react'
import { Button, DataTable, TextField } from '@antseed/ui'
import type { NetworkModel, NetworkModelOffer, PeerTeeScope } from '../api/types'
import { ApiCall } from '../components/ApiCall'
import { CopyIdButton, useCopy } from '../components/copy-actions'
import { Icon } from '../components/icons'
import { TeeBadge } from '../components/TeeBadge'
import { VerificationLinks } from '../components/VerificationLinks'
import { PanelRow, PanelSection, SplitView, type SidePanelContent } from '../components/SidePanel'
import { Badge, CopyButton, DetailList, EmptyState, LoadingRows, Mono, PageHeader, PageLink, Panel, QueryView, SelectField, Switch } from '../components/ui'
import { formatLatency, formatNumber, formatPriceRange, formatTokens, shortId } from '../lib/format'
import { CAPABILITY_LABELS, filterModels, findModel, MODEL_TYPE_LABELS, modelTypes, priceSummary, type ModelFilter } from '../lib/models'
import { panelPath, panelSelection } from '../lib/nav'
import { useModels } from '../lib/queries'
import { navigate, useLocation } from '../lib/router'
import { modelCallFormat, pinnedModelId } from '../lib/snippets'

function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

function context(value: number | null): string {
  return value === null ? '—' : formatTokens(value)
}

/** The best TEE any seller of the model has verified. */
function modelTeeScope(model: NetworkModel): PeerTeeScope | null {
  if (model.fullTeeSellers > 0) return 'end-to-end'
  return model.offers.some((offer) => offer.teeScope === 'seller-node') ? 'seller-node' : null
}

function ModelBadges({ model }: { model: NetworkModel }) {
  return (
    <div className="gc-badges">
      {model.free && <Badge tone="success">Free</Badge>}
      <TeeBadge tee={model.teeSellers > 0} scope={modelTeeScope(model)} />
    </div>
  )
}

function offerName(offer: NetworkModelOffer): string {
  return offer.displayName ?? shortId(offer.peerId, 8, 4)
}

/**
 * The network's models (`/console/models`). Opening one (`models/<id>`)
 * shows its providers and a ready-to-run API call in the side panel.
 */
export default function Models() {
  const location = useLocation()
  const selectedId = panelSelection(location.rest)
  const models = useModels()
  const [filter, setFilter] = useState<ModelFilter>({ search: '', type: '', free: false })
  const types = useMemo(() => modelTypes(models.data), [models.data])
  const selected = useMemo(() => (selectedId ? findModel(models.data, selectedId) : null), [models.data, selectedId])
  const copy = useCopy()
  const set = <K extends keyof ModelFilter>(key: K, value: ModelFilter[K]) => setFilter((current) => ({ ...current, [key]: value }))

  const panel: SidePanelContent | null = selectedId === null ? null : {
    eyebrow: 'Model',
    title: selected?.name ?? selectedId,
    body: models.isLoading ? <LoadingRows rows={6} />
      : selected ? <ModelPanelBody key={selected.id} model={selected} />
      : <EmptyState icon={<Icon.models size={18} />} title="Model not found" body={`No provider on the network offers ${selectedId} right now.`} />,
  }

  const list = (
    <Panel flush>
      <QueryView query={models} rows={8}>
        {(all) => (
          <DataTable<NetworkModel> label="Models" rows={filterModels(all, filter)} rowKey={(model) => model.id}
            selectedKey={selected?.id ?? null}
            onRowClick={(model) => navigate(panelPath('models', model.id))}
            rowLabel={(model) => model.name}
            actions={(model) => [{ label: 'Copy model id', onSelect: () => void copy(model.id) }]}
            initialSort={{ key: 'sellers', direction: 'desc' }}
            empty={<EmptyState icon={<Icon.models size={18} />} title={all.length ? 'No models match these filters' : 'No models found yet'} body={all.length ? undefined : 'The buyer is still discovering the network. Check back in a minute.'} />}
            columns={[
              { key: 'model', header: 'Model', sortValue: (model) => model.name.toLowerCase(), render: (model) => (
                <div className="gc-cell-lines">
                  <div className="gc-strong gc-ellipsis" title={model.id}>{model.name}</div>
                  {model.name !== model.id && <div className="gc-muted gc-ellipsis"><Mono>{model.id}</Mono></div>}
                  <ModelBadges model={model} />
                </div>
              ), after: (model) => <CopyIdButton value={model.id} label={`Copy model id ${model.id}`} /> },
              { key: 'type', header: 'Type', secondary: true, sortValue: (model) => model.type, render: (model) => <span className="gc-muted">{MODEL_TYPE_LABELS[model.type]}</span> },
              { key: 'sellers', header: 'Providers', align: 'right', sortValue: (model) => model.sellers, render: (model) => formatNumber(model.sellers) },
              { key: 'input', header: 'Input $/M', align: 'right', sortValue: (model) => model.inputUsdPerMillion?.min ?? null, render: (model) => formatPriceRange(model.inputUsdPerMillion) },
              { key: 'output', header: 'Output $/M', align: 'right', secondary: true, sortValue: (model) => model.outputUsdPerMillion?.min ?? null, render: (model) => formatPriceRange(model.outputUsdPerMillion) },
              { key: 'context', header: 'Context', align: 'right', secondary: true, optional: true, sortValue: (model) => model.contextLength, render: (model) => context(model.contextLength) },
            ]} />
        )}
      </QueryView>
    </Panel>
  )

  return (
    <div className="gc-page">
      <PageHeader title="Models" description="Every model on the network. Open one to see its providers, copy a model id and get a ready-to-run API call." />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search models" placeholder="Search model or alias" value={filter.search} onChange={(event) => set('search', event.target.value)} />
        {types.length > 1 && (
          <SelectField size="sm" aria-label="Filter by type" value={filter.type} onChange={(value) => set('type', value as ModelFilter['type'])}
            options={[{ value: '', label: 'All types' }, ...types.map((type) => ({ value: type, label: MODEL_TYPE_LABELS[type] }))]} />
        )}
        <Switch checked={filter.free} onChange={(value) => set('free', value)} label="Free" />
      </div>
      <SplitView list={list} panel={panel} onClose={() => navigate('models')} closeLabel="Close model" />
    </div>
  )
}

/** `''` routes automatically; otherwise the `<peerId>:<serviceId>` of the pinned offer. */
type Route = string

function offerKey(offer: NetworkModelOffer): string {
  return `${offer.peerId}:${offer.serviceId}`
}

/** The side panel for one model: what it is, who offers it, and how to call it. */
function ModelPanelBody({ model }: { model: NetworkModel }) {
  const [route, setRoute] = useState<Route>('')
  const pinned = model.offers.find((offer) => offerKey(offer) === route) ?? null
  const callModel = pinned ? pinnedModelId(pinned.peerId, pinned.serviceId) : model.id
  const format = modelCallFormat(model.type, pinned)
  const perImage = model.offers.some((offer) => offer.usdPerImage !== null)

  return (
    <>
      <div className="gc-stack gc-stack--tight">
        <span className="gc-seller__meta">
          <span className="gc-peer-id"><Mono title={model.id}>{model.id}</Mono><CopyButton iconOnly value={model.id} label="Copy model id" /></span>
          <Badge>{MODEL_TYPE_LABELS[model.type]}</Badge>
          {model.free && <Badge tone="success">Free</Badge>}
          <TeeBadge tee={model.teeSellers > 0} scope={modelTeeScope(model)} />
        </span>
        <DetailList items={[
          ['Context', context(model.contextLength)],
          ['Capabilities', model.capabilities.length
            ? <span className="gc-badges">{model.capabilities.map((capability) => <Badge key={capability}>{CAPABILITY_LABELS[capability]}</Badge>)}</span>
            : '—'],
          ['Aliases', model.aliases.length ? <Mono>{model.aliases.join(', ')}</Mono> : '—'],
          ...(perImage ? [] : [
            ['Input $/M', formatPriceRange(model.inputUsdPerMillion)] as [string, string],
            ['Output $/M', formatPriceRange(model.outputUsdPerMillion)] as [string, string],
          ]),
        ]} />
      </div>

      <PanelSection title={`Providers (${model.offers.length})`}>
        {model.offers.length === 0 ? <p className="gc-fineprint">No provider offers this model right now.</p> : (
          <ul className="gc-panel-rows" aria-label="Providers offering this model">
            {model.offers.map((offer) => {
              const id = pinnedModelId(offer.peerId, offer.serviceId)
              const on = route === offerKey(offer)
              return (
                <PanelRow key={offerKey(offer)} selected={on}
                  title={<PageLink to={panelPath('providers', offer.peerId)}>{offerName(offer)}</PageLink>}
                  meta={<>
                    <span>{priceSummary(offer)}</span>
                    <span>Trust {score(offer.trustScore)}</span>
                    {offer.latencyMsP50 !== null && <span>{formatLatency(offer.latencyMsP50)}</span>}
                    {offer.serviceId !== model.id && <Mono>{offer.serviceId}</Mono>}
                  </>}
                  badges={(offer.verificationLinks?.length || offer.tee || offer.free) && (
                    <div className="gc-badges">
                      <VerificationLinks links={offer.verificationLinks} />
                      <TeeBadge tee={offer.tee} scope={offer.teeScope} />
                      {offer.free && <Badge tone="success">Free</Badge>}
                    </div>
                  )}
                  actions={<>
                    <CopyButton iconOnly value={id} label={`Copy ${offerName(offer)}'s model id (peer@model)`} />
                    <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on} title="Use this provider in the API call below"
                      onClick={() => setRoute(on ? '' : offerKey(offer))}>{on ? 'Pinned' : 'Pin'}</Button>
                  </>} />
              )
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="API call"
        actions={model.offers.length > 0 && (
          <SelectField size="sm" aria-label="Route the call" value={route} onChange={setRoute}
            options={[{ value: '', label: 'Best provider (automatic)' }, ...model.offers.map((offer) => ({ value: offerKey(offer), label: offerName(offer) }))]} />
        )}>
        <p className="gc-fineprint">
          {pinned
            ? <>Pinned to {offerName(pinned)} with <code>{shortId(callModel, 10, 12)}</code>.</>
            : <>The gateway picks the best provider for <code>{model.id}</code> under your routing policy.</>}
        </p>
        <ApiCall id="gc-model-call" model={callModel} format={format}
          unsupported={`${MODEL_TYPE_LABELS[model.type]} models are not served through the gateway's /v1 API.`} />
      </PanelSection>
    </>
  )
}
