import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { createConsoleAuth } from '../../../gateway/auth/index.js'
import { readConsoleLocation } from '../../../gateway/console.js'
import { observabilitySettings } from '../../../gateway/observability.js'
import { listNetworkPeers } from '../../../gateway/services/network.js'
import type { BuyerSettings, BuyerSettingsInput, Peer } from '../../../gateway/console-api/types.js'
import { readSettings, setObservabilitySettings, updateBuyerSettings, type SettingsContext } from '../../../gateway/services/settings.js'
import { sameRoutingModel } from '../../../routing-policy/policy.js'
import { collect } from './policy-options.js'
import { addBuyerPortOption, parseCountOrNone, parseOnOff, printJson, withGateway, type CliGateway } from './shared.js'

async function settingsContext(gateway: CliGateway): Promise<SettingsContext> {
  const publicUrl = readConsoleLocation(gateway.store)?.publicUrl ?? null
  // SSO and Cloudflare Access come from this process's environment; the
  // installed service reads its own EnvironmentFile, which a shell may not have.
  const auth = createConsoleAuth({ store: gateway.store, publicUrl, now: () => Date.now(), log: () => undefined }, { env: process.env })
  return {
    ...gateway.ctx,
    configPath: gateway.configPath,
    publicUrl,
    buyerPort: await gateway.buyerPort(),
    authConfig: () => auth.authConfig(),
  }
}

function number(raw: string, flag: string, max?: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || (max !== undefined && value > max)) throw new Error(`${flag} must be a number${max !== undefined ? ` from 0 to ${max}` : ' of at least 0'}.`)
  return value
}

/** `--otlp-endpoint`: a URL, or "none" to turn the export off. */
function endpointOption(raw: string): string | null {
  const value = raw.trim()
  return value.toLowerCase() === 'none' ? null : value
}

