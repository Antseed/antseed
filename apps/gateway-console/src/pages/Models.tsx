import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BrandIcon, Button, DataTable, IconButton, TextField, modelFamilyLabel } from '@antseed/ui'
import type { NetworkModel, NetworkModelOffer, NetworkRouter, PeerTeeScope } from '../api/types'
import { ApiCall } from '../components/ApiCall'
import { CopyIdButton, useCopy } from '../components/copy-actions'
import { FilterMenu, type FilterOption } from '../components/FilterMenu'
import { Icon } from '../components/icons'
import { TeeBadge } from '../components/TeeBadge'
import { VerificationLinks } from '../components/VerificationLinks'
import { PanelRow, PanelSection, SplitView, type SidePanelContent } from '../components/SidePanel'
import { Badge, CodeBlock, CopyButton, DetailList, EmptyState, LoadingRows, Mono, PageHeader, PageLink, Panel, QueryView, SelectField } from '../components/ui'
import {
  CATALOG_TYPE_LABELS, catalogEntries, catalogFacets, EMPTY_CATALOG_FILTER, entryBrand, entryInputPrice, entryName, entrySellers, entryType,
  favoriteEntries, filterActive, filterCatalog, type CatalogEntry, type CatalogFilter, type CatalogType,
} from '../lib/catalog'
import { formatLatency, formatNumber, formatPriceRange, formatSpeed, formatTokens, formatUsd, shortId } from '../lib/format'
import { CAPABILITY_LABELS, findModel, MODEL_TYPE_LABELS, priceSummary } from '../lib/models'
import { panelPath, panelSelection } from '../lib/nav'
import { useFavorites, useModels, useRouters, useToggleFavorite } from '../lib/queries'
import { navigate, useLocation } from '../lib/router'
import { modelCallFormat, pinnedModelId } from '../lib/snippets'
import { loadStored, saveStored } from '../lib/stored'

const FILTER_KEY = 'antseed-console-models:filter'
/** Shown at the top while nothing is filtered, like the desktop's Favorites frame. */
const FAVORITES_LABEL = 'Favorites'

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

function offerName(offer: NetworkModelOffer): string {
  return offer.displayName ?? shortId(offer.peerId, 8, 4)
}

function routerSeller(router: NetworkRouter): string {
  return router.sellerName ?? shortId(router.peerId, 8, 4)
}

function routerPrice(router: NetworkRouter): string {
  if (router.priceUsdPerRequest === null) return 'No price advertised'
  return router.free ? 'Free' : `${formatUsd(router.priceUsdPerRequest)} per ranking`
}

/** A stored filter from an older page version may lack fields: fill them in. */
function loadFilter(): CatalogFilter {
  const stored = loadStored<Partial<CatalogFilter>>(FILTER_KEY, {})
  return { ...EMPTY_CATALOG_FILTER, ...stored, search: '' }
}

function EntryMark({ entry }: { entry: CatalogEntry }) {
  const brand = entryBrand(entry)
  return (
    <span className="gc-model-name__mark" aria-hidden="true">
      {brand ? <BrandIcon name={brand.provider} hints={[brand.label]} size={18} /> : <Icon.routing size={16} />}
    </span>
  )
}

function EntryBadges({ entry }: { entry: CatalogEntry }) {
  if (entry.kind === 'router') {
    return <div className="gc-badges"><Badge>Router</Badge>{entry.router.free && <Badge tone="success">Free</Badge>}</div>
  }
  const { model } = entry
  return (
    <div className="gc-badges">
      {model.free && <Badge tone="success">Free</Badge>}
      <TeeBadge tee={model.teeSellers > 0} scope={modelTeeScope(model)} />
      {model.tags.slice(0, 3).map((tag) => <Badge key={tag}>{tag}</Badge>)}
    </div>
  )
}

function StarButton({ id, name, starred, onToggle }: { id: string; name: string; starred: boolean; onToggle: (id: string, favorite: boolean) => void }) {
  return (
    <IconButton size="sm" className="gc-star" label={starred ? `Unstar ${name}` : `Star ${name}`} aria-pressed={starred}
      onClick={(event) => { event.stopPropagation(); onToggle(id, !starred) }}>
      {starred ? <Icon.starFilled size={15} /> : <Icon.star size={15} />}
    </IconButton>
  )
}

