import type { Command } from 'commander'
import chalk from 'chalk'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getServiceMetadataId } from '@antseed/node'
import { canonicalModelKey } from '@antseed/node/model-identity'
import { getGlobalOptions } from '../types.js'
import { BAKED_COMPARABLE_PRICES_URL } from '../../../generated/baked-defaults.js'
import { loadConfig } from '../../../config/loader.js'
import type { AntseedConfig } from '../../../config/types.js'
import {
  loadCryptoContext,
  createChannelsClient,
  createDepositsClient,
  createEmissionsClient,
  requireCryptoConfig,
  formatAnts,
  formatUsdc,
} from '../../payment-utils.js'
import { ChannelsClient } from '@antseed/node'
import { daemonJson } from './daemon.js'
import { pastEpochs } from '../emissions.js'

const HISTORY_WINDOWS = [7, 30, 90]
/**
 * Endpoint serving comparable retail prices for the Saved tile, in the
 * OpenRouter-compatible models schema:
 * `{ data: [{ id, name, pricing: { prompt, completion, input_cache_read } }] }`
 * with prices in USD per token (e.g. set it to OpenRouter's models endpoint).
 * Release builds bake a default via scripts/bake-comparable-prices-url.mjs;
 * with neither env nor baked value, the savings baseline is off. Setting the
 * env to an empty string disables a baked default.
 */
const COMPARABLE_PRICES_URL_ENV = 'ANTSEED_COMPARABLE_PRICES_URL'
const COMPARABLE_PRICES_TIMEOUT_MS = 8_000
const CHART_WIDTH = 24
const ONCHAIN_READ_CONCURRENCY = 8
const MAX_CHANNEL_ROWS = 12

// ─── Daemon reads ───

interface DaemonChannelRow {
  channelId: string
  peerId: string
  seller: string
  buyer: string
  sellerDisplayName: string | null
  cumulativeSigned: string
  reservedAt: number
  updatedAt: number
  status: string
  requestCount: number
  inputTokens: string
  outputTokens: string
}

interface DaemonServiceUsage {
  serviceIdHash: string
  amountUsdc: string
  inputTokens: string
  cachedInputTokens: string
  outputTokens: string
  requestCount: number
}

interface DaemonUsageTotals {
  totalRequests: number
  totalInputTokens: string
  totalOutputTokens: string
  totalSettlements: number
  uniqueSellers: number
  activeChannels: number
  services: DaemonServiceUsage[]
}

function str(raw: Record<string, unknown>, key: string, fallback = '0'): string {
  const value = raw[key]
  return typeof value === 'string' && value ? value : fallback
}

function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeChannelRow(entry: unknown): DaemonChannelRow | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const raw = entry as Record<string, unknown>
  const channelId = str(raw, 'channelId', '') || str(raw, 'sessionId', '')
  if (!channelId) return null
  return {
    channelId,
    peerId: str(raw, 'peerId', ''),
    seller: str(raw, 'seller', ''),
    buyer: str(raw, 'buyer', ''),
    sellerDisplayName: typeof raw['sellerDisplayName'] === 'string' && raw['sellerDisplayName'] ? raw['sellerDisplayName'] : null,
    cumulativeSigned: str(raw, 'cumulativeSigned'),
    reservedAt: num(raw, 'reservedAt'),
    updatedAt: num(raw, 'updatedAt'),
    status: str(raw, 'status', 'unknown'),
    requestCount: num(raw, 'requestCount'),
    // Daemon channel rows name cumulative input tokens `tokensDelivered`
    // (BuyerChannelSummary in @antseed/node).
    inputTokens: str(raw, 'tokensDelivered'),
    outputTokens: str(raw, 'outputTokens'),
  }
}

function normalizeUsageTotals(value: unknown): DaemonUsageTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const services = Array.isArray(raw['services'])
    ? (raw['services'] as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const service = entry as Record<string, unknown>
        const serviceIdHash = str(service, 'serviceIdHash', '')
        if (!serviceIdHash) return []
        return [{
          serviceIdHash,
          amountUsdc: str(service, 'amountUsdc'),
          inputTokens: str(service, 'inputTokens'),
          cachedInputTokens: str(service, 'cachedInputTokens'),
          outputTokens: str(service, 'outputTokens'),
          requestCount: num(service, 'requestCount'),
        }]
      })
    : []
  return {
    totalRequests: num(raw, 'totalRequests'),
    totalInputTokens: str(raw, 'totalInputTokens'),
    totalOutputTokens: str(raw, 'totalOutputTokens'),
    totalSettlements: num(raw, 'totalSettlements'),
    uniqueSellers: num(raw, 'uniqueSellers'),
    activeChannels: num(raw, 'activeChannels'),
    services,
  }
}