export function registerGatewaySettingsCommands(gateway: Command): void {
  const settings = gateway.command('settings').description('Gateway settings: every buyer setting and observability (OTLP export, content logging, retention)')

  addBuyerPortOption(settings.command('show').description('Show the current settings'))
    .option('--reveal', 'show OTLP header values (they can be credentials)', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { reveal: boolean; json: boolean }, cmd: Command) => withGateway(cmd, async (gw) => {
      const current = await readSettings(await settingsContext(gw), { revealSecrets: options.reveal, buyer: await gw.buyer() })
      if (options.json) {
        printJson(current)
        return
      }
      const { buyer, observability, auth } = current
      const mark = (path: string): string => buyer.overrides.some((entry) => entry === path || entry.startsWith(`${path}.`) || path.startsWith(`${entry}.`))
        ? chalk.yellow(' (set by the buyer\'s environment or flags)')
        : ''
      const list = (ids: string[]): string => (ids.length ? ids.join(', ') : 'none')
      console.log(chalk.bold('Buyer'))
      console.log(`  Proxy port: ${buyer.proxyPort}${mark('proxyPort')}`)
      console.log(`  Max price: $${buyer.maxPricing.inputUsdPerMillion}/M in${mark('maxPricing.inputUsdPerMillion')}, $${buyer.maxPricing.outputUsdPerMillion}/M out${mark('maxPricing.outputUsdPerMillion')}${buyer.maxPricing.cachedInputUsdPerMillion === null ? '' : `, $${buyer.maxPricing.cachedInputUsdPerMillion}/M cached in`}`)
      console.log(`  Min peer reputation: ${buyer.minPeerReputation}${mark('minPeerReputation')}`)
      console.log(chalk.bold('  Routing preferences') + chalk.dim(' (apply at once)'))
      console.log(`    Min trust score: ${buyer.routingPreferences.minTrustScore}`)
      console.log(`    Soft input-price limit: $${buyer.routingPreferences.maxInputUsdPerMillion}/M`)
      console.log(`    Free sellers first: ${buyer.routingPreferences.preferFreePeers ? 'yes' : 'no'}`)
      console.log(`    Allowed sellers: ${list(buyer.routingPreferences.allowedPeerIds)}`)
      console.log(`    Blocked sellers: ${list(buyer.routingPreferences.blockedPeerIds)}`)
      console.log(chalk.bold('  Verification') + mark('verifier'))
      console.log(`    Enabled: ${buyer.verifier.enabled ? 'yes' : 'no'}, required: ${buyer.verifier.require ? 'yes' : 'no'}, verifiers: ${buyer.verifier.prefer.length ? buyer.verifier.prefer.join(', ') : 'seller default'}`)
      console.log(`    Evidence sample rate: ${buyer.evidence.sampleRate ?? 'default'}, max sample bytes: ${buyer.evidence.maxSampleBytes ?? 'default'}`)
      console.log(chalk.bold('  Payments'))
      console.log(`    Auto-sweep: ${buyer.payments.autoSweep ? 'on' : 'off'}`)
      console.log(`    Max per request: ${buyer.payments.maxPerRequestUsdc} USDC, max reserve: ${buyer.payments.maxReserveUsdc} USDC`)
      console.log(`    RPC: ${buyer.payments.rpcUrl ?? 'chain default'}${mark('payments.rpcUrl')}${buyer.payments.fallbackRpcUrls.length ? `, fallbacks: ${buyer.payments.fallbackRpcUrls.join(', ')}` : ''}`)
      console.log(chalk.bold('  Network'))
      console.log(`    Peer refresh: ${buyer.network.peerRefreshIntervalMs} ms, metadata timeout: ${buyer.network.metadataFetchTimeoutMs} ms${mark('network.metadataFetchTimeoutMs')}`)
      console.log(`    Request timeout: ${buyer.network.requestTimeoutMs} ms, max stream: ${buyer.network.maxStreamDurationMs} ms${mark('network.maxStreamDurationMs')}`)
      console.log(`    Per-service metadata: ${buyer.network.disableMetadataV2Services ? 'off' : 'on'}${mark('network.disableMetadataV2Services')}`)
      console.log(chalk.bold('Observability'))
      console.log(`  OTLP export: ${observability.otlpEndpoint ?? 'off'}`)
      for (const [name, value] of Object.entries(observability.otlpHeaders)) console.log(`    ${name}: ${value}`)
      console.log(`  Content logging: ${observability.logContent ? 'on' : 'off'}`)
      console.log(`  Request log retention: ${observability.retentionDays === null ? 'forever' : `${observability.retentionDays} day(s)`}`)
      console.log(chalk.bold('Console'))
      console.log(`  Public URL: ${current.publicUrl ?? '-'}`)
      console.log(`  Owner claimed: ${auth.setupRequired ? 'no (`antseed gateway console-link`)' : 'yes'}`)
      console.log(`  Sign-in: ${[auth.passkey && 'passkey', auth.wallet && 'wallet', auth.oidc && `SSO (${auth.oidc.label})`, auth.cloudflareAccess && 'Cloudflare Access', auth.apiKeyLogin && 'API key (read-only)'].filter(Boolean).join(', ')}` + chalk.dim(' (SSO and Cloudflare Access as this shell\'s environment sets them; the gateway service may differ)'))
    }))

  settings.command('set-observability')
    .description('Change observability settings; unspecified ones keep their value')
    .option('--otlp-endpoint <url>', 'OTLP/HTTP traces endpoint, one trace per request ("none" turns the export off)')
    .option('--otlp-header <name=value>', 'header sent to the endpoint, e.g. authorization=Bearer… (repeatable; replaces the saved headers)', collect)
    .option('--clear-headers', 'remove every saved OTLP header', false)
    .option('--log-content <state>', 'store request and response bodies in the request log: on or off')
    .option('--retention-days <days>', 'days to keep the request log ("none" keeps it forever)')
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { otlpEndpoint?: string; otlpHeader?: string[]; clearHeaders: boolean; logContent?: string; retentionDays?: string; json: boolean }, cmd: Command) => withGateway(cmd, ({ store, ctx, actor }) => {
      const current = observabilitySettings(store)
      if (options.otlpEndpoint === undefined && options.otlpHeader === undefined && !options.clearHeaders && options.logContent === undefined && options.retentionDays === undefined) {
        throw new Error('Nothing to change: pass --otlp-endpoint, --otlp-header, --clear-headers, --log-content or --retention-days.')
      }
      if (options.clearHeaders && options.otlpHeader) throw new Error('Use either --otlp-header or --clear-headers.')
      let otlpHeaders = current.otlpHeaders
      if (options.clearHeaders) otlpHeaders = {}
      if (options.otlpHeader) {
        otlpHeaders = {}
        for (const pair of options.otlpHeader) {
          const at = pair.indexOf('=')
          if (at <= 0) throw new Error(`--otlp-header "${pair.split('=')[0]}" must look like name=value.`)
          otlpHeaders[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
        }
      }
      const endpoint = options.otlpEndpoint === undefined ? current.otlpEndpoint : endpointOption(options.otlpEndpoint)
      // Saved header values are credentials for the saved endpoint: a new endpoint needs them given again.
      if (options.otlpEndpoint !== undefined && endpoint && current.otlpEndpoint && !options.otlpHeader && !options.clearHeaders
        && new URL(endpoint).origin !== new URL(current.otlpEndpoint).origin && Object.keys(current.otlpHeaders).length > 0) {
        throw new Error('The export endpoint moves to another origin: give its headers again with --otlp-header (or --clear-headers); saved values are not sent to a new endpoint.')
      }
      const saved = setObservabilitySettings(ctx, actor, {
        otlpEndpoint: endpoint,
        otlpHeaders,
        logContent: options.logContent === undefined ? current.logContent : parseOnOff(options.logContent, '--log-content'),
        retentionDays: options.retentionDays === undefined ? current.retentionDays : parseCountOrNone(options.retentionDays, '--retention-days'),
      }, { mayChangeDestination: true })
      if (options.json) {
        printJson({ ...saved, otlpHeaders: Object.keys(saved.otlpHeaders) })
        return
      }
      console.log(`Observability: export ${saved.otlpEndpoint ?? 'off'}${Object.keys(saved.otlpHeaders).length ? ` (headers: ${Object.keys(saved.otlpHeaders).join(', ')})` : ''}, content logging ${saved.logContent ? 'on' : 'off'}, retention ${saved.retentionDays === null ? 'forever' : `${saved.retentionDays} day(s)`}.`)
      console.log(chalk.dim('A running gateway picks this up on its next request.'))
    }))

  addBuyerPortOption(
    settings.command('set-buyer')
      .description('Change the buyer\'s settings in the config file (in place). Routing preferences apply at once; anything else restarts the buyer')
      .option('--max-input-price <usd>', 'cap on input price, USD per million tokens')
      .option('--max-output-price <usd>', 'cap on output price, USD per million tokens')
      .option('--max-cached-input-price <usd>', 'cap on cached input price, USD per million tokens ("none" removes it)')
      .option('--min-reputation <score>', 'minimum seller reputation, 0-100, for every request')
      .option('--min-trust <score>', 'routing preference: minimum trust score, 0-100')
      .option('--soft-max-input-price <usd>', 'routing preference: sellers above this input price rank lower')
      .option('--prefer-free <state>', 'routing preference: free sellers first, on or off')
      .option('--allow-peer <peerId>', 'routing preference: add a seller to the allow list (repeatable)', collect)
      .option('--unallow-peer <peerId>', 'remove a seller from the allow list (repeatable)', collect)
      .option('--clear-allowed', 'empty the allow list (any seller)', false)
      .option('--block-peer <peerId>', 'routing preference: add a seller to the block list (repeatable)', collect)
      .option('--unblock-peer <peerId>', 'remove a seller from the block list (repeatable)', collect)
      .option('--clear-blocked', 'empty the block list', false)
      .option('--verifier <state>', 'verify sellers with verifier SDKs, on or off')
      .option('--verifiers <ids>', 'ordered, comma-separated verifier ids ("none": the seller\'s trusted default)')
      .option('--require-verifier <state>', 'refuse sellers no verifier verifies, on or off')
      .option('--evidence-sample-rate <rate>', 'share of responses kept as evidence, 0-1 ("none": default)')
      .option('--evidence-max-bytes <bytes>', 'largest evidence sample ("none": default)')
      .option('--auto-sweep <state>', 'sweep USDC arriving in the buyer wallets into deposits, on or off')
      .option('--max-per-request-usdc <usdc>', 'most USDC authorized for one request')
      .option('--max-reserve-usdc <usdc>', 'most USDC reserved for one payment channel')
      .option('--rpc-url <url>', 'Base RPC endpoint ("none": the chain default)')
      .option('--fallback-rpc-url <url>', 'fallback RPC endpoint (repeatable; replaces the list; "none" clears it)', collect)
      .option('--peer-refresh-ms <ms>', 'how often the peer list is refreshed')
      .option('--metadata-timeout-ms <ms>', 'timeout for each seller metadata fetch')
      .option('--request-timeout-ms <ms>', 'timeout until a response starts')
      .option('--max-stream-ms <ms>', 'longest streamed response')
      .option('--per-service-metadata <state>', 'per-service attribution in signed request metadata, on or off'),
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((options: SetBuyerOptions, cmd: Command) => withGateway(cmd, async (gw) => {
      const context = await settingsContext(gw)
      const before = await readSettings(context)
      const patch = buyerPatchFromOptions(options, before.buyer)
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass at least one setting (see --help).')
      const { changed, restartRequired } = await updateBuyerSettings(context, gw.actor, patch, await gw.buyer())
      const current = await readSettings(context, { buyer: await gw.buyer() })
      if (options.json) {
        printJson({ buyer: current.buyer, changed, restartRequired })
        return
      }
      if (!changed) {
        console.log(chalk.dim('Nothing changed.'))
        return
      }
      console.log(`Saved to ${gw.configPath}.`)
      const routingOnly = Object.keys(patch).every((key) => key === 'routingPreferences')
      console.log(routingOnly
        ? chalk.dim('The buyer applies routing preferences at once.')
        : restartRequired
          ? chalk.yellow('The buyer could not restart itself (not supervised, or not running): restart it to apply the new settings.')
          : chalk.dim('The buyer is restarting to apply them.'))
      const ignored = current.buyer.overrides
      if (ignored.length > 0) console.log(chalk.yellow(`The buyer's environment or flags override: ${ignored.join(', ')}. Changes to those apply once the override is removed.`))
    }))
}

