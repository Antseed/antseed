import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileIdentityStore } from '@antseed/node'
import { ConsoleError } from '../gateway/console-api/router.js'
import type {
  SellerAlertSettings, SellerEventView, SellerLogDetail, SellerLogPage, SellerLogQuery, SellerMarket, SellerNetworkMeta, SellerPromote, SellerReputation,
  SellerRpcDiagnostics, SellerServicePricing, SellerSettings, SellerStatus, SellerUsage, TelegramChat,
} from '../gateway/console-api/types.js'
import { rpcUsage } from '../proxy/rpc-sources.js'
import { SellerAlerts } from '../seller-alerts/alerts.js'
import { applyAlertOverrides, DEFAULT_TELEGRAM_TOKEN_ENV, findTelegramChats, readAlertOverrides, readAlertSecrets, readAlertsConfig } from '../seller-alerts/settings.js'
import { BackgroundValue } from './background.js'
import { sellerCardSvg } from './card.js'
import { readSellerLogDetail, readSellerLogs } from './logs.js'
import { marketView, peerKey, trustOfRow, trustRank, trustSteps } from './market.js'
import { NETWORK_SNAPSHOT_TTL_MS, sellerOnlyNetworkLoader, type NetworkLoad, type PeerRow } from './network.js'
import { readSellerPromote, readSellerVerifications, updateSellerVerifications, VerificationChecks } from './promote.js'
import { hasSeller, readSellerEventViews, readSellerStatus, SellerUsageReader } from './reader.js'
import { readSellerAlertSettings, readSellerSettings, updateSellerAlerts, updateSellerSettings } from './settings.js'
import { readSellerStanding, standingTtlMs, type StandingRead } from './standing.js'

export interface SellerMonitorOptions {
  /** The seller's data directory; null when no seller runs here (the gateway resolves it per call). */
  dataDir: () => string | null
  /** The seller's config file for a data directory. */
  configPath: (dataDir: string) => string
  version: string
  env?: NodeJS.ProcessEnv
  /** Outbound fetch for alert tests and the Telegram chat finder. */
  fetch?: typeof fetch
  /** Where the market and trust views get the network; a co-located buyer or discovery by default. */
  network?: () => Promise<NetworkLoad>
  /** On-chain standing; the ants service over the shared provider by default. */
  standing?: (peerId: string, configPath: string) => Promise<StandingRead>
  /** The explorer's base URL for the profile link; from the chain config by default. */
  explorerUrl?: (configPath: string) => Promise<string | null>
  verificationChecks?: VerificationChecks
}

export type SellerSettingsView = { settings: SellerSettings; alerts: SellerAlertSettings }

/**
 * Everything the seller dashboard, the console's Seller pages and the
 * `antseed seller …` commands show or change, in one place: the routes only
 * add access control and audit, the commands only parse flags and print.
 * Slow reads (network, chain) are cached, single-flight and only run when
 * someone asks.
 */
export class SellerMonitor {
  private readonly _env: NodeJS.ProcessEnv
  private readonly _usage = new SellerUsageReader()
  private readonly _network: BackgroundValue<NetworkLoad>
  private readonly _standings = new Map<string, BackgroundValue<StandingRead>>()
  private readonly _checks: VerificationChecks
  private _explorer: Promise<string | null> | null = null
  private _storedPeerIds = new Map<string, Promise<string | null>>()

  constructor(private readonly _options: SellerMonitorOptions) {
    this._env = _options.env ?? process.env
    this._checks = _options.verificationChecks ?? new VerificationChecks()
    const load = _options.network ?? (() => {
      const { dataDir, configPath } = this.seller()
      return sellerOnlyNetworkLoader({ dataDir, configPath })()
    })
    this._network = new BackgroundValue(load, { ttlMs: NETWORK_SNAPSHOT_TTL_MS })
  }

  /** The seller's directories, or a 404 when there is none. */
  seller(): { dataDir: string; configPath: string } {
    const dataDir = this._options.dataDir()
    if (!dataDir) throw new ConsoleError(404, 'no_seller', 'No seller runs on this host')
    return { dataDir, configPath: this._options.configPath(dataDir) }
  }

  // ── Live state ─────────────────────────────────────────────────────────

  status(): Promise<SellerStatus> {
    return readSellerStatus(this._options.dataDir(), this._options.version)
  }

  async rpcDiagnostics(): Promise<SellerRpcDiagnostics> {
    const dataDir = this._options.dataDir()
    let daemon: SellerRpcDiagnostics['daemon'] = null
    if (dataDir && hasSeller(dataDir)) {
      try {
        const state = JSON.parse(await readFile(join(dataDir, 'daemon.state.json'), 'utf-8')) as { rpc?: SellerRpcDiagnostics['daemon'] }
        daemon = state.rpc ?? null
      } catch { /* not running */ }
    }
    return { process: rpcUsage(), daemon }
  }