// ─── Spend history (mirrors the desktop's buildLocalBuyerSpendHistory) ───
// A channel contributes its latest signed amount and token totals on its last
// local update day: immediate and includes unsettled usage, but a multi-day
// channel cannot be split back into its original request days.

interface SpendDay {
  day: string
  dayStart: number
  spentUsdc: bigint
  tokens: bigint
}

function safeBigInt(value: string | null | undefined): bigint {
  try {
    const parsed = BigInt(value || '0')
    return parsed >= 0n ? parsed : 0n
  } catch {
    return 0n
  }
}

function utcDayStartSeconds(timestampMs: number): number {
  return Math.floor(timestampMs / 86_400_000) * 86_400
}

function buildSpendHistory(channels: DaemonChannelRow[], days: number, nowMs = Date.now()): SpendDay[] {
  const cutoffSeconds = utcDayStartSeconds(nowMs) - ((days - 1) * 86_400)
  const byDayStart = new Map<number, SpendDay>()
  for (const channel of channels) {
    const timestampMs = channel.updatedAt || channel.reservedAt
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue
    const dayStart = utcDayStartSeconds(timestampMs)
    if (dayStart < cutoffSeconds) continue
    const spent = safeBigInt(channel.cumulativeSigned)
    const tokens = safeBigInt(channel.inputTokens) + safeBigInt(channel.outputTokens)
    if (spent === 0n && tokens === 0n && channel.requestCount === 0) continue
    const previous = byDayStart.get(dayStart)
    byDayStart.set(dayStart, {
      day: new Date(dayStart * 1000).toISOString().slice(0, 10),
      dayStart,
      spentUsdc: (previous?.spentUsdc ?? 0n) + spent,
      tokens: (previous?.tokens ?? 0n) + tokens,
    })
  }
  return [...byDayStart.values()].sort((left, right) => left.dayStart - right.dayStart)
}

// ─── Measured savings (mirrors the desktop's measured-savings module) ───
// What the buyer actually paid vs the same tokens at retail reference
// prices. Models with no retail match are excluded from BOTH sides.

interface MeasuredSavings {
  pct: number
  actualUsd: number
  baselineUsd: number
  matchedServices: number
}

type ReferencePrice = { input: number | null; output: number | null; cachedInput: number | null }

function comparablePricesUrl(): string | null {
  const raw = process.env[COMPARABLE_PRICES_URL_ENV]
  if (raw !== undefined) {
    // A set-but-empty env explicitly disables a baked release default.
    return raw.trim() || null
  }
  return BAKED_COMPARABLE_PRICES_URL
}

async function fetchComparableRetailPrices(): Promise<Map<string, ReferencePrice> | null> {
  const url = comparablePricesUrl()
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(COMPARABLE_PRICES_TIMEOUT_MS) })
    if (!res.ok) return null
    const body = await res.json() as { data?: Array<{ id?: unknown; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown } | null }> }
    if (!Array.isArray(body?.data)) return null
    const perMillion = (pricePerToken: unknown): number | null => {
      const numeric = Number(pricePerToken)
      return Number.isFinite(numeric) && numeric > 0 ? numeric * 1_000_000 : null
    }
    const map = new Map<string, ReferencePrice>()
    for (const model of body.data) {
      const price: ReferencePrice = {
        input: perMillion(model.pricing?.prompt),
        output: perMillion(model.pricing?.completion),
        cachedInput: perMillion(model.pricing?.input_cache_read),
      }
      if (price.input === null && price.output === null) continue
      for (const rawName of [model.id, model.name]) {
        if (typeof rawName !== 'string' || !rawName.trim()) continue
        const key = canonicalModelKey(rawName)
        if (key && !map.has(key)) map.set(key, price)
      }
    }
    return map.size > 0 ? map : null
  } catch {
    return null
  }
}

/**
 * Usage attributes spend per keccak256(serviceName); hashing is one-way, so
 * rebuild the reverse map from every service name the buyer has seen
 * advertised in buyer.state.json.
 */
