import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { parseVerifierCapabilities } from '../../../plugins/verifier.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  AntseedNode,
  buildNetworkServiceOffers,
  type NetworkServiceOffer,
  type PeerInfo,
} from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import {
  collectPeerVerificationLinks,
  type PeerVerificationLink,
} from '@antseed/node/discovery';
import { parsePersistedPeers } from '../../../proxy/buyer-proxy.js';
import { buildPaymentsConfig } from './chain-config-helper.js';
import { resolveEffectiveBuyerConfig } from '../../../config/effective.js';
import {
  collectServiceTags,
  parseTagFilter,
  peerMatchesTagFilter,
  serviceMatchesTagFilter,
} from './tag-filter.js';
import { formatUsdPerMillion } from './pricing-format.js';

type PeerSortKey = 'score' | 'volume' | 'sessions' | 'price' | 'recent';

interface BrowseOptions {
  service?: string;
  tag?: string;
  json?: boolean;
  services?: boolean;
  sort?: string;
  top?: string;
}

interface BrowseSnapshot {
  peers: PeerInfo[];
  onChainStatsRefreshedAt: number | null;
  sourceLabel: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a snapshot from a live buyer daemon. Returns `null` unless the daemon is
 * connected, its PID is alive, and the persisted peer list is non-empty.
 */
async function loadSnapshotFromBuyerState(dataDir: string): Promise<BrowseSnapshot | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      state?: unknown;
      pid?: unknown;
      onChainStatsRefreshedAt?: unknown;
    };
    if (parsed.state !== 'connected') return null;
    if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null;
    const peers = parsePersistedPeers(parsed);
    if (peers.length === 0) return null;
    const refreshedAt = typeof parsed.onChainStatsRefreshedAt === 'number'
      && Number.isFinite(parsed.onChainStatsRefreshedAt)
      ? parsed.onChainStatsRefreshedAt
      : null;
    return {
      peers,
      onChainStatsRefreshedAt: refreshedAt,
      sourceLabel: `buyer daemon (pid ${parsed.pid})`,
    };
  } catch {
    return null;
  }
}

const offersByPeer = new WeakMap<PeerInfo, NetworkServiceOffer[]>();
function peerServiceOffers(peer: PeerInfo): NetworkServiceOffer[] {
  let offers = offersByPeer.get(peer);
  if (!offers) {
    offers = buildNetworkServiceOffers([peer]);
    offersByPeer.set(peer, offers);
  }
  return offers;
}

function offerServiceLabel(offer: NetworkServiceOffer): string {
  return offer.serviceId === offer.provider ? '(default)' : offer.serviceId;
}

/**
 * An offer counts as "free" when input, output, and (if announced)
 * cached-input prices are all exactly $0. Undefined input/output prices are
 * "unknown", not free — those are handled separately by the formatter.
 */
function isFreeOffer(offer: NetworkServiceOffer): boolean {
  return (
    offer.inputUsdPerMillion === 0
    && offer.outputUsdPerMillion === 0
    && (offer.cachedInputUsdPerMillion === undefined || offer.cachedInputUsdPerMillion === 0)
  );
}

/**
 * Derive the set of service names this peer offers, flattened across all its
 * providers, in stable (sorted) order.
 */
