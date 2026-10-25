import { useState } from 'react'
import { Button } from '@antseed/ui'
import type { NetworkModel, NetworkModelOffer, PeerTeeScope, RoutePreview } from '../api/types'
import { formatPriceRange, formatTokens, shortId } from '../lib/format'
import { CAPABILITY_LABELS, MODEL_TYPE_LABELS, priceSummary } from '../lib/models'
import { panelPath } from '../lib/nav'
import { modelCallFormat, pinnedModelId } from '../lib/snippets'
import { ApiCall } from './ApiCall'
import { previewListsSellers } from '../lib/selection'
import { SellerSelection, type SellerRowExtras } from './SellerSelection'
import { PanelRow, PanelSection } from './SidePanel'
import { FreeTierInfo } from './FreeTierInfo'
import { TeeBadge } from './TeeBadge'
import { Badge, CopyButton, DetailList, Mono, PageLink, SelectField } from './ui'
import { VerificationLinks } from './VerificationLinks'

export function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

export function context(value: number | null): string {
  return value === null ? '—' : formatTokens(value)
}

/** The best TEE any seller of the model has verified. */
export function modelTeeScope(model: NetworkModel): PeerTeeScope | null {
  if (model.fullTeeSellers > 0) return 'end-to-end'
  return model.offers.some((offer) => offer.teeScope === 'seller-node') ? 'seller-node' : null
}

function offerName(offer: NetworkModelOffer): string {
  return offer.displayName ?? shortId(offer.peerId, 8, 4)
}

/** `''` routes automatically; otherwise the `<peerId>:<serviceId>` of the pinned offer. */
type Route = string

function offerKey(offer: NetworkModelOffer): string {
  return `${offer.peerId}:${offer.serviceId}`
}

/**
 * One model: what it is, who offers it, how automatic routing picks among
 * them, and how to call it. On the Models page Pin picks the provider for the
 * API call; in the chat (`pin`) it pins the chat's seller as well.
 */
export function ModelDetails({ model, preview, previewLoading, pin }: {
  model: NetworkModel
  preview: RoutePreview | undefined
  previewLoading: boolean
  pin?: { peerId: string | null; onChange: (peerId: string | null) => void }
}) {
  const [localRoute, setLocalRoute] = useState<Route>('')
  const pinnedOffer = pin
    ? model.offers.find((offer) => offer.peerId.toLowerCase() === pin.peerId) ?? null
    : model.offers.find((offer) => offerKey(offer) === localRoute) ?? null
  const route = pinnedOffer ? offerKey(pinnedOffer) : ''
  const setRoute = (next: Route) => {
    if (!pin) return setLocalRoute(next)
    const offer = model.offers.find((entry) => offerKey(entry) === next)
    pin.onChange(offer ? offer.peerId.toLowerCase() : null)
  }
  const callModel = pinnedOffer ? pinnedModelId(pinnedOffer.peerId, pinnedOffer.serviceId) : model.id
  const format = modelCallFormat(model.type, pinnedOffer)
  const perImage = model.offers.some((offer) => offer.usdPerImage !== null)
  const offersOf = (peerId: string) => model.offers.filter((offer) => offer.peerId.toLowerCase() === peerId.toLowerCase())
  const latencyOf = (peerId: string) => offersOf(peerId)[0]?.firstTokenMsP50 ?? null
  /** An offer's price, trust and identity, with copy and Pin, for its seller's row. */
  const offerExtras = (offers: NetworkModelOffer[]): SellerRowExtras => {
    const offer = offers[0]
    if (!offer) return {}
    return {
      selected: offers.some((entry) => route === offerKey(entry)),
      meta: <>
        {offer.free && offer.freeTier ? <FreeTierInfo program={offer.freeTier} agentId={offer.agentId} /> : <span>{priceSummary(offer)}</span>}
        {!offer.free && offer.freeTier && <FreeTierInfo program={offer.freeTier} agentId={offer.agentId} priced />}
        <span>Trust {score(offer.trustScore)}</span>
        {offers.map((entry) => entry.serviceId !== model.id && <Mono key={entry.serviceId}>{entry.serviceId}</Mono>)}
      </>,
      badges: (offer.verificationLinks?.length || offer.tee || offer.free || offer.freeTier) ? <>
        <VerificationLinks links={offer.verificationLinks} />
        <TeeBadge tee={offer.tee} scope={offer.teeScope} />
        {offer.freeTier?.base.stakersOnly
          ? <Badge tone="success">Free for stakers</Badge>
          : (offer.free || offer.freeTier) && <Badge tone="success">{offer.free ? 'Free' : 'Free allowance'}</Badge>}
      </> : undefined,
      actions: <>{offers.map((entry) => {
        const on = route === offerKey(entry)
        return <span key={entry.serviceId} className="gc-inline">
          <CopyButton iconOnly value={pinnedModelId(entry.peerId, entry.serviceId)} label={`Copy ${offerName(entry)}'s model id (peer@model)`} />
          <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on}
            title={pin ? 'Send this chat to this provider' : 'Use this provider in the API call below'}
            onClick={() => setRoute(on ? '' : offerKey(entry))}>{on ? 'Pinned' : 'Pin'}</Button>
        </span>
      })}</>,
    }
  }
  const offerRow = (peerId: string) => offerExtras(offersOf(peerId))

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

      {previewListsSellers(preview) || previewLoading
        ? <SellerSelection preview={preview} loading={previewLoading} row={offerRow} latencyOf={latencyOf} pin={pin} />
        : (
          <PanelSection title={`Providers (${model.offers.length})`}>
            {preview && !preview.modelAllowed && <p className="gc-fineprint">Your routing policy does not allow this model: requests for it are refused.</p>}
            {model.offers.length === 0 ? <p className="gc-fineprint">No provider offers this model right now.</p> : (
              <ul className="gc-panel-rows" aria-label="Providers offering this model">
                {model.offers.map((offer) => {
                  const extras = offerExtras([offer])
                  return <PanelRow key={offerKey(offer)} selected={extras.selected}
                    title={<PageLink to={panelPath('providers', offer.peerId)}>{offerName(offer)}</PageLink>}
                    meta={extras.meta} badges={extras.badges} actions={extras.actions} />
                })}
              </ul>
            )}
          </PanelSection>
        )}

      <PanelSection title="API call"
        actions={model.offers.length > 0 && (
          <SelectField size="sm" aria-label="Route the call" value={route} onChange={setRoute}
            options={[{ value: '', label: 'Best provider (automatic)' }, ...model.offers.map((offer) => ({ value: offerKey(offer), label: offerName(offer) }))]} />
        )}>
        <p className="gc-fineprint">
          {pinnedOffer
            ? <>Pinned to {offerName(pinnedOffer)} with <code>{shortId(callModel, 10, 12)}</code>.</>
            : <>The gateway picks the best provider for <code>{model.id}</code> under your routing policy.</>}
        </p>
        <ApiCall id="gc-model-call" model={callModel} format={format}
          unsupported={`${MODEL_TYPE_LABELS[model.type]} models are not served through the gateway's /v1 API.`} />
      </PanelSection>
    </>
  )
}
