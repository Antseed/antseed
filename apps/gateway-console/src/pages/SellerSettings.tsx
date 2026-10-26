import type { ReactNode } from 'react'
import { SellerAlertsEditor } from '../components/SellerAlertsEditor'
import { SellerPage } from '../components/SellerPage'
import { SellerSettingsEditor } from '../components/SellerSettingsEditor'
import { ErrorAlert, LoadingRows, Panel } from '../components/ui'
import { useSellerSettings } from '../lib/queries'
import '../styles/seller.scss'

type SettingsQuery = ReturnType<typeof useSellerSettings>

function Loaded({ query, children }: { query: SettingsQuery; children: (data: NonNullable<SettingsQuery['data']>) => ReactNode }) {
  if (query.isLoading) return <LoadingRows rows={3} />
  // A failed background refetch keeps the editors (and their unsaved drafts) on screen.
  if (query.data) return <>{children(query.data)}</>
  return query.error ? <ErrorAlert error={query.error} onRetry={() => void query.refetch()} /> : null
}

/** Where alerts go, and the seller's config.json. */
export default function SellerSettings() {
  const settings = useSellerSettings()
  return (
    <SellerPage title="Seller settings" description={() => 'Alerts apply within seconds; config.json changes when the seller restarts.'}>
      {(seller) => (
        <>
          <Panel title="Alerts" description="A message when a model is withdrawn, gas runs out, the seller restarts unexpectedly or goes quiet.">
            <Loaded query={settings}>{(data) => <SellerAlertsEditor alerts={data.alerts} state={seller.alerts} />}</Loaded>
          </Panel>
          <Panel title="Settings" description="The seller's config.json. Changes apply when the seller restarts.">
            <Loaded query={settings}>{(data) => <SellerSettingsEditor settings={data.settings} />}</Loaded>
          </Panel>
        </>
      )}
    </SellerPage>
  )
}