async function resolveServiceNames(dataDir: string, hashes: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  const wanted = new Set(hashes.map((hash) => hash.toLowerCase()))
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { discoveredPeers?: Array<{ services?: unknown }> }
    for (const peer of parsed.discoveredPeers ?? []) {
      if (!Array.isArray(peer?.services)) continue
      for (const service of peer.services) {
        if (typeof service !== 'string' || !service.trim()) continue
        try {
          const hash = getServiceMetadataId(service.trim()).toLowerCase()
          if (wanted.has(hash)) resolved.set(hash, service.trim())
        } catch {
          // hashing never throws for plain strings — belt and braces
        }
      }
    }
  } catch {
    // no buyer state yet — nothing resolves, savings shows as unavailable
  }
  return resolved
}

function computeMeasuredSavings(
  services: DaemonServiceUsage[],
  names: Map<string, string>,
  referenceMap: Map<string, ReferencePrice>,
): MeasuredSavings | null {
  let actualUsd = 0
  let baselineUsd = 0
  let matchedServices = 0
  const tokens = (value: string): number => {
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0
  }
  for (const service of services) {
    const name = names.get(service.serviceIdHash.toLowerCase())
    if (!name) continue
    const ref = referenceMap.get(canonicalModelKey(name))
    if (!ref || (ref.input === null && ref.output === null)) continue
    // Buyer-side inputTokens are total logical input (fresh + cached).
    const totalInput = tokens(service.inputTokens)
    const cached = Math.min(tokens(service.cachedInputTokens), totalInput)
    const freshInput = totalInput - cached
    const output = tokens(service.outputTokens)
    if (totalInput === 0 && output === 0) continue
    const inputPrice = ref.input ?? 0
    const cachedPrice = ref.cachedInput ?? inputPrice
    const outputPrice = ref.output ?? 0
    const serviceBaseline = (freshInput * inputPrice + cached * cachedPrice + output * outputPrice) / 1_000_000
    if (serviceBaseline <= 0) continue
    baselineUsd += serviceBaseline
    actualUsd += tokens(service.amountUsdc) / 1_000_000
    matchedServices += 1
  }
  if (matchedServices === 0 || baselineUsd <= 0) return null
  const pct = Math.round(Math.max(0, Math.min(1, 1 - actualUsd / baselineUsd)) * 100)
  return { pct, actualUsd, baselineUsd, matchedServices }
}

// ─── Formatting ───

function formatCompactTokens(total: bigint): string {
  const value = Number(total)
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return total.toString()
}

function formatUsd(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n
  const cents = (baseUnits % 1_000_000n) / 10_000n
  return `$${whole}.${cents.toString().padStart(2, '0')}`
}

function formatSavedUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  return `$${usd.toFixed(2)}`
}

function isCurrentChannelStatus(status: string): boolean {
  return status === 'active' || status === 'open' || status === 'closing' || status === 'withdrawable'
}

function sumBigints(values: Array<string | bigint>): bigint {
  let total = 0n
  for (const value of values) total += typeof value === 'bigint' ? value : safeBigInt(value)
  return total
}

async function runInBatches<T>(items: T[], batchSize: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.allSettled(items.slice(index, index + batchSize).map(task))
  }
}

// ─── On-chain reads (each degrades to null/empty on failure) ───

async function fetchDepositsBalance(config: AntseedConfig, address: string): Promise<{ available: bigint; reserved: bigint } | null> {
  try {
    return await createDepositsClient(config).getBuyerBalance(address)
  } catch {
    return null
  }
}

async function fetchClaimableRewards(config: AntseedConfig, address: string): Promise<{ pendingAnts: bigint; epoch: number } | null> {
  try {
    const emissionsClient = createEmissionsClient(config)
    const epochInfo = await emissionsClient.getEpochInfo()
    const pending = await emissionsClient.pendingEmissions(address, pastEpochs(epochInfo.epoch))
    return { pendingAnts: pending.buyer, epoch: epochInfo.epoch }
  } catch {
    return null // no emissions contract on this chain / RPC unreachable
  }
}

interface OnChainChannelState {
  /**
   * channelId → funds for live (Active) channels. `reserve` is the on-chain
   * deposit − settled (still held in Deposits); `recoverable` additionally
   * subtracts spend the buyer has signed but the seller hasn't settled yet —
   * sellers settle lazily, so showing the raw reserve as "locked" would
   * present already-spent funds as recoverable.
   */
  locked: Map<string, { reserve: bigint; recoverable: bigint }>
  /**
   * channelId → on-chain lifecycle. The local store can lag the chain badly
   * (a seller-side close is not always observed), and a closed channel's
   * deposit − settled stays positive forever — the remainder was RELEASED at
   * close, not settled — so rows must be dropped by on-chain status, never
   * shown as locked.
   */
  status: Map<string, { status: number; closeRequestedAt: number }>
}

