import type { Command } from 'commander';
import chalk from 'chalk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { getGlobalOptions } from './types.js';
import { createDepositsClient, requireCryptoConfig } from '../payment-utils.js';
import { FileIdentityStore, identityFromPrivateKeyHex } from '@antseed/node';
import { MeteringStorage } from '@antseed/node/metering';
import { parseGas, parseModelHealth, SELLER_STALE_MS } from '../../seller-monitor/reader.js';
import { sharedChainProvider } from '../../proxy/chain-rpc.js';
import { rpcUsage, withRpcSource } from '../../proxy/rpc-sources.js';
import { ChannelStore, type StoredChannel } from '@antseed/node/payments';

const DAY_MS = 86_400_000;
const MICRO_USDC = 1_000_000;

export interface MetricSample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  labels?: Record<string, string | number | boolean | null | undefined>;
  value: string | number | bigint;
}

interface MetricsOptions {
  role?: string;
  host?: string;
  port?: string;
  path?: string;
  instance?: string;
  includeChain?: boolean;
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function microsToUsdc(value: unknown): number {
  return num(value) / MICRO_USDC;
}

function utcDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function metricLineName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

function escapeLabelValue(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(labels?: MetricSample['labels']): string {
  const entries = Object.entries(labels ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '';
  return `{${entries.map(([key, value]) => `${metricLineName(key)}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function formatMetricValue(value: MetricSample['value']): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  return value;
}

function renderPrometheus(samples: MetricSample[]): string {
  const meta = new Map<string, { help: string; type: MetricSample['type'] }>();
  for (const sample of samples) {
    const name = metricLineName(sample.name);
    if (!meta.has(name)) meta.set(name, { help: sample.help, type: sample.type });
  }

  const lines: string[] = [];
  for (const [name, info] of meta.entries()) {
    lines.push(`# HELP ${name} ${info.help.replace(/\n/g, ' ')}`);
    lines.push(`# TYPE ${name} ${info.type}`);
    for (const sample of samples.filter((row) => metricLineName(row.name) === name)) {
      lines.push(`${name}${formatLabels(sample.labels)} ${formatMetricValue(sample.value)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function labels(base: Record<string, string>, extra?: MetricSample['labels']): MetricSample['labels'] {
  return { ...base, ...(extra ?? {}) };
}

function addSample(samples: MetricSample[], baseLabels: Record<string, string>, sample: Omit<MetricSample, 'labels'> & { labels?: MetricSample['labels'] }): void {
  samples.push({ ...sample, labels: labels(baseLabels, sample.labels) });
}

function effectiveMicros(channel: StoredChannel): number {
  return Math.max(num(channel.authMax), num(channel.settledAmount), num(channel.previousConsumption));
}

function channelEventMs(channel: StoredChannel): number {
  return num(channel.settledAt) || num(channel.updatedAt) || num(channel.createdAt) || num(channel.reservedAt);
}

async function loadExistingWalletAddress(dataDir: string): Promise<string> {
  const rawEnvHex = process.env.ANTSEED_IDENTITY_HEX?.trim();
  const envHex = rawEnvHex?.startsWith('0x') ? rawEnvHex.slice(2) : rawEnvHex;
  if (envHex && envHex.length === 64) return identityFromPrivateKeyHex(envHex).wallet.address;

  const existingHex = await new FileIdentityStore(dataDir).load();
  if (existingHex && existingHex.length === 64) return identityFromPrivateKeyHex(existingHex).wallet.address;
  return '';
}

function listChannels(dataDir: string, limit: number): StoredChannel[] {
  const dbPath = join(dataDir, 'payments', 'sessions.db');
  if (!existsSync(dbPath)) return [];
  const store = new ChannelStore(join(dataDir, 'payments'));
  try {
    return store.listAllChannels(limit);
  } finally {
    store.close();
  }
}

async function readDaemonState(dataDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'daemon.state.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function addCommonMetrics(samples: MetricSample[], baseLabels: Record<string, string>, daemon: Record<string, unknown> | null): Promise<void> {
  addSample(samples, baseLabels, {
    name: 'antseed_metrics_scrape_timestamp_seconds',
    help: 'Unix timestamp of the metrics scrape.',
    type: 'gauge',
    value: Math.floor(Date.now() / 1000),
  });
  addSample(samples, baseLabels, {
    name: 'antseed_daemon_up',
    help: 'Whether a local Antseed daemon state file exists and is readable.',
    type: 'gauge',
    value: daemon ? 1 : 0,
  });
  if (daemon) {
    addSample(samples, baseLabels, {
      name: 'antseed_daemon_info',
      help: 'Static daemon info from daemon.state.json.',
      type: 'gauge',
      labels: {
        state: String(daemon.state ?? 'unknown'),
        peer_id: String(daemon.peerId ?? ''),
        dht_port: daemon.dhtPort == null ? '' : String(daemon.dhtPort),
        signaling_port: daemon.signalingPort == null ? '' : String(daemon.signalingPort),
      },
      value: 1,
    });
    addSample(samples, baseLabels, {
      name: 'antseed_daemon_active_channels',
      help: 'Active channel count reported by the running daemon state.',
      type: 'gauge',
      value: num(daemon.activeChannels),
    });
  }
}

async function addBuyerMetrics(samples: MetricSample[], baseLabels: Record<string, string>, dataDir: string, includeChain: boolean, configPath: string): Promise<void> {
  const wallet = await loadExistingWalletAddress(dataDir);
  const buyerLabels = { ...baseLabels, role: 'buyer', wallet };
  const allChannels = listChannels(dataDir, 1_000_000).filter((channel) => channel.role === 'buyer' && (!wallet || channel.buyerEvmAddr.toLowerCase() === wallet.toLowerCase()));
  const dayStart = utcDayStartMs();

  addSample(samples, buyerLabels, {
    name: 'antseed_buyer_channels_total',
    help: 'Buyer payment channels by status from local channel store.',
    type: 'gauge',
    labels: { status: 'all' },
    value: allChannels.length,
  });
  for (const status of ['active', 'settled', 'timeout', 'ghost']) {
    addSample(samples, buyerLabels, {
      name: 'antseed_buyer_channels_total',
      help: 'Buyer payment channels by status from local channel store.',
      type: 'gauge',
      labels: { status },
      value: allChannels.filter((channel) => channel.status === status).length,
    });
  }

  const allTimeMicros = allChannels.reduce((sum, channel) => sum + effectiveMicros(channel), 0);
  const todayMicros = allChannels
    .filter((channel) => channelEventMs(channel) >= dayStart)
    .reduce((sum, channel) => sum + effectiveMicros(channel), 0);
  const activeAuthorizedMicros = allChannels
    .filter((channel) => channel.status === 'active')
    .reduce((sum, channel) => sum + num(channel.authMax), 0);
  const requests = allChannels.reduce((sum, channel) => sum + channel.requestCount, 0);
  const tokens = allChannels.reduce((sum, channel) => sum + num(channel.tokensDelivered), 0);

  addSample(samples, buyerLabels, { name: 'antseed_buyer_spend_usdc_total', help: 'Buyer all-time authorized/effective spend in USDC from local channels.', type: 'counter', value: microsToUsdc(allTimeMicros) });
  addSample(samples, buyerLabels, { name: 'antseed_buyer_spend_today_usdc', help: 'Buyer spend attributed to channels updated since UTC day start.', type: 'gauge', value: microsToUsdc(todayMicros) });
  addSample(samples, buyerLabels, { name: 'antseed_buyer_active_authorized_usdc', help: 'Buyer USDC currently authorized in active channels.', type: 'gauge', value: microsToUsdc(activeAuthorizedMicros) });
  addSample(samples, buyerLabels, { name: 'antseed_buyer_requests_total', help: 'Buyer request count from local channels.', type: 'counter', value: requests });
  addSample(samples, buyerLabels, { name: 'antseed_buyer_tokens_total', help: 'Buyer token count from local channels.', type: 'counter', value: tokens });

  const byPeer = new Map<string, { spend: number; requests: number; tokens: number; channels: number }>();
  for (const channel of allChannels) {
    const row = byPeer.get(channel.peerId) ?? { spend: 0, requests: 0, tokens: 0, channels: 0 };
    row.spend += effectiveMicros(channel);
    row.requests += channel.requestCount;
    row.tokens += num(channel.tokensDelivered);
    row.channels += 1;
    byPeer.set(channel.peerId, row);
  }
  for (const [peerId, row] of byPeer.entries()) {
    addSample(samples, buyerLabels, { name: 'antseed_buyer_peer_spend_usdc_total', help: 'Buyer all-time spend by seller peer.', type: 'counter', labels: { peer_id: peerId }, value: microsToUsdc(row.spend) });
    addSample(samples, buyerLabels, { name: 'antseed_buyer_peer_requests_total', help: 'Buyer all-time requests by seller peer.', type: 'counter', labels: { peer_id: peerId }, value: row.requests });
    addSample(samples, buyerLabels, { name: 'antseed_buyer_peer_tokens_total', help: 'Buyer all-time tokens by seller peer.', type: 'counter', labels: { peer_id: peerId }, value: row.tokens });
    addSample(samples, buyerLabels, { name: 'antseed_buyer_peer_channels_total', help: 'Buyer channel count by seller peer.', type: 'gauge', labels: { peer_id: peerId }, value: row.channels });
  }

  if (includeChain && wallet) {
    try {
      const { account, walletUsdc } = await chainBalances(configPath, wallet);
      addSample(samples, buyerLabels, { name: 'antseed_buyer_deposits_available_usdc', help: 'Buyer deposits available in the deposits contract.', type: 'gauge', value: microsToUsdc(account.available) });
      addSample(samples, buyerLabels, { name: 'antseed_buyer_deposits_reserved_usdc', help: 'Buyer deposits reserved in the deposits contract.', type: 'gauge', value: microsToUsdc(account.reserved) });
      addSample(samples, buyerLabels, { name: 'antseed_wallet_usdc', help: 'Wallet USDC balance.', type: 'gauge', value: microsToUsdc(walletUsdc) });
    } catch (error) {
      addSample(samples, buyerLabels, { name: 'antseed_chain_scrape_error', help: 'Whether chain balance collection failed.', type: 'gauge', labels: { error: error instanceof Error ? error.message : String(error) }, value: 1 });
    }
  }
}

/**
 * Whether the state file is from a seller that is running: a crashed or killed
 * seller leaves its last state behind, which must not read as live health.
 */
export function isLiveDaemon(daemon: Record<string, unknown> | null, now: number = Date.now()): boolean {
  const updatedAt = daemon?.updatedAt;
  return typeof updatedAt === 'number' && now - updatedAt < SELLER_STALE_MS;
}

/**
 * Model health and gas from the seller daemon's state file (absent on older
 * sellers), parsed like the dashboard does; none while the seller is not running.
 */
export function addSellerHealthMetrics(samples: MetricSample[], sellerLabels: Record<string, string>, daemon: Record<string, unknown> | null, now: number = Date.now()): void {
  if (!isLiveDaemon(daemon, now)) return;
  for (const service of parseModelHealth(daemon?.modelHealth)) {
    // `provider` is the configured provider name, so upstreams sharing a plugin get their own series.
    const serviceLabels = { provider: service.providerId, plugin: service.provider, service: service.service };
    addSample(samples, sellerLabels, { name: 'antseed_seller_model_advertised', help: 'Whether the service passes health checks and is advertised (0 = withdrawn after failing probes).', type: 'gauge', labels: serviceLabels, value: service.advertised ? 1 : 0 });
    addSample(samples, sellerLabels, { name: 'antseed_seller_model_consecutive_failures', help: 'Consecutive failed health probes for the service.', type: 'gauge', labels: serviceLabels, value: service.consecutiveFailures });
    if (service.lastStatusCode !== null) {
      addSample(samples, sellerLabels, { name: 'antseed_seller_model_last_status_code', help: 'HTTP status of the last failed upstream probe (e.g. 402 = upstream out of credit).', type: 'gauge', labels: serviceLabels, value: service.lastStatusCode });
    }
    if (service.lastProbeAt !== null) {
      addSample(samples, sellerLabels, { name: 'antseed_seller_model_last_probe_timestamp_seconds', help: 'Unix timestamp of the last health probe for the service.', type: 'gauge', labels: serviceLabels, value: Math.floor(service.lastProbeAt / 1000) });
    }
  }
  const gas = parseGas(daemon?.gas);
  if (gas && gas.balanceEth !== null) {
    addSample(samples, sellerLabels, { name: 'antseed_seller_gas_balance_eth', help: 'Seller wallet ETH balance from the last gas check.', type: 'gauge', value: gas.balanceEth });
    addSample(samples, sellerLabels, { name: 'antseed_seller_gas_min_balance_eth', help: 'ETH balance below which the seller pauses advertising.', type: 'gauge', value: gas.minBalanceEth });
    addSample(samples, sellerLabels, { name: 'antseed_seller_gas_depleted', help: 'Whether advertising is paused because the wallet is out of gas.', type: 'gauge', value: gas.depleted ? 1 : 0 });
  }
}

/** Chain RPC calls per source: this exporter's own, and the seller daemon's from its state file. */
export function addRpcMetrics(samples: MetricSample[], baseLabels: Record<string, string>, daemon: Record<string, unknown> | null, now: number = Date.now()): void {
  const help = 'Chain RPC calls made, by source (as asked, before coalescing and Multicall batching).';
  for (const [source, usage] of Object.entries(rpcUsage())) {
    addSample(samples, baseLabels, { name: 'antseed_rpc_calls_total', help, type: 'counter', labels: { source, process: 'exporter' }, value: usage.total });
  }
  // A stopped seller's counters would sit frozen; its series go away instead.
  const daemonRpc = isLiveDaemon(daemon, now) && daemon?.rpc && typeof daemon.rpc === 'object' ? daemon.rpc as Record<string, { total?: unknown }> : {};
  for (const [source, usage] of Object.entries(daemonRpc)) {
    addSample(samples, baseLabels, { name: 'antseed_rpc_calls_total', help, type: 'counter', labels: { source, process: 'seller' }, value: num(usage?.total) });
  }
}

const CHAIN_BALANCES_TTL_MS = 60_000;
let chainBalancesCache: { key: string; at: number; value: Promise<{ account: { available: bigint; reserved: bigint }; walletUsdc: bigint }> } | null = null;

/**
 * Deposits and wallet USDC for `--include-chain`: one client on the process's
 * shared provider (both reads batch into one Multicall3 call), and at most one
 * read a minute however often Prometheus scrapes.
 */
function chainBalances(configPath: string, wallet: string) {
  const key = `${configPath}|${wallet}`;
  if (chainBalancesCache && chainBalancesCache.key === key && Date.now() - chainBalancesCache.at < CHAIN_BALANCES_TTL_MS) return chainBalancesCache.value;
  const value = withRpcSource('metrics', async () => {
    const config = await loadConfig(configPath);
    const crypto = requireCryptoConfig(config);
    const deposits = createDepositsClient(config).withProvider(sharedChainProvider({ rpcUrl: crypto.rpcUrl, evmChainId: crypto.evmChainId, ...(crypto.fallbackRpcUrls ? { fallbackRpcUrls: crypto.fallbackRpcUrls } : {}) }));
    const [account, walletUsdc] = await Promise.all([deposits.getBuyerBalance(wallet), deposits.getUSDCBalance(wallet)]);
    return { account, walletUsdc };
  });
  chainBalancesCache = { key, at: Date.now(), value };
  value.catch(() => { if (chainBalancesCache?.value === value) chainBalancesCache = null; });
  return value;
}

async function addSellerMetrics(samples: MetricSample[], baseLabels: Record<string, string>, dataDir: string, daemon: Record<string, unknown> | null): Promise<void> {
  const wallet = await loadExistingWalletAddress(dataDir);
  const sellerLabels = { ...baseLabels, role: 'seller', wallet, peer_id: String(daemon?.peerId ?? '') };
  const allChannels = listChannels(dataDir, 1_000_000).filter((channel) => channel.role === 'seller');
  const dayStart = utcDayStartMs();

  addSample(samples, sellerLabels, {
    name: 'antseed_seller_channels_total',
    help: 'Seller payment channels by status from local channel store.',
    type: 'gauge',
    labels: { status: 'all' },
    value: allChannels.length,
  });
  for (const status of ['active', 'settled', 'timeout', 'ghost']) {
    addSample(samples, sellerLabels, {
      name: 'antseed_seller_channels_total',
      help: 'Seller payment channels by status from local channel store.',
      type: 'gauge',
      labels: { status },
      value: allChannels.filter((channel) => channel.status === status).length,
    });
  }

  const deliveredMicros = allChannels.reduce((sum, channel) => sum + num(channel.tokensDelivered), 0);
  const settledMicros = allChannels.reduce((sum, channel) => sum + num(channel.settledAmount), 0);
  const authorizedMicros = allChannels.reduce((sum, channel) => sum + num(channel.authMax), 0);
  const deliveredTodayMicros = allChannels
    .filter((channel) => channelEventMs(channel) >= dayStart)
    .reduce((sum, channel) => sum + num(channel.tokensDelivered), 0);
  const requests = allChannels.reduce((sum, channel) => sum + channel.requestCount, 0);
  const tokens = allChannels.reduce((sum, channel) => sum + num(channel.tokensDelivered), 0);

  addSample(samples, sellerLabels, { name: 'antseed_seller_payment_delivered_usdc_total', help: 'Seller all-time delivered payment amount from local payment channel ledger.', type: 'counter', value: microsToUsdc(deliveredMicros) });
  addSample(samples, sellerLabels, { name: 'antseed_seller_payment_delivered_today_usdc', help: 'Seller delivered payment amount since UTC day start.', type: 'gauge', value: microsToUsdc(deliveredTodayMicros) });
  addSample(samples, sellerLabels, { name: 'antseed_seller_payment_settled_usdc_total', help: 'Seller all-time settled payment amount from local payment channel ledger.', type: 'counter', value: microsToUsdc(settledMicros) });
  addSample(samples, sellerLabels, { name: 'antseed_seller_payment_authorized_usdc_total', help: 'Seller all-time authorized payment amount from local payment channel ledger.', type: 'counter', value: microsToUsdc(authorizedMicros) });
  addSample(samples, sellerLabels, { name: 'antseed_seller_channel_requests_total', help: 'Seller request count from local payment channel ledger.', type: 'counter', value: requests });
  addSample(samples, sellerLabels, { name: 'antseed_seller_channel_tokens_total', help: 'Seller delivered token/payment counter from local payment channel ledger.', type: 'counter', value: tokens });

  addSellerHealthMetrics(samples, sellerLabels, daemon);

  try {
    const meteringPath = join(dataDir, 'metering.db');
    if (!existsSync(meteringPath)) return;
    const metering = new MeteringStorage(meteringPath, { readonly: true });
    try {
      const totals = advanceMeteringTotals(meteringPath, metering);
      const today = Math.floor(Date.now() / DAY_MS);
      const todayEvents = totals.eventDays.get(today);
      const allSessions = metering.getSessionSummary(0, Date.now() + DAY_MS);
      const todaySessions = metering.getSessionSummary(dayStart, Date.now() + DAY_MS);

      addSample(samples, sellerLabels, { name: 'antseed_seller_metering_backfill_complete', help: 'Whether the exporter has read the whole metering ledger; metering totals are only reported once it has.', type: 'gauge', value: totals.caughtUp ? 1 : 0 });
      addSample(samples, sellerLabels, { name: 'antseed_seller_sessions_total', help: 'Seller metering session count.', type: 'counter', value: allSessions.channelCount });
      addSample(samples, sellerLabels, { name: 'antseed_seller_sessions_today', help: 'Seller metering session count since UTC day start.', type: 'gauge', value: todaySessions.channelCount });
      if (totals.caughtUp) {
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_requests_total', help: 'Seller metering event request count.', type: 'counter', value: totals.events.requests });
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_requests_today', help: 'Seller metering event request count since UTC day start.', type: 'gauge', value: todayEvents?.requests ?? 0 });
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_tokens_total', help: 'Seller metering event token count.', type: 'counter', value: totals.events.totalTokens });
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_tokens_today', help: 'Seller metering event token count since UTC day start.', type: 'gauge', value: todayEvents?.totalTokens ?? 0 });
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_input_tokens_total', help: 'Seller metering input token count.', type: 'counter', value: totals.events.inputTokens });
        addSample(samples, sellerLabels, { name: 'antseed_seller_metering_output_tokens_total', help: 'Seller metering output token count.', type: 'counter', value: totals.events.outputTokens });
        addSample(samples, sellerLabels, { name: 'antseed_seller_receipt_revenue_usd_total', help: 'Seller usage receipt revenue in USD from local metering ledger.', type: 'counter', value: totals.receiptCents / 100 });
        addSample(samples, sellerLabels, { name: 'antseed_seller_receipt_revenue_today_usd', help: 'Seller usage receipt revenue in USD since UTC day start.', type: 'gauge', value: (totals.receiptDays.get(today) ?? 0) / 100 });
      }
    } finally {
      metering.close();
    }
  } catch (error) {
    addSample(samples, sellerLabels, { name: 'antseed_seller_metering_scrape_error', help: 'Whether seller metering DB collection failed.', type: 'gauge', labels: { error: error instanceof Error ? error.message : String(error) }, value: 1 });
  }
}

/**
 * Rows read from each metering table per scrape. The ledger grows without
 * bound and lives on the seller's disk: one all-time SUM over millions of
 * rows took minutes, stalled the seller's own SQLite writes until its
 * liveness probe killed it, and blocked this exporter's /healthz. Totals are
 * instead kept here and advanced by rowid, a bounded chunk per scrape.
 */
const METERING_ROWS_PER_SCRAPE = 100_000;
/** UTC days of per-day totals kept for the *_today gauges. */
const METERING_DAYS_KEPT = 2;

interface EventTotals { requests: number; totalTokens: number; inputTokens: number; outputTokens: number }

interface MeteringTotals {
  /** Device and inode of the ledger file the totals were read from. */
  fileIdentity: string;
  eventsCursor: number;
  /** Ids of the rows at the cursors, to notice a ledger rebuilt in place. */
  eventsCheckpoint: string | null;
  receiptsCheckpoint: string | null;
  receiptsCursor: number;
  events: EventTotals;
  receiptCents: number;
  eventDays: Map<number, EventTotals>;
  receiptDays: Map<number, number>;
  caughtUp: boolean;
}

const meteringTotalsByPath = new Map<string, MeteringTotals>();

function emptyMeteringTotals(fileIdentity: string): MeteringTotals {
  return {
    fileIdentity,
    eventsCursor: 0,
    eventsCheckpoint: null,
    receiptsCheckpoint: null,
    receiptsCursor: 0,
    events: { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    receiptCents: 0,
    eventDays: new Map(),
    receiptDays: new Map(),
    caughtUp: false,
  };
}

function pruneDays<T>(days: Map<number, T>, today: number): void {
  for (const day of days.keys()) {
    if (day <= today - METERING_DAYS_KEPT) days.delete(day);
  }
}

/** Read the next chunk of new events and receipts into the running totals for `path`. */
export function advanceMeteringTotals(path: string, metering: MeteringStorage, rowsPerScrape = METERING_ROWS_PER_SCRAPE): MeteringTotals {
  const { dev, ino } = statSync(path);
  const fileIdentity = `${dev}:${ino}`;
  let totals = meteringTotalsByPath.get(path);
  if (!totals || ledgerChanged(totals, fileIdentity, metering)) {
    totals = emptyMeteringTotals(fileIdentity);
    meteringTotalsByPath.set(path, totals);
  }
  const max = metering.getMaxRowids();

  const events = metering.summarizeEventsAfter(totals.eventsCursor, rowsPerScrape);
  totals.eventsCursor = events.lastRowid;
  for (const day of events.days) {
    totals.events.requests += day.requests;
    totals.events.totalTokens += day.totalTokens;
    totals.events.inputTokens += day.inputTokens;
    totals.events.outputTokens += day.outputTokens;
    const kept = totals.eventDays.get(day.day) ?? { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    kept.requests += day.requests;
    kept.totalTokens += day.totalTokens;
    kept.inputTokens += day.inputTokens;
    kept.outputTokens += day.outputTokens;
    totals.eventDays.set(day.day, kept);
  }

  const receipts = metering.summarizeReceiptsAfter(totals.receiptsCursor, rowsPerScrape);
  totals.receiptsCursor = receipts.lastRowid;
  for (const day of receipts.days) {
    totals.receiptCents += day.costCents;
    totals.receiptDays.set(day.day, (totals.receiptDays.get(day.day) ?? 0) + day.costCents);
  }

  const today = Math.floor(Date.now() / DAY_MS);
  pruneDays(totals.eventDays, today);
  pruneDays(totals.receiptDays, today);
  const checkpoint = metering.getIdsAtRowids(totals.eventsCursor, totals.receiptsCursor);
  totals.eventsCheckpoint = checkpoint.eventId;
  totals.receiptsCheckpoint = checkpoint.receiptId;
  totals.caughtUp = totals.eventsCursor >= max.events && totals.receiptsCursor >= max.receipts;
  return totals;
}

/**
 * The totals no longer describe the ledger at this path: the file was
 * replaced (new inode), shrank below a cursor, or the row at a cursor now
 * holds a different id (rebuilt in place). A row at a cursor that is gone
 * (pruned) is not a change.
 */
function ledgerChanged(totals: MeteringTotals, fileIdentity: string, metering: MeteringStorage): boolean {
  if (totals.fileIdentity !== fileIdentity) return true;
  const max = metering.getMaxRowids();
  if (max.events < totals.eventsCursor || max.receipts < totals.receiptsCursor) return true;
  const current = metering.getIdsAtRowids(totals.eventsCursor, totals.receiptsCursor);
  return (current.eventId !== null && current.eventId !== totals.eventsCheckpoint)
    || (current.receiptId !== null && current.receiptId !== totals.receiptsCheckpoint);
}

async function collectMetrics(options: MetricsOptions, dataDir: string, configPath: string): Promise<string> {
  const role = (options.role ?? 'auto').toLowerCase();
  const instance = options.instance || process.env.ANTSEED_METRICS_INSTANCE || process.env.HOSTNAME || 'antseed';
  const baseLabels = { instance };
  const samples: MetricSample[] = [];

  // One snapshot per scrape: the seller rewrites the file every second.
  const daemon = await readDaemonState(dataDir);
  await addCommonMetrics(samples, baseLabels, daemon);
  if (role === 'buyer' || role === 'both' || role === 'auto') {
    await addBuyerMetrics(samples, baseLabels, dataDir, Boolean(options.includeChain), configPath).catch((error) => {
      addSample(samples, { ...baseLabels, role: 'buyer' }, { name: 'antseed_buyer_scrape_error', help: 'Whether buyer metrics collection failed.', type: 'gauge', labels: { error: error instanceof Error ? error.message : String(error) }, value: 1 });
    });
  }
  if (role === 'seller' || role === 'both' || role === 'auto') {
    await addSellerMetrics(samples, baseLabels, dataDir, daemon).catch((error) => {
      addSample(samples, { ...baseLabels, role: 'seller' }, { name: 'antseed_seller_scrape_error', help: 'Whether seller metrics collection failed.', type: 'gauge', labels: { error: error instanceof Error ? error.message : String(error) }, value: 1 });
    });
  }

  addRpcMetrics(samples, baseLabels, daemon);
  return renderPrometheus(samples);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

export function registerMetricsCommand(program: Command): void {
  const metricsCmd = program
    .command('metrics')
    .description('Prometheus metrics exporter for Antseed buyers and sellers');

  metricsCmd
    .command('serve')
    .description('Serve Antseed Prometheus metrics over HTTP')
    .option('--role <role>', 'metrics role: buyer, seller, both, auto', process.env.ANTSEED_METRICS_ROLE || 'auto')
    .option('--host <host>', 'listen host', process.env.ANTSEED_METRICS_HOST || '127.0.0.1')
    .option('--port <port>', 'listen port', process.env.ANTSEED_METRICS_PORT || '9108')
    .option('--path <path>', 'metrics path', process.env.ANTSEED_METRICS_PATH || '/metrics')
    .option('--instance <name>', 'instance label for Prometheus series')
    .option('--include-chain', 'include chain balance metrics; may add RPC latency', false)
    .action(async (options: MetricsOptions) => {
      const globalOpts = getGlobalOptions(metricsCmd);
      const host = options.host || '127.0.0.1';
      const port = Number(options.port || 9108);
      const metricsPath = options.path || '/metrics';
      if (!['buyer', 'seller', 'both', 'auto'].includes(String(options.role || 'auto'))) {
        console.error(chalk.red('Error: --role must be one of buyer, seller, both, auto'));
        process.exit(1);
      }

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
            if (url.pathname === '/healthz' || url.pathname === '/readyz') {
              send(res, 200, 'ok\n');
              return;
            }
            if (url.pathname !== metricsPath) {
              send(res, 404, 'not found\n');
              return;
            }
            const body = await collectMetrics(options, globalOpts.dataDir, globalOpts.config);
            send(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
          } catch (error) {
            send(res, 500, `metrics scrape failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        })();
      });

      server.listen(port, host, () => {
        console.log(chalk.green(`Antseed metrics exporter listening on http://${host}:${port}${metricsPath}`));
        console.log(chalk.dim(`role=${options.role || 'auto'} dataDir=${globalOpts.dataDir}`));
      });
    });
}