interface SetBuyerOptions {
  maxInputPrice?: string
  maxOutputPrice?: string
  maxCachedInputPrice?: string
  minReputation?: string
  minTrust?: string
  softMaxInputPrice?: string
  preferFree?: string
  allowPeer?: string[]
  unallowPeer?: string[]
  clearAllowed: boolean
  blockPeer?: string[]
  unblockPeer?: string[]
  clearBlocked: boolean
  verifier?: string
  verifiers?: string
  requireVerifier?: string
  evidenceSampleRate?: string
  evidenceMaxBytes?: string
  autoSweep?: string
  maxPerRequestUsdc?: string
  maxReserveUsdc?: string
  rpcUrl?: string
  fallbackRpcUrl?: string[]
  peerRefreshMs?: string
  metadataTimeoutMs?: string
  requestTimeoutMs?: string
  maxStreamMs?: string
  perServiceMetadata?: string
  json: boolean
}

const isNone = (raw: string): boolean => raw.trim().toLowerCase() === 'none'

function normalizePeer(raw: string): string {
  return raw.trim().toLowerCase().replace(/^0x/, '')
}

/** A peer list after `--x-peer` additions, `--unx-peer` removals and `--clear-x`. */
function editedList(current: string[], add: string[] | undefined, remove: string[] | undefined, clear: boolean): string[] | undefined {
  if (!add && !remove && !clear) return undefined
  const removed = new Set((remove ?? []).map(normalizePeer))
  const base = clear ? [] : current.map(normalizePeer)
  return [...new Set([...base, ...(add ?? []).map(normalizePeer)])].filter((peerId) => !removed.has(peerId))
}