async function readOnChainChannelState(config: AntseedConfig, rows: DaemonChannelRow[]): Promise<OnChainChannelState> {
  const state: OnChainChannelState = { locked: new Map(), status: new Map() }
  try {
    const crypto = requireCryptoConfig(config)
    const channelsClient = createChannelsClient(config)
    // Channels with a delegated seller live behind the seller's facade
    // contract (the row's `seller` is the contract, e.g. DiemStakingProxy) —
    // ChannelsClient probes `channelsAddress()` on it to find the underlying
    // channels deployment.
    const facadeClients = new Map<string, ChannelsClient>()
    const facadeClientFor = (seller: string): ChannelsClient => {
      const key = seller.toLowerCase()
      let client = facadeClients.get(key)
      if (!client) {
        client = new ChannelsClient({
          rpcUrl: crypto.rpcUrl,
          ...(crypto.fallbackRpcUrls && crypto.fallbackRpcUrls.length > 0 ? { fallbackRpcUrls: crypto.fallbackRpcUrls } : {}),
          contractAddress: seller,
          evmChainId: crypto.evmChainId,
        })
        facadeClients.set(key, client)
      }
      return client
    }
    await runInBatches(rows, ONCHAIN_READ_CONCURRENCY, async (row) => {
      let info = await channelsClient.getSession(row.channelId)
      if (info.status === 0 && /^0x[0-9a-fA-F]{40}$/.test(row.seller)) {
        info = await facadeClientFor(row.seller).getSession(row.channelId).catch(() => info)
      }
      // Record status 0 too: a successful read with no record anywhere means
      // the seller never landed reserve() on-chain (or the channel predates a
      // Channels redeployment) — distinct from a failed read, where nothing
      // is recorded and the amount stays genuinely unknown.
      state.status.set(row.channelId, { status: info.status, closeRequestedAt: Number(info.closeRequestedAt) })
      if (info.status === 0) return
      if (info.status !== 1) return // settled/timed-out: nothing is held any more
      const deposit = BigInt(info.deposit.toString())
      const settled = BigInt(info.settled.toString())
      const signed = safeBigInt(row.cumulativeSigned)
      const spent = signed > settled ? signed : settled
      state.locked.set(row.channelId, {
        reserve: deposit > settled ? deposit - settled : 0n,
        recoverable: deposit > spent ? deposit - spent : 0n,
      })
    })
  } catch {
    // chain unreachable — channel rows render without locked amounts
  }
  return state
}

// ─── Command ───