  events(limit = 100): Promise<SellerEventView[]> {
    return readSellerEventViews(this.seller().dataDir, Math.min(Math.max(1, limit), 500))
  }

  usage(days = 14): Promise<SellerUsage> {
    return this._usage.usage(this.seller().dataDir, Math.min(Math.max(1, days), 30))
  }

  logs(query: SellerLogQuery = {}): SellerLogPage {
    return readSellerLogs(this.seller().dataDir, query)
  }

  /** One request with its receipt, session and payment channel; null when no request has this id. */
  logDetail(id: string): SellerLogDetail | null {
    return readSellerLogDetail(this.seller().dataDir, id)
  }

  // ── Settings and alerts ────────────────────────────────────────────────

  async settings(): Promise<SellerSettingsView> {
    const { dataDir, configPath } = this.seller()
    return { settings: await readSellerSettings(configPath), alerts: await readSellerAlertSettings(configPath, dataDir, this._env) }
  }

  async updateSettings(patch: unknown): Promise<SellerSettingsView & { changed: string[] }> {
    const { fields } = await updateSellerSettings(this.seller().configPath, patch)
    return { ...await this.settings(), changed: fields }
  }

  /** Returns what changed, secrets as set/cleared only. */
  async updateAlerts(patch: unknown): Promise<SellerSettingsView & { changed: Record<string, string> }> {
    const changed = await updateSellerAlerts(this.seller().dataDir, patch)
    return { ...await this.settings(), changed }
  }

  async testAlert(channel?: 'telegram' | 'webhook'): Promise<{ sent: string[]; errors: string[] }> {
    const { dataDir, configPath } = this.seller()
    const alerts = new SellerAlerts({ dataDir, configPath, env: this._env, sellerName: await sellerName(configPath), ...(this._options.fetch ? { fetch: this._options.fetch } : {}) })
    const channels = alerts.channels()
    if (channels.length === 0 || (channel && !channels.includes(channel))) {
      throw new ConsoleError(409, 'channel_not_configured', channel === 'webhook' ? 'Save a webhook URL first' : channel === 'telegram' ? 'Save the bot token and chat id first' : 'No alert channel is set up yet')
    }
    return alerts.send({ at: Date.now(), kind: 'test', severity: 'info', title: 'Test alert: seller alerts are working' }, channel)
  }

  /** Chats that messaged the bot; with no token given, the saved one (which never leaves this process). */
  async telegramChats(botToken?: string | null): Promise<TelegramChat[]> {
    const { dataDir, configPath } = this.seller()
    const tokenEnv = applyAlertOverrides(readAlertsConfig(configPath), readAlertOverrides(dataDir)).telegram?.botTokenEnv || DEFAULT_TELEGRAM_TOKEN_ENV
    const token = botToken?.trim() || this._env[tokenEnv]?.trim() || readAlertSecrets(dataDir).telegramBotToken
    if (!token) throw new ConsoleError(400, 'invalid_request', 'Enter the bot token first')
    try {
      return await findTelegramChats(token, { env: this._env, ...(this._options.fetch ? { fetch: this._options.fetch } : {}) })
    } catch (error) {
      throw new ConsoleError(502, 'telegram_error', (error as Error).message)
    }
  }

  // ── Market, reputation, promotion ──────────────────────────────────────

  /** `wait`: load the network first when there is no snapshot yet (CLI); the dashboard never waits. */
  private async _snapshot(options: { refresh?: boolean; wait?: boolean }): Promise<{ rows: PeerRow[]; meta: SellerNetworkMeta }> {
    if (options.wait && (options.refresh || this._network.read().value === null)) await this._network.refresh()
    const snapshot = this._network.read(options.refresh && !options.wait)
    return {
      rows: snapshot.value?.rows ?? [],
      meta: { source: snapshot.value?.source ?? null, refreshedAt: snapshot.at, refreshing: snapshot.refreshing, error: snapshot.error, peers: snapshot.value?.rows.length ?? 0 },
    }
  }

  /** The seller's peer id (from its running state, else its stored identity) and configured services, when readable. */
  private async _me(): Promise<{ peerId: string | null; services: SellerServicePricing[] | null; dataDir: string; configPath: string }> {
    const { dataDir, configPath } = this.seller()
    const status = await readSellerStatus(dataDir, this._options.version)
    const services = await readSellerSettings(configPath).then((settings) => settings.services, () => null)
    const peerId = status.available ? status.peerId ?? await this._storedPeerId(dataDir) : null
    return { peerId, services, dataDir, configPath }
  }

