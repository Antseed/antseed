import { useMemo, useRef, useState } from 'react'
import { Button, DataTable, Modal, TextField } from '@antseed/ui'
import type { Peer, Preset } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { useCopy, useGatewayBaseUrl } from '../components/copy-actions'
import { PeerActionDialog } from '../components/PeerActionDialog'
import { Icon } from '../components/icons'
import {
  Badge, CodeBlock, CopyButton, EmptyState, Figure, Mono, PageHeader, PageLink, Panel, QueryView, SelectField, TabPanel, Tabs,
} from '../components/ui'
import { formatAnts } from '../lib/ants'
import { formatDateTime, formatLatency, formatNumber, formatPricePerMillion, formatRelative, shortId } from '../lib/format'
import { isWorkspaceAdmin } from '../lib/nav'
import { samePeerId } from '../lib/peer-id'
import { isFreePeer } from '../lib/peers'
import { hasReputationData } from '../lib/policy-match'
import { useKeys, usePeers, usePresets } from '../lib/queries'
import { connectTabs, modelSnippets, pinnedModelId, serviceApiFormat, type ApiFormat, type ConnectTabId } from '../lib/snippets'
import { PresetForm } from './Presets'

type Service = Peer['services'][number]
type PeerActionKind = 'allow' | 'block' | 'prefer'

const FORMAT_LABELS: Record<ApiFormat, string> = {
  'openai-chat-completions': 'Chat completions',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Messages',
}

function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

function SellerHeader({ peer, onAction }: { peer: Peer; onAction: (kind: PeerActionKind) => void }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <div className="gc-stack gc-stack--tight">
      <PageLink to="network">← Network</PageLink>
      <PageHeader
        title={peer.displayName ?? shortId(peer.peerId, 8, 4)}
        description={
          <span className="gc-seller__meta">
            <span className="gc-peer-id"><Mono title={peer.peerId}>{shortId(peer.peerId, 6, 4)}</Mono><CopyButton iconOnly value={peer.peerId} label="Copy peer id" /></span>
            {peer.verified && <Badge tone="success">Verified</Badge>}
            {peer.tee && <Badge tone="info">TEE</Badge>}
            {isFreePeer(peer, '') && <Badge tone="success">Free</Badge>}
            {peer.washFlagged && <Badge tone="danger">Flagged</Badge>}
            {coolingDown && <Badge tone="warning">Cooling down</Badge>}
            <span className="gc-muted">Last seen {formatRelative(peer.lastSeen)}</span>
          </span>
        }
        actions={<>
          <Button size="sm" variant="outline" onClick={() => onAction('allow')}>Allow</Button>
          <Button size="sm" variant="outline" onClick={() => onAction('prefer')}>Prefer</Button>
          <Button size="sm" variant="danger" onClick={() => onAction('block')}>Block</Button>
        </>} />
    </div>
  )
}

function SellerStats({ peer, showReputation }: { peer: Peer; showReputation: boolean }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <Panel>
      <div className="gc-grid gc-grid--4 gc-figures">
        <Figure label="Trust score" value={score(peer.trustScore)} />
        {showReputation && <Figure label="Reputation" value={score(peer.reputationScore)} />}
        <Figure label="Stake" value={peer.stakeAnts ? formatAnts(peer.stakeAnts) : '—'} />
        <Figure label="Network usage share" value={peer.usageShareBps === null ? '—' : `${(peer.usageShareBps / 100).toFixed(2)}%`} />
        <Figure label="Latency p50 (this gateway)" value={formatLatency(peer.latencyMsP50)} />
        <Figure label="Requests, 24h (this gateway)" value={formatNumber(peer.requests24h)} />
        <Figure label="Failure streak" value={coolingDown ? `${peer.health.failureStreak}, cooling down until ${formatDateTime(peer.health.coolingDownUntil)}` : String(peer.health.failureStreak)} />
      </div>
    </Panel>
  )
}

function ModelsTable({ peer, onConnect }: { peer: Peer; onConnect: (service: Service) => void }) {
  const [search, setSearch] = useState('')
  const baseUrl = useGatewayBaseUrl()
  const copy = useCopy()
  const needle = search.trim().toLowerCase()
  const rows = peer.services.filter((service) => !needle || service.service.toLowerCase().includes(needle))
  return (
    <Panel flush title={`Models (${peer.services.length})`} description="Prices in $ per million tokens."
      actions={peer.services.length > 6 && (
        <TextField size="sm" type="search" aria-label="Search models" placeholder="Search models" value={search} onChange={(event) => setSearch(event.target.value)} />
      )}>
      <DataTable<Service> label="Models and prices" rows={rows} rowKey={(service) => `${service.provider}:${service.service}`}
        rowLabel={(service) => service.service} onRowClick={onConnect}
        actions={(service) => [
          ...modelSnippets(baseUrl, peer.peerId, service.service, serviceApiFormat(service)).map((snippet) => ({ label: snippet.label, onSelect: () => void copy(snippet.code) })),
          { label: 'Show connect examples', onSelect: () => onConnect(service) },
        ]}
        empty={<EmptyState title={needle ? 'No models match' : 'This seller lists no models'} />}
        columns={[
          { key: 'model', header: 'Model', sortValue: (service) => service.service, render: (service) => <span className="gc-strong">{service.service}</span> },
          { key: 'api', header: 'API', secondary: true, render: (service) => <span className="gc-muted">{FORMAT_LABELS[serviceApiFormat(service)]}</span> },
          { key: 'input', header: 'Input', align: 'right', sortValue: (service) => service.inputUsdPerMillion, render: (service) => formatPricePerMillion(service.inputUsdPerMillion) },
          { key: 'cached', header: 'Cached', align: 'right', secondary: true, sortValue: (service) => service.cachedInputUsdPerMillion, render: (service) => formatPricePerMillion(service.cachedInputUsdPerMillion) },
          { key: 'output', header: 'Output', align: 'right', sortValue: (service) => service.outputUsdPerMillion, render: (service) => formatPricePerMillion(service.outputUsdPerMillion) },
        ]} />
    </Panel>
  )
}