/**
 * The network's models and routing services (`/console/models`): search,
 * filter by type, tag, family, price and TEE, and star the ones you use.
 * Opening one (`models/<id>`) shows its providers, or a router's settings,
 * and a ready-to-run API call in the side panel.
 */
export default function Models() {
  const location = useLocation()
  const selectedId = panelSelection(location.rest)
  const models = useModels()
  const routers = useRouters()
  const favorites = useFavorites()
  const toggleFavorite = useToggleFavorite()
  const [filter, setFilter] = useState<CatalogFilter>(loadFilter)
  const copy = useCopy()
  useEffect(() => { saveStored(FILTER_KEY, { ...filter, search: '' }) }, [filter])
  const set = <K extends keyof CatalogFilter>(key: K, value: CatalogFilter[K]) => setFilter((current) => ({ ...current, [key]: value }))

  const entries = useMemo(() => catalogEntries(models.data ?? [], routers.data ?? []), [models.data, routers.data])
  const facets = useMemo(() => catalogFacets(entries, modelFamilyLabel), [entries])
  const starred = useMemo(() => new Set((favorites.data ?? []).map((id) => id.toLowerCase())), [favorites.data])
  const isStarred = (entry: CatalogEntry) => starred.has(entry.key.toLowerCase())
  const onToggle = (id: string, favorite: boolean) => toggleFavorite.mutate({ id, favorite })

  const selectedRouter = selectedId ? (routers.data ?? []).find((router) => router.id.toLowerCase() === selectedId.toLowerCase()) ?? null : null
  const selectedModel = selectedId && !selectedRouter ? findModel(models.data, selectedId) : null
  const selectedKey = selectedRouter?.id ?? selectedModel?.id ?? null

  const panel: SidePanelContent | null = selectedId === null ? null : {
    eyebrow: selectedRouter ? 'Router' : 'Model',
    title: selectedRouter?.name ?? selectedModel?.name ?? selectedId,
    actions: selectedKey
      ? <StarButton id={selectedKey} name={selectedRouter?.name ?? selectedModel?.name ?? selectedKey} starred={starred.has(selectedKey.toLowerCase())} onToggle={onToggle} />
      : undefined,
    body: models.isLoading || routers.isLoading ? <LoadingRows rows={6} />
      : selectedRouter ? <RouterPanelBody key={selectedRouter.id} router={selectedRouter} />
      : selectedModel ? <ModelPanelBody key={selectedModel.id} model={selectedModel} />
      : <EmptyState icon={<Icon.models size={18} />} title="Model not found" body={`No provider on the network offers ${selectedId} right now.`} />,
  }

  const active = filterActive(filter)
  const filtered = filterCatalog(entries, filter, modelFamilyLabel)
  // Unfiltered, starred entries lead in their own table, in the order they were starred.
  const starredEntries = active ? [] : favoriteEntries(entries, favorites.data ?? [])
  const rest = starredEntries.length ? filtered.filter((entry) => !starredEntries.includes(entry)) : filtered

  const typeOptions: Array<FilterOption<string>> = [
    ...facets.types.map((type) => ({ value: `type:${type}`, label: CATALOG_TYPE_LABELS[type], section: 'Type' })),
    { value: 'free', label: 'Free', section: 'Price and privacy' },
    { value: 'tee', label: 'TEE', section: 'Price and privacy' },
    ...facets.tags.map((tag) => ({ value: `tag:${tag}`, label: tag, section: 'Tags' })),
  ]
  const typeValues = [
    ...filter.types.map((type) => `type:${type}`), ...(filter.free ? ['free'] : []), ...(filter.tee ? ['tee'] : []), ...filter.tags.map((tag) => `tag:${tag}`),
  ]
  const setTypeValues = (values: string[]) => setFilter((current) => ({
    ...current,
    types: values.filter((value) => value.startsWith('type:')).map((value) => value.slice(5) as CatalogType),
    tags: values.filter((value) => value.startsWith('tag:')).map((value) => value.slice(4)),
    free: values.includes('free'),
    tee: values.includes('tee'),
  }))
  const familyOptions: Array<FilterOption<string>> = facets.families.map((family) => ({
    value: family, label: family, icon: <BrandIcon name={family} hints={[family]} size={16} />,
  }))

  const table = (label: string, rows: CatalogEntry[], empty: ReactNode) => (
    <DataTable<CatalogEntry> label={label} rows={rows} rowKey={(entry) => entry.key}
      selectedKey={selectedKey}
      onRowClick={(entry) => navigate(panelPath('models', entry.key))}
      rowLabel={entryName}
      actions={(entry) => [
        { label: entry.kind === 'router' ? 'Copy router model id' : 'Copy model id', onSelect: () => void copy(entry.key) },
        { label: isStarred(entry) ? 'Unstar' : 'Star', onSelect: () => onToggle(entry.key, !isStarred(entry)) },
      ]}
      initialSort={label === FAVORITES_LABEL ? undefined : { key: 'sellers', direction: 'desc' }}
      empty={empty}
      columns={[
        { key: 'model', header: 'Model', sortValue: (entry) => entryName(entry).toLowerCase(), render: (entry) => (
          <div className="gc-model-name">
            <EntryMark entry={entry} />
            <div className="gc-cell-lines">
              <div className="gc-strong gc-ellipsis" title={entry.key}>{entryName(entry)}</div>
              {entry.kind === 'router'
                ? <div className="gc-muted gc-ellipsis">by {routerSeller(entry.router)} · <Mono>{entry.router.serviceId}</Mono></div>
                : entry.model.name !== entry.model.id && <div className="gc-muted gc-ellipsis"><Mono>{entry.model.id}</Mono></div>}
              <EntryBadges entry={entry} />
            </div>
          </div>
        ), after: (entry) => (
          <>
            <StarButton id={entry.key} name={entryName(entry)} starred={isStarred(entry)} onToggle={onToggle} />
            <CopyIdButton value={entry.key} label={`Copy model id ${entry.key}`} />
          </>
        ) },
        { key: 'type', header: 'Type', secondary: true, sortValue: entryType, render: (entry) => <span className="gc-muted">{CATALOG_TYPE_LABELS[entryType(entry)]}</span> },
        { key: 'sellers', header: 'Providers', align: 'right', sortValue: entrySellers, render: (entry) => formatNumber(entrySellers(entry)) },
        { key: 'input', header: 'Input $/M', align: 'right', sortValue: entryInputPrice, render: (entry) => entry.kind === 'router'
          ? <span className="gc-muted">{entry.router.free ? 'Free' : entry.router.priceUsdPerRequest === null ? '—' : `${formatUsd(entry.router.priceUsdPerRequest)}/ranking`}</span>
          : formatPriceRange(entry.model.inputUsdPerMillion) },
        { key: 'output', header: 'Output $/M', align: 'right', secondary: true, sortValue: (entry) => entry.kind === 'model' ? entry.model.outputUsdPerMillion?.min ?? null : null,
          render: (entry) => entry.kind === 'model' ? formatPriceRange(entry.model.outputUsdPerMillion) : '—' },
        { key: 'context', header: 'Context', align: 'right', secondary: true, optional: true, sortValue: (entry) => entry.kind === 'model' ? entry.model.contextLength : null,
          render: (entry) => entry.kind === 'model' ? context(entry.model.contextLength) : '—' },
      ]} />
  )

  const list = (
    <div className="gc-stack">
      {starredEntries.length > 0 && (
        <Panel flush title={FAVORITES_LABEL}>
          {table(FAVORITES_LABEL, starredEntries, null)}
        </Panel>
      )}
      <Panel flush title={starredEntries.length > 0 ? 'All models' : undefined}>
        <QueryView query={models} rows={8}>
          {() => table('Models', rest, (
            <EmptyState icon={<Icon.models size={18} />} title={entries.length ? 'No models match these filters' : 'No models found yet'}
              body={entries.length ? undefined : 'The buyer is still discovering the network. Check back in a minute.'}
              action={active ? <Button variant="outline" size="sm" onClick={() => setFilter(EMPTY_CATALOG_FILTER)}>Clear filters</Button> : undefined} />
          ))}
        </QueryView>
      </Panel>
    </div>
  )

  return (
    <div className="gc-page">
      <PageHeader title="Models" description="Every model and router on the network. Star the ones you use; open one to see its providers, copy its id and get a ready-to-run API call." />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search models or routers" placeholder="Search models or routers" value={filter.search}
          onChange={(event) => set('search', event.target.value)} />
        <FilterMenu label="Type" values={typeValues} options={typeOptions} onChange={setTypeValues} />
        {familyOptions.length > 0 && <FilterMenu label="Family" values={filter.families} options={familyOptions} onChange={(values) => set('families', values)} />}
        {active && <Button variant="ghost" size="sm" onClick={() => setFilter(EMPTY_CATALOG_FILTER)}>Clear filters</Button>}
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
          ['Tags', model.tags.length ? <span className="gc-badges">{model.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</span> : '—'],
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
                    {offer.firstTokenMsP50 !== null && <span>{formatLatency(offer.firstTokenMsP50)} first token</span>}
                    {offer.tokensPerSecondP50 !== null && <span>{formatSpeed(offer.tokensPerSecondP50)}</span>}
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

/** The routing setting most routers expose, shown with a default the request can override. */
function optionDefault(option: NetworkRouter['options'][number]): string {
  if (option.default === undefined) return '—'
  return String(option.default)
}

/** The side panel for one router: who offers it, what it costs and accepts, and how to call it. */
function RouterPanelBody({ router }: { router: NetworkRouter }) {
  const anyModel = router.models?.includes('*') ?? false
  const ranked = (router.models ?? []).filter((model) => model !== '*')
  const example = router.options.some((option) => option.key === 'cost_quality_tradeoff')
    ? JSON.stringify({ model: router.id, routing: { cost_quality_tradeoff: 3 }, messages: [{ role: 'user', content: 'Hello' }] }, null, 2)
    : null
  return (
    <>
      <div className="gc-stack gc-stack--tight">
        <span className="gc-seller__meta">
          <span className="gc-peer-id"><Mono title={router.id}>{shortId(router.id, 10, 16)}</Mono><CopyButton iconOnly value={router.id} label="Copy router model id" /></span>
          <Badge>Router</Badge>
          {router.free && <Badge tone="success">Free</Badge>}
        </span>
        <p className="gc-fineprint">
          Send <code>{router.id}</code> as the model: the router ranks the models your key&apos;s routing policy allows and the gateway sends the request to its pick,
          falling back to the next one if a seller refuses. Logs show the router and the model it picked.
        </p>
        <DetailList items={[
          ['Offered by', <PageLink key="s" to={panelPath('providers', router.peerId)}>{routerSeller(router)}</PageLink>],
          ['Service', <Mono key="v">{router.serviceId}</Mono>],
          ['Protocol', <Mono key="p">{router.protocol || '—'}</Mono>],
          ['Price', routerPrice(router)],
          ['Trust', score(router.trustScore)],
          ...(router.verificationLinks.length ? [['Verified', <VerificationLinks key="l" links={router.verificationLinks} />] as [string, ReactNode]] : []),
        ]} />
      </div>

      {router.options.length > 0 && (
        <PanelSection title="Settings">
          <DetailList items={router.options.map((option) => [
            option.label,
            <div key={option.key} className="gc-stack gc-stack--tight">
              <span><Mono>{option.key}</Mono> · default {optionDefault(option)}{'minimum' in option && option.minimum !== undefined && 'maximum' in option && option.maximum !== undefined ? ` · ${option.minimum}–${option.maximum}` : ''}</span>
              {option.description && <span className="gc-muted">{option.description}</span>}
            </div>,
          ] as [string, ReactNode])} />
          {example && (
            <>
              <p className="gc-fineprint">Set them per request in a <code>routing</code> object; they never reach the seller.</p>
              <CodeBlock code={example} label="Request body" />
            </>
          )}
        </PanelSection>
      )}

      <PanelSection title="Models it ranks">
        {router.models === null ? <p className="gc-fineprint">This router did not list its models.</p>
          : anyModel ? <p className="gc-fineprint">Any model: it ranks every model your key allows.</p>
          : ranked.length === 0 ? <p className="gc-fineprint">None listed.</p>
          : <span className="gc-badges">{ranked.map((model) => <Badge key={model}>{model}</Badge>)}</span>}
      </PanelSection>

      <PanelSection title="API call">
        <ApiCall id="gc-router-call" model={router.id} format="openai-chat-completions" />
      </PanelSection>
    </>
  )
}
