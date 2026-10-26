import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, DataTable } from '@antseed/ui'
import { api } from '../api'
import type { SellerMarketOffer, SellerMarketService } from '../api/types'
import { NetworkLine, SellerPage } from '../components/SellerPage'
import { TeeBadge } from '../components/TeeBadge'
import { Badge, EmptyState, ErrorAlert, LoadingRows, Panel, StatTile } from '../components/ui'
import { formatNumber, formatPricePerMillion, shortId } from '../lib/format'
import { qk, useSellerMarket } from '../lib/queries'
import { navigate } from '../lib/router'
import '../styles/seller.scss'

const price = (value: number | null) => (value === null ? '—' : formatPricePerMillion(value))
const pair = (input: number | null, output: number | null) => `${price(input)} / ${price(output)}`

export function deltaText(deltaPct: number | null): string {
  if (deltaPct === null) return '—'
  if (Math.abs(deltaPct) < 0.5) return 'at median'
  return `${Math.abs(deltaPct).toFixed(deltaPct > -10 && deltaPct < 10 ? 1 : 0)}% ${deltaPct > 0 ? 'above' : 'below'}`
}

/** Opens Seller settings with this service's price row in view. */
function editPrice(service: string) {
  navigate(`seller-settings?price=${encodeURIComponent(service)}`)
}

/** This seller's prices against every other seller of the same model. */
export default function SellerMarket() {
  const market = useSellerMarket()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const refresh = async () => {
    queryClient.setQueryData(qk.sellerMarket, await api.seller.market(true))
  }
  return (
    <SellerPage title="Market" description={() => 'Your prices against every other seller of the same model. Prices are USD per million tokens, input / output.'}>
      {() => {
        if (market.isLoading) return <LoadingRows rows={6} />
        if (market.error) return <ErrorAlert error={market.error} onRetry={() => void market.refetch()} />
        const data = market.data!
        const services = data.services
        const open = services.find((service) => service.service === selected) ?? null
        const cheapest = services.filter((service) => service.rank === 1 && !service.unique).length
        const unique = services.filter((service) => service.unique).length
        const deltas = services.map((service) => service.deltaPct).filter((value): value is number => value !== null)
        const average = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null
        return (
          <>
            <NetworkLine network={data.network} onRefresh={refresh} />
            {!data.found && data.network.refreshedAt !== null && (
              <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />This seller was not in the last network snapshot, so its own trust, load and TEE columns are empty. Prices come from its config.</p>
            )}
            <div className="gc-grid gc-grid--4">
              <StatTile label="Models you sell" value={formatNumber(services.length)} sub={unique === 0 ? 'All offered by others too' : `${unique} only you offer`} />
              <StatTile label="Cheapest seller" value={formatNumber(cheapest)} sub="models where you rank first" />
              <StatTile label="Against the median" value={deltaText(average === null ? null : Math.round(average * 10) / 10)} sub="average, blended price" />
              <StatTile label="Sellers seen" value={formatNumber(data.network.peers)} sub={data.network.source ?? 'loading'} />
            </div>
            <Panel title="Your models" description="Blended price is (3 × input + output) / 4, a typical chat mix. Rank 1 is the cheapest. Select a model to see every seller of it." flush>
              <DataTable<SellerMarketService> label="Your models against the market" rows={services} rowKey={(row) => `${row.provider}/${row.service}`}
                onRowClick={(row) => setSelected(row.service === selected ? null : row.service)} selectedKey={open ? `${open.provider}/${open.service}` : null}
                initialSort={{ key: 'competitors', direction: 'desc' }}
                empty={<EmptyState title="No models" body="The seller's config lists no services." />}
                columns={[
                  { key: 'service', header: 'Model', render: (row) => <span className="gc-ellipsis" title={row.service}>{row.service}</span>, sortValue: (row) => row.service },
                  { key: 'mine', header: 'Your price', render: (row) => pair(row.mine.inputUsdPerMillion, row.mine.outputUsdPerMillion), sortValue: (row) => row.mine.blendedUsdPerMillion },
                  { key: 'competitors', header: 'Others', align: 'right', render: (row) => (row.unique ? <Badge tone="neutral">Only you</Badge> : formatNumber(row.competitors)), sortValue: (row) => row.competitors },
                  { key: 'cheapest', header: 'Cheapest', secondary: true, render: (row) => (row.cheapest ? pair(row.cheapest.inputUsdPerMillion, row.cheapest.outputUsdPerMillion) : '—') },
                  { key: 'median', header: 'Median', optional: true, render: (row) => (row.median ? pair(row.median.inputUsdPerMillion, row.median.outputUsdPerMillion) : '—') },
                  { key: 'rank', header: 'Rank', align: 'right', render: (row) => (row.rank === null ? '—' : `${row.rank} of ${row.of}`), sortValue: (row) => row.rank },
                  { key: 'delta', header: 'vs median', align: 'right', render: (row) => deltaText(row.deltaPct), sortValue: (row) => row.deltaPct },
                ]} />
            </Panel>
            {open && <OffersPanel service={open} />}
            {data.notOffered.length > 0 && (
              <Panel title="Models others sell that you don't" description="Most widely offered first: where buyers already go." flush>
                <DataTable label="Models you do not offer" rows={data.notOffered} rowKey={(row) => row.service}
                  columns={[
                    { key: 'service', header: 'Model', render: (row) => row.service },
                    { key: 'sellers', header: 'Sellers', align: 'right', render: (row) => formatNumber(row.sellers) },
                    { key: 'cheapest', header: 'Cheapest output', align: 'right', render: (row) => price(row.cheapestOutputUsdPerMillion) },
                  ]} />
              </Panel>
            )}
          </>
        )
      }}
    </SellerPage>
  )
}

function OffersPanel({ service }: { service: SellerMarketService }) {
  return (
    <Panel title={`Everyone selling ${service.service}`} description={service.unique ? 'No other seller offers this model.' : `${service.of} sellers, cheapest blended price first. Your row is marked.`}
      actions={<Button size="sm" variant="outline" onClick={() => editPrice(service.service)}>Edit your price</Button>} flush>
      <DataTable<SellerMarketOffer> label={`Sellers of ${service.service}`} rows={service.offers} rowKey={(row) => `${row.peerId}:${row.mine}`}
        columns={[
          { key: 'name', header: 'Seller', render: (row) => <span className="gc-inline">{row.mine && <Badge tone="neutral">You</Badge>}<span className="gc-ellipsis" title={row.peerId}>{row.name ?? shortId(row.peerId)}</span></span> },
          { key: 'price', header: 'Input / output', render: (row) => pair(row.inputUsdPerMillion, row.outputUsdPerMillion), sortValue: (row) => row.blendedUsdPerMillion },
          { key: 'cached', header: 'Cached', secondary: true, render: (row) => price(row.cachedInputUsdPerMillion) },
          { key: 'trust', header: 'Trust', align: 'right', render: (row) => (row.trustScore === null ? '—' : Math.round(row.trustScore)), sortValue: (row) => row.trustScore },
          { key: 'tee', header: 'TEE', secondary: true, render: (row) => (row.tee ? <TeeBadge tee scope={null} /> : null) },
          { key: 'load', header: 'Load', align: 'right', optional: true, render: (row) => (row.load === null ? '—' : `${Math.round(row.load * 100)}%`), sortValue: (row) => row.load },
        ]} />
    </Panel>
  )
}