function collectServiceNames(peer: PeerInfo): string[] {
  const names = new Set<string>();
  for (const offer of peerServiceOffers(peer)) {
    if (offer.serviceId === offer.provider) continue;
    const trimmed = offer.serviceId.trim();
    if (trimmed.length > 0) names.add(trimmed);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Collect the names of free (both input and output = $0/1M) services a peer
 * offers. Used to populate the optional "Free" column.
 */
function collectFreeServiceNames(peer: PeerInfo): string[] {
  const names = new Set<string>();
  for (const offer of peerServiceOffers(peer)) {
    if (isFreeOffer(offer)) names.add(offerServiceLabel(offer));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function normalizeServiceSearchTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/([a-z])m(?=\d)/g, '$1');
}

function serviceSearchTerms(value: string): string[] {
  const raw = value.trim().toLowerCase();
  const normalized = normalizeServiceSearchTerm(value);
  return Array.from(new Set([raw, normalized].filter((term) => term.length > 0)));
}

function serviceNameMatchesFilter(name: string, filter: string): boolean {
  const haystackTerms = serviceSearchTerms(name);
  const needleTerms = serviceSearchTerms(filter);
  if (needleTerms.length === 0) return true;
  return needleTerms.some((needle) => haystackTerms.some((haystack) => haystack.includes(needle)));
}

/**
 * Check whether the peer matches a `--service` filter. Matches on provider
 * name OR any announced service name using a forgiving normalized substring
 * comparison so common spelling variants like `minimax-3`, `minimax m3`, and
 * `MiniMax M3` match the canonical `minimax-m3` service id.
 */
export function peerMatchesServiceFilter(peer: PeerInfo, filter: string): boolean {
  if (filter.trim().length === 0) return true;
  if (peer.providers.some((p) => serviceNameMatchesFilter(p, filter))) return true;
  return collectServiceNames(peer).some((name) => serviceNameMatchesFilter(name, filter));
}

/**
 * Determine the cheapest *paid* input/output price pair across all services.
 * Free services (input=output=0) are deliberately excluded from these
 * columns — they are surfaced in a dedicated "Free" column when present —
 * so the In/Out $/1M columns always reflect the cheapest paid option a peer
 * offers. If every candidate is free or unknown, the result is `null`.
 *
 * CAVEAT: the returned input and output are picked independently across
 * services. A peer with serviceA=$1/$2 and serviceB=$2/$1 is rendered as
 * $1/$1 — a lower-bound approximation, not a real single-service offer.
 * Use `antseed network browse --services` or `antseed network peer <id>`
 * for per-service pricing when exact comparison matters.
 */
function resolveBestPaidPricing(peer: PeerInfo): { input: number | null; output: number | null } {
  let bestInput: number | null = null;
  let bestOutput: number | null = null;
  for (const offer of peerServiceOffers(peer)) {
    if (isFreeOffer(offer)) continue;
    const input = offer.inputUsdPerMillion;
    const output = offer.outputUsdPerMillion;
    if (input !== undefined && Number.isFinite(input) && input > 0) {
      if (bestInput === null || input < bestInput) bestInput = input;
    }
    if (output !== undefined && Number.isFinite(output) && output > 0) {
      if (bestOutput === null || output < bestOutput) bestOutput = output;
    }
  }
  // Top-level defaults are only used when we have nothing else — and only if
  // they are positive (non-free).
  if (bestInput === null && Number.isFinite(peer.defaultInputUsdPerMillion) && (peer.defaultInputUsdPerMillion ?? 0) > 0) {
    bestInput = peer.defaultInputUsdPerMillion ?? null;
  }
  if (bestOutput === null && Number.isFinite(peer.defaultOutputUsdPerMillion) && (peer.defaultOutputUsdPerMillion ?? 0) > 0) {
    bestOutput = peer.defaultOutputUsdPerMillion ?? null;
  }
  return { input: bestInput, output: bestOutput };
}

/** Buyer trust score (0-100) as computed by the node; the CLI never re-scores. */
function effectiveOnChainReputationScore(peer: PeerInfo): number | null {
  return peer.onChainReputationScore ?? null;
}

const BROWSE_SYBIL_WARN_THRESHOLD = 0.30;

function isPeerSybilRisky(peer: PeerInfo): boolean {
  return typeof peer.onChainSybilRisk === 'number'
    && peer.onChainSybilRisk >= BROWSE_SYBIL_WARN_THRESHOLD;
}

/** Proven wash trader per `AntseedWashTradingRegistry`; the trust score is 0. */
function isPeerWashFlagged(peer: PeerInfo): boolean {
  return peer.onChainWashFlagged === true;
}

function formatReputationScore(peer: PeerInfo): string {
  const score = effectiveOnChainReputationScore(peer);
  if (score == null) return chalk.dim('—');
  const formatted = (score / 10).toFixed(1);
  const warn = isPeerSybilRisky(peer) || isPeerWashFlagged(peer) ? chalk.red('⚠ ') : '';
  if (score >= 80) return warn + chalk.green(formatted);
  if (score >= 50) return warn + chalk.cyan(formatted);
  if (score > 0)   return warn + chalk.yellow(formatted);
  return warn + chalk.dim('0.0');
}

function peerReputationScore(peer: PeerInfo): number {
  return effectiveOnChainReputationScore(peer) ?? -1;
}

type PeerInfoJson = Omit<PeerInfo, 'onChainReputationScore'> & {
  onChainReputationScore: number | null;
  sellerAddress: string;
  isDelegatedSeller: boolean;
  verificationLinks: PeerVerificationLink[];
};

function normalizeAddressHex(raw: string | undefined): string | null {
  const normalized = raw?.trim().replace(/^0x/i, '').toLowerCase();
  return normalized && /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

/**
 * Derive the on-chain seller address for a peer. When the peer announces a
 * `sellerContract` in its metadata (delegated/proxy sellers), that address
 * is the actual on-chain seller; otherwise the peer's own address is the seller.
 */
function sellerAddressForPeer(peer: PeerInfo): string {
  return normalizeAddressHex(peer.metadata?.sellerContract) ?? peer.peerId;
}

function delegatedSellerAddress(peer: PeerInfo): string | null {
  const sellerAddress = sellerAddressForPeer(peer);
  const peerAddress = normalizeAddressHex(peer.peerId) ?? peer.peerId.toLowerCase();
  return sellerAddress !== peerAddress ? sellerAddress : null;
}

function formatVerificationLinks(peer: PeerInfo): string {
  const links = collectPeerVerificationLinks(peer);
  if (links.length === 0) return chalk.dim('—');
  return links
    .map((link) => {
      if (link.kind === 'domain') {
        return `${chalk.cyan('🌐')} ${chalk.underline(link.href)}`;
      }
      return `${chalk.magenta('GH')} ${chalk.underline(link.href)}`;
    })
    .join('\n');
}

function peerWithReputationScore(peer: PeerInfo): PeerInfoJson {
  const sellerAddress = sellerAddressForPeer(peer);
  return {
    ...peer,
    onChainReputationScore: effectiveOnChainReputationScore(peer),
    sellerAddress,
    isDelegatedSeller: delegatedSellerAddress(peer) !== null,
    verificationLinks: collectPeerVerificationLinks(peer),
  };
}

function formatUsdcVolume(micros: number | undefined | null): string {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) {
    return chalk.dim('—');
  }
  const usd = micros / 1_000_000;
  if (usd >= 1000) return chalk.green(`$${usd.toFixed(0)}`);
  if (usd >= 1) return chalk.green(`$${usd.toFixed(2)}`);
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return chalk.dim('$0');
}

function formatAge(sec: number | undefined | null): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    return chalk.dim('never');
  }
  const nowMs = Date.now();
  const ageMs = nowMs - sec * 1000;
  if (ageMs < 0) return chalk.dim('just now');
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatHumanAgeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Mark a peer as "vouched" when its reputation score is high enough to avoid
 * contradicting the score column. Rendered as a ✓ next to its peer id in the table.
 */
function isPeerVouched(peer: PeerInfo): boolean {
  const score = effectiveOnChainReputationScore(peer) ?? 0;
  return score >= 10;
}

function sortPeers(peers: PeerInfo[], sortKey: PeerSortKey): PeerInfo[] {
  const copy = [...peers];
  copy.sort((a, b) => {
    switch (sortKey) {
      case 'score': {
        const sa = peerReputationScore(a);
        const sb = peerReputationScore(b);
        if (sa !== sb) return sb - sa;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
      case 'volume': {
        const va = a.onChainTotalVolumeUsdcMicros ?? -1;
        const vb = b.onChainTotalVolumeUsdcMicros ?? -1;
        if (va !== vb) return vb - va;
        return (b.onChainChannelCount ?? 0) - (a.onChainChannelCount ?? 0);
      }
      case 'sessions': {
        const ca = a.onChainChannelCount ?? -1;
        const cb = b.onChainChannelCount ?? -1;
        if (ca !== cb) return cb - ca;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
      case 'price': {
        const pa = resolveBestPaidPricing(a).input ?? Number.POSITIVE_INFINITY;
        const pb = resolveBestPaidPricing(b).input ?? Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
      case 'recent': {
        const ra = a.onChainLastSettledAtSec ?? 0;
        const rb = b.onChainLastSettledAtSec ?? 0;
        if (ra !== rb) return rb - ra;
        return (b.onChainTotalVolumeUsdcMicros ?? 0) - (a.onChainTotalVolumeUsdcMicros ?? 0);
      }
    }
  });
  return copy;
}

function parseSortKey(raw: string | undefined): PeerSortKey {
  const normalized = (raw ?? 'score').trim().toLowerCase();
  if (normalized === 'score' || normalized === 'sessions' || normalized === 'price' || normalized === 'recent' || normalized === 'volume') {
    return normalized;
  }
  return 'score';
}

function parseTopLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? 20 : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}

/**
 * Render the default compact table: one row per peer with aggregate metrics.
 * Full peer ids are printed so the output is directly copy-pasteable into
 * `antseed buyer connection set --peer <id>` without any truncation.
 * The "Free" column is only emitted when at least one displayed peer has
 * free services; otherwise it's omitted so the common-case table stays
 * compact.
 *
 * A "Seller" column is added when at least one displayed peer has a
 * `sellerContract` that differs from its peerId (delegated/proxy sellers).
 */
function renderCompactTable(peers: PeerInfo[], hasChainData: boolean): void {
  const freeNamesByPeer = new Map(
    peers.map((peer) => [peer.peerId, collectFreeServiceNames(peer)] as const),
  );
  const anyFreeService = Array.from(freeNamesByPeer.values()).some((names) => names.length > 0);

  // Show the "Seller" column when at least one peer has a sellerContract
  // that differs from its peerId (i.e. a delegated/proxy seller).
  const anyDelegatedSeller = peers.some((peer) => delegatedSellerAddress(peer) !== null);
  const anyVerificationLinks = peers.some((peer) => collectPeerVerificationLinks(peer).length > 0);
  const anyVerifiers = peers.some((peer) => parseVerifierCapabilities(peer.capabilities).supported.length > 0);

  const head: string[] = [
    chalk.bold('Peer'),
  ];
  if (anyDelegatedSeller) head.push(chalk.bold('On-chain seller'));
  head.push(
    chalk.bold('Name'),
  );
  if (anyVerificationLinks) head.push(chalk.bold('Verified'));
  if (anyVerifiers) head.push(chalk.bold('Verifier'));
  head.push(
    chalk.bold('Providers'),
    chalk.bold('Services'),
    chalk.bold('Min In $/1M'),
    chalk.bold('Min Out $/1M'),
  );
  if (anyFreeService) head.push(chalk.bold('Free'));
  head.push(
    chalk.bold('Score'),
    chalk.bold('Sessions'),
    chalk.bold('Volume'),
    chalk.bold('Last settled'),
    chalk.bold('Load'),
  );

  const table = new Table({ head, wordWrap: true });

  for (const peer of peers) {
    const services = collectServiceNames(peer);
    const servicesCell = services.length === 0
      ? chalk.dim('—')
      : services.length <= 2
        ? services.join(', ')
        : `${services.slice(0, 2).join(', ')} ${chalk.dim(`+${services.length - 2}`)}`;
    const pricing = resolveBestPaidPricing(peer);

    const sessionsCell = typeof peer.onChainChannelCount === 'number'
      ? (peer.onChainChannelCount > 0 ? chalk.cyan(String(peer.onChainChannelCount)) : chalk.dim('0'))
      : chalk.dim('—');

    const load = peer.currentLoad !== undefined && peer.maxConcurrency !== undefined
      ? `${peer.currentLoad}/${peer.maxConcurrency}`
      : chalk.dim('—');

    const badge = isPeerVouched(peer) ? chalk.green(' ✓') : '';
    const peerCell = peer.peerId + badge;

    const sellerAddress = delegatedSellerAddress(peer);
    const sellerCell = sellerAddress !== null ? chalk.yellow(sellerAddress) : chalk.dim('—');

    const freeNames = freeNamesByPeer.get(peer.peerId) ?? [];
    const freeCell = freeNames.length === 0
      ? chalk.dim('—')
      : freeNames.length <= 2
        ? chalk.green(freeNames.join(', '))
        : chalk.green(`${freeNames.slice(0, 2).join(', ')}`) + chalk.dim(` +${freeNames.length - 2}`);

    const row: string[] = [
      peerCell,
    ];
    if (anyDelegatedSeller) row.push(sellerCell);
    row.push(
      peer.displayName ?? chalk.dim('—'),
    );
    if (anyVerificationLinks) row.push(formatVerificationLinks(peer));
    if (anyVerifiers) {
      const v = parseVerifierCapabilities(peer.capabilities);
      row.push(
        v.supported.length === 0
          ? chalk.dim('—')
          : (v.default ?? v.supported[0]!) + (v.supported.length > 1 ? chalk.dim(` +${v.supported.length - 1}`) : ''),
      );
    }
    row.push(
      peer.providers.join(', ') || chalk.dim('—'),
      servicesCell,
      formatUsdPerMillion(pricing.input),
      formatUsdPerMillion(pricing.output),
    );
    if (anyFreeService) row.push(freeCell);
    row.push(
      formatReputationScore(peer),
      sessionsCell,
      formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
      formatAge(peer.onChainLastSettledAtSec ?? null),
      load,
    );

    table.push(row);
  }

  console.log('');
  console.log(table.toString());
  if (!hasChainData) {
    console.log(chalk.dim('  Sessions / Volume / Last settled are dim — configure chain RPC to enable on-chain verification.'));
  }
  const washFlagged = peers.filter(isPeerWashFlagged);
  if (washFlagged.length > 0) {
    console.log(`  ${chalk.red('⚠')} ${chalk.red(`${washFlagged.length} peer(s) are proven wash traders (on-chain registry) — trust 0`)}${chalk.dim(`: ${washFlagged.map((peer) => peer.peerId.slice(0, 12)).join(', ')}`)}`);
  }
  const anySybilWarn = peers.some(isPeerSybilRisky);
  if (anySybilWarn) {
    console.log(chalk.dim(`  ${chalk.red('⚠')} peers triggered on-chain sybil heuristics. Run ${chalk.bold('antseed network peer <id>')} for the per-signal breakdown.`));
  }
  if (anyFreeService) {
    console.log(chalk.dim('  Free column lists services a peer offers at $0 input, cached-input, and output. "Min In/Out $/1M" always reflects the cheapest PAID option.'));
  }
  if (anyDelegatedSeller) {
    console.log(chalk.dim(`  ${chalk.yellow('On-chain seller')} is the contract address that receives payments — differs from Peer when a delegated/proxy operator runs the node.`));
  }
  if (anyVerificationLinks) {
    console.log(chalk.dim(`  Verified shows buyer-verified external claims: ${chalk.cyan('🌐')} domain, ${chalk.magenta('GH')} GitHub.`));
  }
  console.log('');
}

/**
 * Render the expanded "one row per (peer, provider, service)" table. Adds a
 * `Tags` column when at least one displayed (peer, service) pair has tags —
 * handy both for exploring categories and for verifying a `--tag` filter
 * actually matched the services you expected.
 *
 * When `requestedTags` is non-empty:
 *   - Services that don't match any requested tag are skipped.
 *   - Tagless fallback rows (peers with no `providerPricing` entries; or a
 *     provider with no services, rendered as a synthetic `(default)` row)
 *     are skipped entirely — they can't match an opt-in tag constraint,
 *     and surfacing them would contradict the `peer` detail command and
 *     mislead callers auditing a filtered view.
 *   - Matching tags inside the `Tags` cell are highlighted green.
 */
function renderExpandedTable(peers: PeerInfo[], requestedTags: Set<string>): void {
  const rows: Array<{
    peerId: string;
    provider: string;
    service: string;
    input: string;
    output: string;
    score: string;
    sessions: string;
    volume: string;
    tags: string[];
  }> = [];

  const hasTagFilter = requestedTags.size > 0;

  // Show the "Seller" column when at least one peer has a sellerContract
  // that differs from its peerId (i.e. a delegated/proxy seller).
  const anyDelegatedSeller = peers.some((peer) => delegatedSellerAddress(peer) !== null);
  const anyVerificationLinks = peers.some((peer) => collectPeerVerificationLinks(peer).length > 0);

  for (const peer of peers) {
    const offers = [...peerServiceOffers(peer)].sort((a, b) => (
      a.provider.localeCompare(b.provider) || a.serviceId.localeCompare(b.serviceId)
    ));
    for (const offer of offers) {
      const isFallbackRow = offer.serviceId === offer.provider;
      if (hasTagFilter && isFallbackRow) continue;
      if (hasTagFilter && !serviceMatchesTagFilter(peer, offer.provider, offer.serviceId, requestedTags)) {
        continue;
      }
      rows.push({
        peerId: peer.peerId,
        provider: offer.provider,
        service: offerServiceLabel(offer),
        input: formatUsdPerMillion(offer.inputUsdPerMillion ?? null),
        output: formatUsdPerMillion(offer.outputUsdPerMillion ?? null),
        score: formatReputationScore(peer),
        sessions: typeof peer.onChainChannelCount === 'number' ? String(peer.onChainChannelCount) : '—',
        volume: formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros ?? null),
        tags: collectServiceTags(peer, offer.provider, offer.serviceId),
      });
    }
  }

  const anyTags = rows.some((r) => r.tags.length > 0);

  const head: string[] = [
    chalk.bold('Peer'),
  ];
  if (anyDelegatedSeller) head.push(chalk.bold('On-chain seller'));
  if (anyVerificationLinks) head.push(chalk.bold('Verified'));
  head.push(
    chalk.bold('Provider'),
    chalk.bold('Service'),
    chalk.bold('In $/1M'),
    chalk.bold('Out $/1M'),
    chalk.bold('Score'),
    chalk.bold('Sessions'),
    chalk.bold('Volume'),
  );
  if (anyTags) head.push(chalk.bold('Tags'));

  const table = new Table({ head, wordWrap: true });

  for (const r of rows) {
    const row: string[] = [
      r.peerId,
    ];
    if (anyDelegatedSeller) {
      const rowPeer = peers.find((p) => p.peerId === r.peerId);
      const sellerAddress = rowPeer ? delegatedSellerAddress(rowPeer) : null;
      row.push(sellerAddress !== null ? chalk.yellow(sellerAddress) : chalk.dim('—'));
    }
    if (anyVerificationLinks) {
      const rowPeer = peers.find((p) => p.peerId === r.peerId);
      row.push(rowPeer ? formatVerificationLinks(rowPeer) : chalk.dim('—'));
    }
    row.push(
      r.provider,
      r.service === '—' || r.service === '(default)' ? chalk.dim(r.service) : r.service,
      r.input,
      r.output,
      r.score,
      r.sessions === '—' ? chalk.dim('—') : r.sessions,
      r.volume,
    );
    if (anyTags) {
      row.push(
        r.tags.length === 0
          ? chalk.dim('—')
          : r.tags
            .map((t) => (requestedTags.has(t) ? chalk.green(t) : t))
            .join(', '),
      );
    }
    table.push(row);
  }

  console.log('');
  console.log(table.toString());
  if (anyTags && requestedTags.size > 0) {
    console.log(chalk.dim(`  Matching tags highlighted green: ${Array.from(requestedTags).sort().join(', ')}`));
  }
  if (anyDelegatedSeller) {
    console.log(chalk.dim(`  ${chalk.yellow('On-chain seller')} is the contract address that receives payments — differs from Peer when a delegated/proxy operator runs the node.`));
  }
  if (anyVerificationLinks) {
    console.log(chalk.dim(`  Verified shows buyer-verified external claims: ${chalk.cyan('🌐')} domain, ${chalk.magenta('GH')} GitHub.`));
  }
  console.log('');
}

/**
 * Register the `antseed network browse` command.
 */
export function registerNetworkBrowseCommand(networkCmd: Command): void {
  networkCmd
    .command('browse')
    .description('Browse peers on the network — prices, services, and on-chain settlements')
    .option('-s, --service <service>', 'filter by service or provider name')
    .option(
      '-t, --tag <tags>',
      'filter by service category tag(s); comma-separated for OR match '
      + '(e.g. --tag tee,privacy). Well-known tags: privacy, legal, uncensored, coding, finance, tee',
    )
    .option('--services', 'expand to one row per (peer, provider, service) with per-service pricing', false)
    .option('--sort <key>', 'sort by score | volume | sessions | price | recent (default: score)')
    .option('--top <n>', 'show only the top N peers (default: 20)')
    .option('--json', 'output as JSON', false)
    .action(async (rawOptions: BrowseOptions) => {
      const globalOpts = getGlobalOptions(networkCmd);
      const config = await loadConfig(globalOpts.config);
      const effectiveBuyerConfig = resolveEffectiveBuyerConfig({ config });
      const serviceFilter = rawOptions.service?.trim();
      const tagFilter = parseTagFilter(rawOptions.tag);
      const sortKey = parseSortKey(rawOptions.sort);
      const topLimit = parseTopLimit(rawOptions.top);

      let snapshot = await loadSnapshotFromBuyerState(globalOpts.dataDir);

      if (!snapshot) {
        const bootstrapNodes = config.network.bootstrapNodes.length > 0
          ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
          : undefined;

        const spinner = ora('Discovering peers on the network...').start();
        const paymentsConfig = buildPaymentsConfig(config.payments?.crypto);

        const node = new AntseedNode({
          role: 'buyer',
          ...(bootstrapNodes ? { bootstrapNodes } : {}),
          dhtOperationTimeoutMs: 30_000,
          metadataFetchTimeoutMs: effectiveBuyerConfig.metadataFetchTimeoutMs,
          ...(paymentsConfig ? { payments: paymentsConfig } : {}),
        });

        try {
          await node.start();
        } catch (err) {
          spinner.fail(chalk.red(`Failed to connect to network: ${(err as Error).message}`));
          process.exit(1);
        }

        try {
          const peers = await node.discoverPeers(serviceFilter);
          spinner.succeed(chalk.green(`Found ${peers.length} peer(s)`));
          // Only stamp `onChainStatsRefreshedAt` when the enrichment loop
          // could actually have run — otherwise we'd display a misleading
          // "On-chain stats as of just now" header on top of a table that
          // has "—" in every on-chain column. Derive it from the per-peer
          // timestamps so we reflect only real RPC reads.
          const latestChainStamp = peers
            .map((p) => p.onChainStatsFetchedAt ?? 0)
            .reduce((max, v) => (v > max ? v : max), 0);
          snapshot = {
            peers,
            onChainStatsRefreshedAt: latestChainStamp > 0 ? latestChainStamp : null,
            sourceLabel: 'live DHT discovery',
          };
        } catch (err) {
          spinner.fail(chalk.red(`Discovery failed: ${(err as Error).message}`));
          await node.stop();
          return;
        }

        await node.stop();
      }

      let peers = snapshot.peers;
      if (serviceFilter) {
        peers = peers.filter((peer) => peerMatchesServiceFilter(peer, serviceFilter));
      }
      if (tagFilter.size > 0) {
        peers = peers.filter((peer) => peerMatchesTagFilter(peer, tagFilter));
      }

      if (peers.length === 0) {
        const filters = [
          serviceFilter ? '--service' : null,
          tagFilter.size > 0 ? '--tag' : null,
        ].filter((x): x is string => x !== null);
        const hint = filters.length > 0
          ? `Try adjusting ${filters.join(' / ')} or widening your search.`
          : 'Try again later once more peers announce.';
        console.log(chalk.dim(`No peers found. ${hint}`));
        return;
      }

      peers = sortPeers(peers, sortKey);
      const truncated = peers.length > topLimit;
      const displayed = truncated ? peers.slice(0, topLimit) : peers;

      if (rawOptions.json) {
        console.log(JSON.stringify({
          source: snapshot.sourceLabel,
          onChainStatsRefreshedAt: snapshot.onChainStatsRefreshedAt,
          sort: sortKey,
          filters: {
            service: serviceFilter ?? null,
            tags: tagFilter.size > 0 ? Array.from(tagFilter).sort() : null,
          },
          total: peers.length,
          peers: displayed.map((peer) => peerWithReputationScore(peer)),
        }, null, 2));
        return;
      }

      const filterBits: string[] = [];
      if (serviceFilter) filterBits.push(`service="${serviceFilter}"`);
      if (tagFilter.size > 0) filterBits.push(`tags=[${Array.from(tagFilter).sort().join(',')}]`);
      const filterSuffix = filterBits.length > 0 ? ` • filter: ${filterBits.join(' ')}` : '';
      console.log(chalk.dim(`Source: ${snapshot.sourceLabel} • ${peers.length} peer(s)${truncated ? ` (showing top ${topLimit})` : ''} • sort: ${sortKey}${filterSuffix}`));
      if (snapshot.onChainStatsRefreshedAt) {
        const ageMs = Date.now() - snapshot.onChainStatsRefreshedAt;
        console.log(chalk.dim(`On-chain stats as of ${formatHumanAgeMs(ageMs)}`));
      }

      const hasChainData = displayed.some((peer) => typeof peer.onChainChannelCount === 'number');

      if (rawOptions.services) {
        renderExpandedTable(displayed, tagFilter);
      } else {
        renderCompactTable(displayed, hasChainData);
      }

      const topPeer = displayed[0];
      if (topPeer) {
        const exampleService = collectServiceNames(topPeer)[0];
        console.log(chalk.bold('Use a model (auto-selects the best peer, no pin needed):'));
        console.log(`  curl -s localhost:8377/v1/models | jq '.data[].id'   ${chalk.dim('# every model on the network')}`);
        if (exampleService) {
          console.log(chalk.dim(`  then request it:  curl localhost:8377/v1/chat/completions -d '{"model": "${exampleService}", ...}'`));
        }
        console.log(chalk.bold('Or force this seller:'));
        console.log(`  antseed buyer connection set --peer ${topPeer.peerId}`);
        console.log(chalk.dim(`  or per-request:   curl -H "x-antseed-pin-peer: ${topPeer.peerId}" ...`));
        console.log(chalk.dim(`  full details:     antseed network peer ${topPeer.peerId}`));
        console.log('');
      }
    });
}