export function registerBuyerActivityCommand(buyerCmd: Command): void {
  buyerCmd
    .command('activity')
    .description('Activity summary: tokens, spending history, measured savings, active channels, and claimable ANTS rewards')
    .option('--days <n>', `Spending window in days (${HISTORY_WINDOWS.join(', ')})`, '7')
    .option('--json', 'Output JSON')
    .action(async (options: { days: string; json?: boolean }) => {
      const globalOpts = getGlobalOptions(buyerCmd)
      const config = await loadConfig(globalOpts.config)
      const days = HISTORY_WINDOWS.includes(Number(options.days)) ? Number(options.days) : 7

      const proxyPort = config.buyer.proxyPort
      const [channelsBody, usageBody] = await Promise.all([
        daemonJson({ port: proxyPort, dataDir: globalOpts.dataDir }, '/_antseed/channels?all=1'),
        daemonJson({ port: proxyPort, dataDir: globalOpts.dataDir }, '/_antseed/buyer-usage'),
      ])
      if (!channelsBody || !usageBody) {
        console.error(chalk.red(`No buyer connection reachable on port ${proxyPort}.`))
        console.error(chalk.dim('Activity is served by the running connection — start it with `antseed buyer start`.'))
        process.exit(1)
      }

      const channels = Array.isArray(channelsBody['channels'])
        ? (channelsBody['channels'] as unknown[]).map(normalizeChannelRow).filter((row): row is DaemonChannelRow => row !== null)
        : []
      const usage = normalizeUsageTotals(usageBody['totals'])

      // The daemon may run with a different key than the local identity.key
      // (the desktop injects its managed key via ANTSEED_IDENTITY_HEX), so
      // take the buyer address from the daemon's own channel rows and only
      // fall back to the local identity when there are none.
      const address = channels.find((row) => row.buyer)?.buyer
        ?? (await loadCryptoContext(globalOpts.dataDir)).address

      // Savings baseline, balances, rewards, and on-chain channel state in
      // parallel; each degrades to "unavailable" on its own without failing
      // the summary.
      const currentChannels = channels.filter((row) => isCurrentChannelStatus(row.status))
      const [referenceMap, serviceNames, deposits, rewards, onChain] = await Promise.all([
        fetchComparableRetailPrices(),
        resolveServiceNames(globalOpts.dataDir, (usage?.services ?? []).map((s) => s.serviceIdHash)),
        fetchDepositsBalance(config, address),
        fetchClaimableRewards(config, address),
        readOnChainChannelState(config, currentChannels),
      ])
      const locked = onChain.locked
      const onChainStatus = onChain.status

      const savings = usage && referenceMap
        ? computeMeasuredSavings(usage.services, serviceNames, referenceMap)
        : null
      const history = buildSpendHistory(channels, days)
      const totalSpent = sumBigints(channels.map((row) => row.cumulativeSigned))
      const totalTokens = usage
        ? safeBigInt(usage.totalInputTokens) + safeBigInt(usage.totalOutputTokens)
        : sumBigints(channels.flatMap((row) => [row.inputTokens, row.outputTokens]))
      const windowSpent = sumBigints(history.map((day) => day.spentUsdc))
      const windowTokens = sumBigints(history.map((day) => day.tokens))
      // The chain is the authority on liveness: locally-"active" rows whose
      // on-chain record says settled/timed-out are history, not active. Among
      // live rows, keep those whose reserve is still held (or unknown) — a
      // fully signed-away channel shows "no funds locked" but stays closable.
      const effectiveStatus = (row: DaemonChannelRow): string => {
        const chain = onChainStatus.get(row.channelId)
        if (!chain) return row.status
        if (chain.status === 2) return 'settled'
        if (chain.status === 3) return 'timedout'
        if (chain.status === 1 && chain.closeRequestedAt > 0) return 'closing'
        return row.status
      }
      // Confirmed no-record rows (the seller never landed reserve()) hold no
      // funds and have nothing to close — they are local bookkeeping, not
      // activity, so they are counted but not listed.
      const currentByChain = currentChannels.filter((row) => isCurrentChannelStatus(effectiveStatus(row)))
      const unreservedCount = currentByChain
        .filter((row) => onChainStatus.get(row.channelId)?.status === 0)
        .length
      const activeRows = currentByChain
        .filter((row) => onChainStatus.get(row.channelId)?.status !== 0)
        .filter((row) => !locked.has(row.channelId) || locked.get(row.channelId)!.reserve > 0n)
        .sort((left, right) => {
          const leftLocked = locked.get(left.channelId)?.recoverable ?? -1n
          const rightLocked = locked.get(right.channelId)?.recoverable ?? -1n
          if (leftLocked !== rightLocked) return rightLocked > leftLocked ? 1 : -1
          return (right.reservedAt || 0) - (left.reservedAt || 0)
        })

      if (options.json) {
        console.log(JSON.stringify({
          usage,
          totals: { tokens: totalTokens.toString(), spentUsdcBaseUnits: totalSpent.toString() },
          savings,
          spending: {
            days,
            spentUsdcBaseUnits: windowSpent.toString(),
            tokens: windowTokens.toString(),
            byDay: history.map((day) => ({ day: day.day, spentUsdcBaseUnits: day.spentUsdc.toString(), tokens: day.tokens.toString() })),
          },
          channels: activeRows.map((row) => ({
            ...row,
            status: effectiveStatus(row),
            lockedBaseUnits: locked.get(row.channelId)?.recoverable.toString() ?? null,
            onChainReserveBaseUnits: locked.get(row.channelId)?.reserve.toString() ?? null,
            onChainStatus: onChainStatus.get(row.channelId)?.status ?? null,
          })),
          unreservedChannels: unreservedCount,
          deposits: deposits
            ? { available: deposits.available.toString(), reserved: deposits.reserved.toString() }
            : null,
          rewards: rewards
            ? { pendingAntsBaseUnits: rewards.pendingAnts.toString(), pendingAnts: formatAnts(rewards.pendingAnts), epoch: rewards.epoch }
            : null,
        }, null, 2))
        return
      }

      console.log('')
      console.log(chalk.bold('Activity'))
      console.log('')
      let savedLabel: string
      if (savings) {
        savedLabel = `${formatSavedUsd(savings.baselineUsd - savings.actualUsd)} (${savings.pct}% vs retail, ${savings.matchedServices} matched model${savings.matchedServices === 1 ? '' : 's'})`
      } else if ((usage?.totalRequests ?? 0) === 0) {
        savedLabel = '$0'
      } else if (!comparablePricesUrl()) {
        savedLabel = chalk.dim(`off — set ${COMPARABLE_PRICES_URL_ENV} to a retail-prices models API`)
      } else {
        savedLabel = chalk.dim('unavailable')
      }
      console.log(`  Tokens ${chalk.bold(formatCompactTokens(totalTokens))} · Spent ${chalk.bold(formatUsd(totalSpent))} · Saved ${chalk.bold(savedLabel)}`)
      console.log('')

      console.log(chalk.bold(`Spending — last ${days} days`) + chalk.dim(`   ${formatCompactTokens(windowTokens)} tokens · ${formatUsd(windowSpent)}`))
      if (history.length === 0) {
        console.log(chalk.dim('  No spending in this window.'))
      } else {
        const maxSpent = history.reduce((max, day) => (day.spentUsdc > max ? day.spentUsdc : max), 1n)
        for (const day of history) {
          const width = Number((day.spentUsdc * BigInt(CHART_WIDTH)) / maxSpent)
          const bar = '█'.repeat(Math.max(day.spentUsdc > 0n ? 1 : 0, width))
          console.log(`  ${day.day}  ${chalk.green(bar.padEnd(CHART_WIDTH))}  ${formatUsd(day.spentUsdc)}`)
        }
      }
      console.log('')

      const totalLocked = sumBigints([...locked.values()].map((entry) => entry.recoverable))
      console.log(chalk.bold('Active channels') + chalk.dim(locked.size > 0 ? `   ${formatUsd(totalLocked)} locked` : ''))
      if (unreservedCount > 0) {
        console.log(chalk.dim(`  (${unreservedCount} locally-tracked channel${unreservedCount === 1 ? '' : 's'} with no on-chain record hidden — nothing is locked for them)`))
      }
      if (activeRows.length === 0) {
        console.log(chalk.dim('  No active channels.'))
      } else {
        for (const row of activeRows.slice(0, MAX_CHANNEL_ROWS)) {
          const name = row.sellerDisplayName ?? `${row.seller.slice(0, 8)}…${row.seller.slice(-4)}`
          const entry = locked.get(row.channelId)
          let lockedAmount: string
          if (!entry) {
            lockedAmount = chalk.dim('locked amount unavailable')
          } else if (entry.recoverable === 0n) {
            lockedAmount = chalk.dim('no funds locked')
          } else {
            lockedAmount = `${formatUsd(entry.recoverable)} locked`
          }
          console.log(`  ${name.padEnd(24)} ${effectiveStatus(row).padEnd(12)} ${lockedAmount}`)
          console.log(chalk.dim(`    ${row.channelId}`))
        }
        if (activeRows.length > MAX_CHANNEL_ROWS) {
          console.log(chalk.dim(`  … ${activeRows.length - MAX_CHANNEL_ROWS} more — see \`antseed buyer channels\``))
        }
        console.log('')
        console.log(chalk.dim('  Close a channel with `antseed buyer channels close <channelId>` — asks the seller to settle and release the remainder instantly.'))
        console.log(chalk.dim('  If the seller is unreachable, `antseed buyer channels request-close <channelId>` starts an on-chain close; after the'))
        console.log(chalk.dim('  15-minute grace period, `antseed buyer channels withdraw <channelId>` reclaims the remaining locked funds.'))
      }
      console.log('')

      if (rewards) {
        console.log(chalk.bold('Rewards') + chalk.dim(`   epoch ${rewards.epoch}`))
        if (rewards.pendingAnts > 0n) {
          console.log(`  ${chalk.green(`${formatAnts(rewards.pendingAnts)} ANTS`)} available to claim — run \`${chalk.bold('antseed buyer emissions claim')}\``)
        } else {
          console.log(chalk.dim('  No ANTS available to claim yet.'))
        }
        console.log('')
      }

      if (deposits) {
        console.log(chalk.dim(`Deposits: ${formatUsdc(deposits.available)} USDC available · ${formatUsdc(deposits.reserved)} USDC reserved`))
      }
      if (usage) {
        console.log(chalk.dim(`Lifetime: ${usage.totalRequests} requests · ${usage.uniqueSellers} sellers · ${usage.totalSettlements} settlements`))
      }
      console.log('')
    })
}
