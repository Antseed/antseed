import type { Command } from 'commander'
import chalk from 'chalk'
import Table from 'cli-table3'
import { createConsoleAuth } from '../../../gateway/auth/index.js'
import { readConsoleLocation } from '../../../gateway/console.js'
import { observabilitySettings } from '../../../gateway/observability.js'
import { listNetworkPeers } from '../../../gateway/services/network.js'
import { readSettings, setObservabilitySettings, updateBuyerSettings, type SettingsContext } from '../../../gateway/services/settings.js'
import { sameRoutingModel } from '../../../routing-policy/policy.js'
import { collect } from './policy-options.js'
import { addBuyerPortOption, parseCountOrNone, parseOnOff, printJson, withGateway, type CliGateway } from './shared.js'

async function settingsContext(gateway: CliGateway): Promise<SettingsContext> {
  const auth = createConsoleAuth({ store: gateway.store, publicUrl: null, now: () => Date.now(), log: () => undefined }, { env: {} })
  return {
    ...gateway.ctx,
    configPath: gateway.configPath,
    publicUrl: readConsoleLocation(gateway.store)?.publicUrl ?? null,
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
  const settings = gateway.command('settings').description('Gateway settings: buyer routing defaults and observability (OTLP export, content logging, retention)')

  addBuyerPortOption(settings.command('show').description('Show the current settings'))
    .option('--reveal', 'show OTLP header values (they can be credentials)', false)
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { reveal: boolean; json: boolean }, cmd: Command) => withGateway(cmd, async (gw) => {
      const current = await readSettings(await settingsContext(gw), { revealSecrets: options.reveal })
      if (options.json) {
        printJson(current)
        return
      }
      const { buyer, observability, auth } = current
      console.log(chalk.bold('Buyer'))
      console.log(`  Proxy port: ${buyer.proxyPort}`)
      console.log(`  Max price: $${buyer.maxPricing.inputUsdPerMillion}/M in, $${buyer.maxPricing.outputUsdPerMillion}/M out${buyer.maxPricing.cachedInputUsdPerMillion === null ? '' : `, $${buyer.maxPricing.cachedInputUsdPerMillion}/M cached in`}`)
      console.log(`  Min peer reputation: ${buyer.minPeerReputation}`)
      console.log(`  Require verifier: ${buyer.requireVerifier ? 'yes' : 'no'}`)
      console.log(chalk.bold('Observability'))
      console.log(`  OTLP export: ${observability.otlpEndpoint ?? 'off'}`)
      for (const [name, value] of Object.entries(observability.otlpHeaders)) console.log(`    ${name}: ${value}`)
      console.log(`  Content logging: ${observability.logContent ? 'on' : 'off'}`)
      console.log(`  Request log retention: ${observability.retentionDays === null ? 'forever' : `${observability.retentionDays} day(s)`}`)
      console.log(chalk.bold('Console'))
      console.log(`  Public URL: ${current.publicUrl ?? '-'}`)
      console.log(`  Owner claimed: ${auth.setupRequired ? 'no (`antseed gateway console-link`)' : 'yes'}`)
      console.log(`  Sign-in: ${[auth.passkey && 'passkey', auth.wallet && 'wallet', auth.oidc && `SSO (${auth.oidc.label})`, auth.cloudflareAccess && 'Cloudflare Access', auth.apiKeyLogin && 'API key (read-only)'].filter(Boolean).join(', ')}`)
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
      .description('Change the buyer\'s routing defaults in the config file (in place) and restart the buyer to apply them')
      .option('--max-input-price <usd>', 'default cap on input price, USD per million tokens')
      .option('--max-output-price <usd>', 'default cap on output price, USD per million tokens')
      .option('--max-cached-input-price <usd>', 'default cap on cached input price, USD per million tokens ("none" removes it)')
      .option('--min-reputation <score>', 'minimum seller reputation, 0-100'),
  )
    .option('--json', 'print machine-readable JSON', false)
    .action((options: { maxInputPrice?: string; maxOutputPrice?: string; maxCachedInputPrice?: string; minReputation?: string; json: boolean }, cmd: Command) => withGateway(cmd, async (gw) => {
      const maxPricing: Record<string, number | null> = {}
      if (options.maxInputPrice !== undefined) maxPricing['inputUsdPerMillion'] = number(options.maxInputPrice, '--max-input-price')
      if (options.maxOutputPrice !== undefined) maxPricing['outputUsdPerMillion'] = number(options.maxOutputPrice, '--max-output-price')
      if (options.maxCachedInputPrice !== undefined) {
        maxPricing['cachedInputUsdPerMillion'] = options.maxCachedInputPrice.trim().toLowerCase() === 'none' ? null : number(options.maxCachedInputPrice, '--max-cached-input-price')
      }
      const patch = {
        ...(Object.keys(maxPricing).length ? { maxPricing } : {}),
        ...(options.minReputation !== undefined ? { minPeerReputation: number(options.minReputation, '--min-reputation', 100) } : {}),
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass --max-input-price, --max-output-price, --max-cached-input-price or --min-reputation.')
      const context = await settingsContext(gw)
      const { restartRequired } = await updateBuyerSettings(context, gw.actor, patch, await gw.buyer())
      const current = await readSettings(context)
      if (options.json) {
        printJson({ buyer: current.buyer, restartRequired })
        return
      }
      console.log(`Saved to ${gw.configPath}.`)
      console.log(restartRequired
        ? chalk.yellow('The buyer could not restart itself (not supervised, or not running): restart it to apply the new settings.')
        : chalk.dim('The buyer is restarting to apply them.'))
    }))
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
          peer.tee ? chalk.green('yes') : '-',
          peer.services.length > 3 ? `${peer.services.slice(0, 3).map((service) => service.service).join(', ')} +${peer.services.length - 3}` : peer.services.map((service) => service.service).join(', ') || '-',
          range(prices),
          range(outs),
          peer.latencyMsP50 === null ? '-' : `${peer.latencyMsP50}ms`,
          peer.requests24h,
        ])
      }
      console.log(table.toString())
    }))
}