/** Connect examples for one of the seller's models, against this gateway. */
function Connect({ peer, selected, onSelect }: { peer: Peer; selected: Service | null; onSelect: (service: Service) => void }) {
  const { workspace, viewer } = useConsole()
  const scope = useScopeFilter()
  const baseUrl = useGatewayBaseUrl()
  const keys = useKeys(scope)
  const presets = usePresets(workspace.id)
  const [tab, setTab] = useState<ConnectTabId>('curl')
  const [creatingPreset, setCreatingPreset] = useState(false)
  const service = selected ?? peer.services[0] ?? null
  if (!service) return null
  const format = serviceApiFormat(service)
  const modelId = pinnedModelId(peer.peerId, service.service)
  const preset = presets.data?.find((entry) => entry.model === modelId) ?? null
  const tabs = connectTabs(baseUrl, peer.peerId, service.service, format, preset ? `@preset/${preset.slug}` : null)
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0]!
  const hasKey = (keys.data ?? []).some((key) => key.status === 'active')
  const canCreatePreset = isWorkspaceAdmin(viewer)
  const optionValue = (entry: Service) => `${entry.provider}:${entry.service}`

  return (
    <Panel title="Connect" description={<>Calls go through this gateway at <code>{baseUrl}</code> and are pinned to this seller with <code>{shortId(modelId, 10, 12)}</code>.</>}
      actions={peer.services.length > 1 && (
        <SelectField size="sm" aria-label="Model" value={optionValue(service)}
          onChange={(value) => { const next = peer.services.find((entry) => optionValue(entry) === value); if (next) onSelect(next) }}
          options={peer.services.map((entry) => ({ value: optionValue(entry), label: entry.service }))} />
      )}>
      <div className="gc-stack">
        <p className="gc-fineprint">
          Set <code>ANTSEED_API_KEY</code> to one of your API keys first.{' '}
          {keys.data && !hasKey && <PageLink to="keys">Create an API key</PageLink>}
        </p>
        <Tabs id="gc-connect" label="Ways to connect" value={current.id} onChange={setTab} className="gc-connect-tabs"
          tabs={tabs.map((entry) => ({ id: entry.id, label: entry.label }))} />
        <TabPanel tabsId="gc-connect" tab={current.id} className="gc-stack">
          {current.id === 'codex' && (
            <div className="gc-summary-row">
              <p className="gc-fineprint gc-summary-row__text">
                {preset
                  ? <>Uses the preset <code>@preset/{preset.slug}</code> for this model. Codex needs a preset: with a raw GPT model name it switches to a tool format some sellers drop.</>
                  : <>Codex needs a preset, not a raw model name: with a GPT model name it switches to a tool format some sellers drop. Create one for this model, then use its slug.</>}
              </p>
              {!preset && canCreatePreset && <Button size="sm" variant="outline" onClick={() => setCreatingPreset(true)}>Create preset for this model</Button>}
            </div>
          )}
          {current.id === 'claude-code' && format !== 'anthropic-messages' && (
            <p className="gc-fineprint">This model speaks {FORMAT_LABELS[format]}; the gateway translates Claude Code's requests for it.</p>
          )}
          <CodeBlock code={current.code} label={`${service.service} · ${current.label}`} />
        </TabPanel>
      </div>
      <Modal isOpen={creatingPreset} onClose={() => setCreatingPreset(false)} size="lg" title="New preset">
        {creatingPreset && (
          <PresetForm initial={null} prefill={{ name: service.service, model: modelId }}
            onDone={(saved?: Preset) => { setCreatingPreset(false); if (saved) setTab('codex') }} />
        )}
      </Modal>
    </Panel>
  )
}

/** A seller's own page (`/console/network/<peerId>`): who they are, their models and prices, and how to call them. */
export default function Seller({ peerId }: { peerId: string }) {
  const peers = usePeers()
  const [action, setAction] = useState<PeerActionKind | null>(null)
  const [selected, setSelected] = useState<Service | null>(null)
  const connectRef = useRef<HTMLDivElement | null>(null)
  const showReputation = hasReputationData(peers.data)
  const peer = useMemo(() => peers.data?.find((entry) => samePeerId(entry.peerId, peerId)) ?? null, [peers.data, peerId])

  return (
    <div className="gc-page">
      <QueryView query={peers} rows={6}>
        {() => peer ? (
          <>
            <SellerHeader peer={peer} onAction={setAction} />
            <SellerStats peer={peer} showReputation={showReputation} />
            <ModelsTable peer={peer} onConnect={(service) => {
              setSelected(service)
              connectRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }} />
            <div ref={connectRef} className="gc-scroll-target"><Connect peer={peer} selected={selected} onSelect={setSelected} /></div>
            {action && <PeerActionDialog peer={peer} action={action} peers={peers.data} onClose={() => setAction(null)} />}
          </>
        ) : (
          <>
            <PageLink to="network">← Network</PageLink>
            <EmptyState icon={<Icon.network size={18} />} title="Seller not found" body={`This gateway does not see ${shortId(peerId, 8, 6)} right now.`} />
          </>
        )}
      </QueryView>
    </div>
  )
}