/** The `set-buyer` flags as a settings patch (value checks happen in the service). */
function buyerPatchFromOptions(options: SetBuyerOptions, current: BuyerSettings): BuyerSettingsInput {
  const patch: BuyerSettingsInput = {}
  const maxPricing: NonNullable<BuyerSettingsInput['maxPricing']> = {}
  if (options.maxInputPrice !== undefined) maxPricing.inputUsdPerMillion = number(options.maxInputPrice, '--max-input-price')
  if (options.maxOutputPrice !== undefined) maxPricing.outputUsdPerMillion = number(options.maxOutputPrice, '--max-output-price')
  if (options.maxCachedInputPrice !== undefined) {
    maxPricing.cachedInputUsdPerMillion = isNone(options.maxCachedInputPrice) ? null : number(options.maxCachedInputPrice, '--max-cached-input-price')
  }
  if (Object.keys(maxPricing).length) patch.maxPricing = maxPricing
  if (options.minReputation !== undefined) patch.minPeerReputation = number(options.minReputation, '--min-reputation', 100)

  const prefs: NonNullable<BuyerSettingsInput['routingPreferences']> = {}
  if (options.minTrust !== undefined) prefs.minTrustScore = number(options.minTrust, '--min-trust', 100)
  if (options.softMaxInputPrice !== undefined) prefs.maxInputUsdPerMillion = number(options.softMaxInputPrice, '--soft-max-input-price')
  if (options.preferFree !== undefined) prefs.preferFreePeers = parseOnOff(options.preferFree, '--prefer-free')
  const allowed = editedList(current.routingPreferences.allowedPeerIds, options.allowPeer, options.unallowPeer, options.clearAllowed)
  if (allowed) prefs.allowedPeerIds = allowed
  const blocked = editedList(current.routingPreferences.blockedPeerIds, options.blockPeer, options.unblockPeer, options.clearBlocked)
  if (blocked) prefs.blockedPeerIds = blocked
  if (Object.keys(prefs).length) patch.routingPreferences = prefs

  const verifier: NonNullable<BuyerSettingsInput['verifier']> = {}
  if (options.verifier !== undefined) verifier.enabled = parseOnOff(options.verifier, '--verifier')
  if (options.requireVerifier !== undefined) verifier.require = parseOnOff(options.requireVerifier, '--require-verifier')
  if (options.verifiers !== undefined) verifier.prefer = isNone(options.verifiers) ? [] : options.verifiers.split(',').map((id) => id.trim()).filter(Boolean)
  if (Object.keys(verifier).length) patch.verifier = verifier

  const evidence: NonNullable<BuyerSettingsInput['evidence']> = {}
  if (options.evidenceSampleRate !== undefined) evidence.sampleRate = isNone(options.evidenceSampleRate) ? null : number(options.evidenceSampleRate, '--evidence-sample-rate', 1)
  if (options.evidenceMaxBytes !== undefined) evidence.maxSampleBytes = isNone(options.evidenceMaxBytes) ? null : number(options.evidenceMaxBytes, '--evidence-max-bytes')
  if (Object.keys(evidence).length) patch.evidence = evidence

  const payments: NonNullable<BuyerSettingsInput['payments']> = {}
  if (options.autoSweep !== undefined) payments.autoSweep = parseOnOff(options.autoSweep, '--auto-sweep')
  if (options.maxPerRequestUsdc !== undefined) payments.maxPerRequestUsdc = number(options.maxPerRequestUsdc, '--max-per-request-usdc')
  if (options.maxReserveUsdc !== undefined) payments.maxReserveUsdc = number(options.maxReserveUsdc, '--max-reserve-usdc')
  if (options.rpcUrl !== undefined) payments.rpcUrl = isNone(options.rpcUrl) ? null : options.rpcUrl.trim()
  if (options.fallbackRpcUrl !== undefined) payments.fallbackRpcUrls = options.fallbackRpcUrl.some(isNone) ? [] : options.fallbackRpcUrl.map((url) => url.trim())
  if (Object.keys(payments).length) patch.payments = payments

  const network: NonNullable<BuyerSettingsInput['network']> = {}
  if (options.peerRefreshMs !== undefined) network.peerRefreshIntervalMs = number(options.peerRefreshMs, '--peer-refresh-ms')
  if (options.metadataTimeoutMs !== undefined) network.metadataFetchTimeoutMs = number(options.metadataTimeoutMs, '--metadata-timeout-ms')
  if (options.requestTimeoutMs !== undefined) network.requestTimeoutMs = number(options.requestTimeoutMs, '--request-timeout-ms')
  if (options.maxStreamMs !== undefined) network.maxStreamDurationMs = number(options.maxStreamMs, '--max-stream-ms')
  if (options.perServiceMetadata !== undefined) network.disableMetadataV2Services = !parseOnOff(options.perServiceMetadata, '--per-service-metadata')
  if (Object.keys(network).length) patch.network = network
  return patch
}