  /**
   * A stopped seller's peer id, from the address of the identity it keeps in
   * its data dir (an encrypted key's address is readable without unlocking it).
   * Read only: a missing or unreadable key is null, never a new identity.
   */
  private _storedPeerId(dataDir: string): Promise<string | null> {
    let entry = this._storedPeerIds.get(dataDir)
    if (!entry) {
      // Any failure, reading or decoding, means unknown: the cached promise always resolves.
      entry = new FileIdentityStore(dataDir).address()
        .then((address) => (address ? peerKey(address) : null))
        .catch(() => null)
      // Only a found id is kept; a seller that has not made one yet is looked up again.
      void entry.then((peerId) => { if (peerId === null) this._storedPeerIds.delete(dataDir) })
      this._storedPeerIds.set(dataDir, entry)
    }
    return entry
  }

  async market(options: { refresh?: boolean; wait?: boolean } = {}): Promise<SellerMarket> {
    const { peerId, services } = await this._me()
    const { rows, meta } = await this._snapshot(options)
    return marketView(rows, peerId, services, meta)
  }

  async reputation(options: { refresh?: boolean; wait?: boolean } = {}): Promise<SellerReputation> {
    const { peerId, configPath } = await this._me()
    const { rows, meta } = await this._snapshot(options)
    const myRow = peerId ? rows.find((row) => peerKey(String(row['peerId'] ?? '')) === peerKey(peerId)) : undefined
    const trust = trustOfRow(myRow)
    let standing: { value: StandingRead | null; at: number | null; error: string | null } | null = null
    if (peerId) {
      let entry = this._standings.get(peerId)
      if (!entry) {
        const read = this._options.standing ?? ((id: string, path: string) => readSellerStanding({ peerId: id, configPath: path, env: this._env }))
        entry = new BackgroundValue(() => read(peerId, configPath), { ttlMs: standingTtlMs })
        this._standings.set(peerId, entry)
      }
      standing = options.wait ? await entry.get(options.refresh) : entry.read(options.refresh)
    }
    const steps = trustSteps(trust)
    const value = standing?.value?.standing ?? null
    if (value && !value.registryBound) steps.unshift({ part: 'standing', text: 'Bind your seller to the recognized-usage registry (antseed seller register) so your paid traffic earns usage points.' })
    else if (value && !value.eligible) steps.unshift({ part: 'standing', text: `Stake at least the pool minimum${value.minPoolStake ? ` (${value.minPoolStake} ANTS)` : ''} into your pool to become eligible for usage rewards.` })
    return {
      network: meta,
      found: Boolean(myRow),
      trust,
      rank: trustRank(rows, peerId),
      steps,
      standing: value,
      standingError: standing?.error ?? (peerId ? null : 'The seller has not reported its peer id yet; start it once.'),
      standingRefreshedAt: standing?.at ?? null,
    }
  }

  async promote(): Promise<SellerPromote> {
    const { peerId, services, configPath } = await this._me()
    const { rows } = await this._snapshot({})
    const myRow = peerId ? rows.find((row) => peerKey(String(row['peerId'] ?? '')) === peerKey(peerId)) : undefined
    this._explorer ??= (this._options.explorerUrl ?? defaultExplorerUrl)(configPath).catch(() => null)
    return readSellerPromote({ configPath, peerId, services: services ?? [], trustScore: trustOfRow(myRow)?.score ?? null, explorerUrl: await this._explorer, checks: this._checks })
  }

  /** Runs the verification checks now (the same ones buyers run). */
  async checkVerifications(): Promise<SellerPromote> {
    const { peerId, configPath } = await this._me()
    // The configured claims, not the view: a domain limited to some methods must pass one of those.
    if (peerId) await this._checks.check(peerKey(peerId), await readSellerVerifications(configPath))
    return this.promote()
  }

  /** The shareable seller card as SVG. */
  async card(): Promise<string> {
    return sellerCardSvg(await this.promote())
  }

  async saveVerifications(input: unknown): Promise<SellerPromote> {
    await updateSellerVerifications(this.seller().configPath, input)
    return this.promote()
  }
}

async function sellerName(configPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf-8')) as { identity?: { displayName?: string } }
    return parsed.identity?.displayName?.trim() || 'seller'
  } catch {
    return 'seller'
  }
}

async function defaultExplorerUrl(configPath: string): Promise<string | null> {
  const { resolveAntsChain } = await import('@antseed/ants')
  const chain = await resolveAntsChain(configPath) as { explorerApiUrl?: string }
  return chain.explorerApiUrl ?? null
}
