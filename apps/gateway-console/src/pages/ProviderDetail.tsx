import { useRef, useState } from 'react'
import { Button, Modal, TextField } from '@antseed/ui'
import type { Peer, Preset } from '../api/types'
import { useConsole, useScopeFilter } from '../app/context'
import { useGatewayBaseUrl } from '../components/copy-actions'
import { FreeTierInfo } from '../components/FreeTierInfo'
import { PeerActionDialog } from '../components/PeerActionDialog'
import { PanelRow, PanelSection } from '../components/SidePanel'
import { TeeBadge } from '../components/TeeBadge'
import { BoostTip } from '../components/TrustInfo'
import { VerificationLinks } from '../components/VerificationLinks'
import {
  Badge, CodeBlock, CopyButton, Figure, Mono, PageLink, SelectField, TabPanel, Tabs,
} from '../components/ui'
import { formatAnts } from '../lib/ants'
import { BOOST_EARNING_MIN, formatBoost, formatDateTime, formatLatency, formatNumber, formatRelative, formatSpeed, shortId } from '../lib/format'
import { isFreeService } from '../lib/free-tier'
import { priceSummary } from '../lib/models'
import { isWorkspaceAdmin } from '../lib/nav'
import { isFreePeer, isPaidPeer } from '../lib/peers'
import { useKeys, usePresets } from '../lib/queries'
import { API_KEY_ENV, connectTabs, pinnedModelId, serviceApiFormat, type ApiFormat, type ConnectTabId } from '../lib/snippets'
import { PresetForm } from './Presets'

type Service = Peer['services'][number]
type PeerActionKind = 'allow' | 'block' | 'prefer'

const FORMAT_LABELS: Record<ApiFormat, string> = {
  'openai-chat-completions': 'Chat completions',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Messages',
  'openai-images': 'Images',
}

function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

export function providerName(peer: Pick<Peer, 'displayName' | 'peerId'>): string {
  return peer.displayName ?? shortId(peer.peerId, 8, 4)
}

function serviceKey(service: Service): string {
  return `${service.provider}:${service.service}`
}

function ProviderMeta({ peer }: { peer: Peer }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <span className="gc-seller__meta">
      <span className="gc-peer-id"><Mono title={peer.peerId}>{shortId(peer.peerId, 6, 4)}</Mono><CopyButton iconOnly value={peer.peerId} label="Copy peer id" /></span>
      <VerificationLinks links={peer.verificationLinks} />
      <TeeBadge tee={peer.tee} scope={peer.teeScope} />
      {isFreePeer(peer, '') && <Badge tone="success">Free</Badge>}
      {peer.washFlagged && <Badge tone="danger">Flagged</Badge>}
      {coolingDown && <Badge tone="warning">Cooling down</Badge>}
      {peer.boost !== null && peer.boost < BOOST_EARNING_MIN && isPaidPeer(peer) && <Badge tone="neutral">0× earns nothing</Badge>}
      <span className="gc-muted">Last seen {formatRelative(peer.lastSeen)}</span>
    </span>
  )
}

function ProviderStats({ peer, showReputation }: { peer: Peer; showReputation: boolean }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <div className="gc-grid gc-grid--2 gc-figures gc-panel-figures">
      <Figure label="Trust score" value={score(peer.trustScore)} />
      {showReputation && <Figure label="Reputation" value={score(peer.reputationScore)} />}
      <Figure label="Stake" value={peer.stakeAnts ? formatAnts(peer.stakeAnts) : '—'} />
      <Figure label={<span className="gc-info-label">Boost (Antseed Points per $1)<BoostTip /></span>} value={isPaidPeer(peer) ? formatBoost(peer.boost) : 'Free, no points'} />
      {peer.freeTier && <Figure label="Free tier (free models)" value={<FreeTierInfo program={peer.freeTier} agentId={peer.agentId} />} />}
      <Figure label="Network usage share" value={peer.usageShareBps === null ? '—' : `${(peer.usageShareBps / 100).toFixed(2)}%`} />
      <Figure label="First token p50 (this gateway)" value={formatLatency(peer.firstTokenMsP50)} />
      <Figure label="Speed p50 (this gateway)" value={formatSpeed(peer.tokensPerSecondP50)} />
      <Figure label="Requests, 24h (this gateway)" value={formatNumber(peer.requests24h)} />
      <Figure label="Failure streak" value={coolingDown ? `${peer.health.failureStreak}, cooling down until ${formatDateTime(peer.health.coolingDownUntil)}` : String(peer.health.failureStreak)} />
    </div>
  )
}