/** The TEE column: how far a verified attestation reaches, or that it is only advertised so far. */
function teeLabel(peer: Peer): string {
  if (!peer.tee) return '-'
  if (peer.teeScope === 'end-to-end') return chalk.green('full')
  if (peer.teeScope === 'seller-node') return chalk.yellow('partial')
  return chalk.dim('unverified')
}

export function registerGatewayPeersCommand(gateway: Command): void {
  addBuyerPortOption(
    gateway.command('peers')
      .description('Sellers the running buyer knows, with trust, TEE, prices and this gateway\'s own 24 h stats'),
  )
    .option('--model <id>', 'only sellers offering this model')
    .option('--tee', 'only sellers with TEE attestation', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { model?: string; tee: boolean; json: boolean }, cmd: Command) => withGateway(cmd, async ({ store, buyer }) => {
      const wanted = options.model?.trim()
      const peers = (await listNetworkPeers(store, await buyer(), Date.now()))
        .filter((peer) => !options.tee || peer.tee)
        .map((peer) => wanted ? { ...peer, services: peer.services.filter((service) => sameRoutingModel(service.service, wanted)) } : peer)
        .filter((peer) => !wanted || peer.services.length > 0)
      if (options.json) {
        printJson(peers)
        return
      }
      if (peers.length === 0) {
        console.log(chalk.dim(wanted ? `No seller offers ${options.model} right now.` : 'The buyer knows no sellers yet.'))
        return
      }
      const table = new Table({ head: ['Seller', 'Name', 'Trust', 'TEE', 'Services', 'In $/M', 'Out $/M', 'p50', 'Req 24h'] })
      for (const peer of peers) {
        const prices = peer.services.map((service) => service.inputUsdPerMillion).filter((value): value is number => value !== null)
        const outs = peer.services.map((service) => service.outputUsdPerMillion).filter((value): value is number => value !== null)
        const range = (values: number[]) => values.length === 0 ? '-' : Math.min(...values) === Math.max(...values) ? String(values[0]) : `${Math.min(...values)}–${Math.max(...values)}`
        table.push([
          peer.peerId,
          peer.displayName ?? '-',
          peer.trustScore ?? '-',
          teeLabel(peer),
          peer.services.length > 3 ? `${peer.services.slice(0, 3).map((service) => service.service).join(', ')} +${peer.services.length - 3}` : peer.services.map((service) => service.service).join(', ') || '-',
          range(prices),
          range(outs),
          peer.latencyMsP50 === null ? '-' : `${peer.latencyMsP50}ms`,
          peer.requests24h,
        ])
      }
      console.log(table.toString())
      if (peers.some((peer) => peer.tee)) {
        console.log(chalk.dim('TEE: full = seller node and its model provider attested; partial = seller node only, its model provider may see requests; unverified = advertised, not attested yet.'))
      }
    }))
}