function ProviderModels({ peer, selected, onSelect }: { peer: Peer; selected: Service | null; onSelect: (service: Service) => void }) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const rows = peer.services.filter((service) => !needle || service.service.toLowerCase().includes(needle))
  return (
    <PanelSection title={`Models (${peer.services.length})`}
      actions={peer.services.length > 6 && (
        <TextField size="sm" type="search" aria-label="Search this provider's models" placeholder="Search models" value={search} onChange={(event) => setSearch(event.target.value)} />
      )}>
      {rows.length === 0 ? <p className="gc-fineprint">{needle ? 'No models match.' : 'This provider lists no models.'}</p> : (
        <ul className="gc-panel-rows" aria-label="Models and prices">
          {rows.map((service) => {
            const on = selected !== null && serviceKey(selected) === serviceKey(service)
            return (
              <PanelRow key={serviceKey(service)} selected={on}
                title={<span className="gc-strong">{service.service}</span>}
                meta={<>
                  {isFreeService(service) && service.freeTier
                    ? <FreeTierInfo program={service.freeTier} agentId={peer.agentId} align="center" />
                    : <span>{priceSummary(service)}</span>}
                  {!isFreeService(service) && service.freeTier && <FreeTierInfo program={service.freeTier} agentId={peer.agentId} priced align="center" />}
                  <span>{FORMAT_LABELS[serviceApiFormat(service)]}</span>
                </>}
                actions={<>
                  <CopyButton iconOnly value={pinnedModelId(peer.peerId, service.service)} label={`Copy ${service.service} pinned to this provider (peer@model)`} />
                  <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on} title="Show the API call for this model" onClick={() => onSelect(service)}>
                    API call
                  </Button>
                </>} />
            )
          })}
        </ul>
      )}
    </PanelSection>
  )
}

/** Ready-to-run calls for one of the provider's models, pinned to it, against this gateway. */
function Connect({ peer, service, onSelect }: { peer: Peer; service: Service; onSelect: (service: Service) => void }) {
  const { workspace, viewer } = useConsole()
  const scope = useScopeFilter()
  const baseUrl = useGatewayBaseUrl()
  const keys = useKeys(scope)
  const presets = usePresets(workspace.id)
  const [tab, setTab] = useState<ConnectTabId>('curl')
  const [creatingPreset, setCreatingPreset] = useState(false)
  const format = serviceApiFormat(service)
  const modelId = pinnedModelId(peer.peerId, service.service)
  const preset = presets.data?.find((entry) => entry.model === modelId) ?? null
  const tabs = connectTabs(baseUrl, peer.peerId, service.service, format, preset ? `@preset/${preset.slug}` : null)
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0]!
  const hasKey = (keys.data ?? []).some((key) => key.status === 'active')
  const canCreatePreset = isWorkspaceAdmin(viewer)

  return (
    <PanelSection title="API call"
      actions={peer.services.length > 1 && (
        <SelectField size="sm" aria-label="Model" value={serviceKey(service)}
          onChange={(value) => { const next = peer.services.find((entry) => serviceKey(entry) === value); if (next) onSelect(next) }}
          options={peer.services.map((entry) => ({ value: serviceKey(entry), label: entry.service }))} />
      )}>
      <p className="gc-fineprint">Pinned to this provider with <code>{shortId(modelId, 10, 12)}</code>.</p>
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
      <p className="gc-fineprint">
        Set <code>{API_KEY_ENV}</code> to one of your API keys first.{' '}
        {keys.data && !hasKey && <PageLink to="keys">Create an API key</PageLink>}
      </p>
      <Modal isOpen={creatingPreset} onClose={() => setCreatingPreset(false)} size="lg" title="New preset">
        {creatingPreset && (
          <PresetForm initial={null} prefill={{ name: service.service, model: modelId }}
            onDone={(saved?: Preset) => { setCreatingPreset(false); if (saved) setTab('codex') }} />
        )}
      </Modal>
    </PanelSection>
  )
}

/**
 * A provider in the Providers side panel (`/console/providers/<peerId>`):
 * who they are, Allow / Prefer / Block, their models with copyable
 * `peer@model` ids, and a ready-to-run API call.
 */
export function ProviderPanelBody({ peer, peers, showReputation }: { peer: Peer; peers: Peer[] | undefined; showReputation: boolean }) {
  const [action, setAction] = useState<PeerActionKind | null>(null)
  const [selected, setSelected] = useState<Service | null>(null)
  const connectRef = useRef<HTMLDivElement | null>(null)
  const service = selected ?? peer.services[0] ?? null
  const select = (next: Service) => {
    setSelected(next)
    connectRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <div className="gc-stack">
        <ProviderMeta peer={peer} />
        <div className="gc-panel-actions">
          <Button size="sm" variant="outline" onClick={() => setAction('allow')}>Allow</Button>
          <Button size="sm" variant="outline" onClick={() => setAction('prefer')}>Prefer</Button>
          <Button size="sm" variant="danger" onClick={() => setAction('block')}>Block</Button>
        </div>
        <ProviderStats peer={peer} showReputation={showReputation} />
      </div>
      <ProviderModels peer={peer} selected={service} onSelect={select} />
      {service && <div ref={connectRef} className="gc-scroll-target"><Connect peer={peer} service={service} onSelect={setSelected} /></div>}
      {action && <PeerActionDialog peer={peer} action={action} peers={peers} onClose={() => setAction(null)} />}
    </>
  )
}
