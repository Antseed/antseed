import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { parseVerifierCapabilities } from '../../../plugins/verifier.js';
import { loadConfig } from '../../../config/loader.js';
import {
  AntseedNode,
  type PeerInfo,
} from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import { parsePersistedPeers } from '../../../proxy/buyer-proxy.js';
import { buildPaymentsConfig } from './chain-config-helper.js';
import { resolveEffectiveBuyerConfig } from '../../../config/effective.js';
import {
  collectServiceTags,
  parseTagFilter,
  serviceMatchesTagFilter,
} from './tag-filter.js';
import { formatUsdPerMillion as formatUsdPerMillionRaw } from './pricing-format.js';

interface PeerOptions {
  json?: boolean;
  tag?: string;
}

/**
 * Flat, machine-friendly representation of a single matching service for a
 * peer. Emitted in JSON output alongside the full `PeerInfo` when a tag
 * filter is in effect so callers can consume the narrowed set directly
 * without re-walking `providerPricing`.
 */
interface MatchingServiceEntry {
  provider: string;
  service: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  tags: string[];
  protocols: string[];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function loadPeersFromBuyerDaemon(dataDir: string): Promise<PeerInfo[] | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { state?: unknown; pid?: unknown };
    if (parsed.state !== 'connected') return null;
    if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null;
    const peers = parsePersistedPeers(parsed);
    return peers.length > 0 ? peers : null;
  } catch {
    return null;
  }
}

function normalizePeerId(raw: string): string | null {
  const cleaned = raw.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(cleaned)) return null;
  return cleaned;
}

function sellerAddressForPeer(peer: PeerInfo): string {
  return normalizePeerId(peer.metadata?.sellerContract ?? '') ?? peer.peerId;
}

function isDelegatedSeller(peer: PeerInfo): boolean {
  return sellerAddressForPeer(peer) !== peer.peerId.toLowerCase();
}

/**
 * The detail view doesn't have a column header so it appends `/1M` to make
 * each price self-describing. Precision is adaptive (see `pricing-format.ts`)
 * so sub-cent rates don't collapse to $0.00.
 */
function formatUsdPerMillion(value: number | undefined): string {
  return formatUsdPerMillionRaw(value, { withUnit: true });
}

function formatUsdcVolume(micros: number | undefined): string {
  if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) {
    return chalk.dim('—');
  }
  const usd = micros / 1_000_000;
  if (usd >= 1) return chalk.green(`$${usd.toFixed(2)} USDC`);
  if (usd > 0) return `$${usd.toFixed(6)} USDC`;
  return chalk.dim('$0 USDC');
}

function formatTimestampSec(sec: number | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    return chalk.dim('never');
  }
  const date = new Date(sec * 1000);
  const ageMs = Date.now() - sec * 1000;
  const ageMins = Math.max(0, Math.floor(ageMs / 60_000));
  const ageLabel =
    ageMins < 1 ? 'just now'
    : ageMins < 60 ? `${ageMins}m ago`
    : ageMins < 1440 ? `${Math.floor(ageMins / 60)}h ago`
    : `${Math.floor(ageMins / 1440)}d ago`;
  return `${date.toISOString()}  ${chalk.dim(`(${ageLabel})`)}`;
}

/**
 * One-line trust breakdown, e.g.
 * `65 = history 35 + usage 10 + power 5 + identity 15 github; not flagged`.
 * The node computes the score; this only renders `peer.trust`.
 */
function formatTrustLine(peer: PeerInfo): string {
  const trust = peer.trust;
  const score = peer.onChainReputationScore;
  if (!trust) return typeof score === 'number' && Number.isFinite(score) ? String(Math.round(score)) : chalk.dim('—');
  if (trust.washFlagged) return `${chalk.red('0')}  ${chalk.red('⚠ proven wash trader (on-chain registry) — trust 0')}`;
  const history = trust.history ? `history ${Math.round(trust.history.score)}` : chalk.dim('history —');
  const usage = trust.usage ? `usage ${Math.round(trust.usage.score)}` : chalk.dim('usage —');
  const power = trust.power ? `power ${Math.round(trust.power.score)}` : chalk.dim('power —');
  const identity = trust.identity ? `identity ${Math.round(trust.identity.score)} ${trust.identity.kind}` : chalk.dim('identity —');
  const flagged = trust.washFlagged === null ? chalk.dim('wash registry unavailable') : 'not flagged';
  return `${chalk.bold(String(Math.round(trust.score)))} = ${history} + ${usage} + ${power} + ${identity}; ${flagged}`;
}

/**
 * Build the machine-friendly list of (provider, service) entries on this
 * peer that match the given tag filter. When the filter is empty, every
 * announced service is returned. Services without any tags are excluded
 * when a filter is active — they can't match an opt-in tag constraint.
 */
function collectMatchingServices(peer: PeerInfo, requestedTags: Set<string>): MatchingServiceEntry[] {
  const out: MatchingServiceEntry[] = [];
  const pricing = peer.providerPricing;
  if (!pricing) return out;

  for (const [providerName, providerEntry] of Object.entries(pricing)) {
    const services = providerEntry.services ?? {};
    for (const [serviceName, servicePricing] of Object.entries(services)) {
      if (requestedTags.size > 0 && !serviceMatchesTagFilter(peer, providerName, serviceName, requestedTags)) {
        continue;
      }
      out.push({
        provider: providerName,
        service: serviceName,
        inputUsdPerMillion: Number.isFinite(servicePricing.inputUsdPerMillion) ? servicePricing.inputUsdPerMillion : null,
        outputUsdPerMillion: Number.isFinite(servicePricing.outputUsdPerMillion) ? servicePricing.outputUsdPerMillion : null,
        cachedInputUsdPerMillion: servicePricing.cachedInputUsdPerMillion ?? null,
        tags: collectServiceTags(peer, providerName, serviceName),
        protocols: (peer.providerServiceApiProtocols?.[providerName]?.services?.[serviceName] ?? []).slice(),
      });
    }
  }

  out.sort((a, b) => a.provider.localeCompare(b.provider) || a.service.localeCompare(b.service));
  return out;
}

/**
 * Print the human-readable peer detail page. When `requestedTags` is
 * non-empty, services that don't match the filter are hidden, providers
 * whose services all fall out are skipped entirely, and matching tags are
 * highlighted green so it's obvious why each surviving service is listed.
 */
function printPeerDetail(peer: PeerInfo, requestedTags: Set<string>): void {
  console.log('');
  console.log(chalk.bold('Peer'));
  console.log(`  ID:              ${peer.peerId}`);
  console.log(`  Display name:    ${peer.displayName ?? chalk.dim('—')}`);
  console.log(`  Public address:  ${peer.publicAddress ?? chalk.dim('—')}`);

  const verifiers = parseVerifierCapabilities(peer.capabilities);
  if (verifiers.supported.length > 0) {
    const list = verifiers.supported
      .map((id) => (id === verifiers.default ? `${id} ${chalk.dim('(default)')}` : id))
      .join(', ');
    console.log(`  Verifiers:       ${list}`);
  }

  const sellerAddress = sellerAddressForPeer(peer);
  if (isDelegatedSeller(peer)) {
    console.log(`  On-chain seller: ${chalk.yellow(sellerAddress)}`);
    console.log(chalk.dim('    (delegated/proxy seller — channel stats and payments are attributed to the seller address)'));
  } else {
    console.log(`  On-chain seller: ${chalk.dim('same as peer')}`);
  }

  if (typeof peer.lastSeen === 'number' && peer.lastSeen > 0) {
    const age = Date.now() - peer.lastSeen;
    console.log(`  Last seen:       ${new Date(peer.lastSeen).toISOString()} ${chalk.dim(`(${Math.max(0, Math.floor(age / 1000))}s ago)`)}`);
  }
  if (typeof peer.lastReachedAt === 'number' && peer.lastReachedAt > 0) {
    const age = Date.now() - peer.lastReachedAt;
    console.log(`  Last reached:    ${new Date(peer.lastReachedAt).toISOString()} ${chalk.dim(`(${Math.max(0, Math.floor(age / 1000))}s ago)`)}`);
  }

  console.log('');
  console.log(chalk.bold('Capacity'));
  const maxC = peer.maxConcurrency ?? null;
  const curL = peer.currentLoad ?? null;
  if (maxC !== null || curL !== null) {
    console.log(`  Load:            ${curL ?? '?'} / ${maxC ?? '?'}`);
  } else {
    console.log(`  Load:            ${chalk.dim('—')}`);
  }

  console.log('');
  console.log(chalk.bold('On-chain (AntseedChannels.getAgentStats)'));
  const channels = peer.onChainChannelCount;
  const ghosts = peer.onChainGhostCount;
  const vouchedBadge = (typeof channels === 'number' && channels > 0 && (ghosts ?? 0) === 0)
    ? chalk.green('  ✓ vouched')
    : '';
  console.log(`  Sessions:        ${typeof channels === 'number' ? chalk.cyan(String(channels)) : chalk.dim('—')}${vouchedBadge}`);
  console.log(`  Ghosts:          ${typeof ghosts === 'number' ? (ghosts === 0 ? chalk.dim('0') : chalk.red(String(ghosts))) : chalk.dim('—')}`);
  console.log(`  Volume:          ${formatUsdcVolume(peer.onChainTotalVolumeUsdcMicros)}`);
  console.log(`  Last settled:    ${formatTimestampSec(peer.onChainLastSettledAtSec)}`);
  console.log(`  Trust:           ${formatTrustLine(peer)}`);
  if (typeof peer.onChainStatsFetchedAt === 'number' && peer.onChainStatsFetchedAt > 0) {
    const age = Date.now() - peer.onChainStatsFetchedAt;
    console.log(`  ${chalk.dim(`Verified ${Math.max(0, Math.floor(age / 1000))}s ago by reading contract directly`)}`);
  } else {
    console.log(chalk.dim('  (on-chain stats unavailable — configure chain RPC to enable)'));
  }

  console.log('');
  const servicesHeader = requestedTags.size > 0
    ? chalk.bold('Providers & services') + chalk.dim(` (filtered by tag: ${Array.from(requestedTags).sort().join(', ')})`)
    : chalk.bold('Providers & services');
  console.log(servicesHeader);
  if (peer.providers.length === 0) {
    console.log(chalk.dim('  (none announced)'));
  } else {
    let renderedAnyProvider = false;
    for (const providerName of peer.providers) {
      const pricingEntry = peer.providerPricing?.[providerName];
      const protocolsEntry = peer.providerServiceApiProtocols?.[providerName];
      const categoriesEntry = peer.providerServiceCategories?.[providerName];

      const allServiceNames = pricingEntry?.services ? Object.keys(pricingEntry.services).sort() : [];
      const visibleServices = requestedTags.size === 0
        ? allServiceNames
        : allServiceNames.filter((serviceName) =>
            serviceMatchesTagFilter(peer, providerName, serviceName, requestedTags),
          );

      // Hide providers entirely when a filter is active and nothing matches —
      // showing an empty block would just be noise.
      if (requestedTags.size > 0 && visibleServices.length === 0) {
        continue;
      }
      renderedAnyProvider = true;

      console.log(`  ${chalk.cyan(providerName)}`);

      // Provider defaults only render when no tag filter is in effect —
      // defaults aren't tagged so they can't match.
      if (requestedTags.size === 0 && pricingEntry?.defaults) {
        const d = pricingEntry.defaults;
        console.log(`    defaults:        in ${formatUsdPerMillion(d.inputUsdPerMillion)}  out ${formatUsdPerMillion(d.outputUsdPerMillion)}`
          + (d.cachedInputUsdPerMillion != null ? `  cached-in ${formatUsdPerMillion(d.cachedInputUsdPerMillion)}` : ''));
      }

      if (visibleServices.length === 0) {
        console.log(chalk.dim('    (no services announced for this provider)'));
        continue;
      }
      for (const serviceName of visibleServices) {
        const s = pricingEntry!.services![serviceName]!;
        const protocols = protocolsEntry?.services?.[serviceName] ?? [];
        const categories = categoriesEntry?.services?.[serviceName] ?? [];
        const parts: string[] = [
          `in ${formatUsdPerMillion(s.inputUsdPerMillion)}`,
          `out ${formatUsdPerMillion(s.outputUsdPerMillion)}`,
        ];
        if (s.cachedInputUsdPerMillion != null) {
          parts.push(`cached-in ${formatUsdPerMillion(s.cachedInputUsdPerMillion)}`);
        }
        if (protocols.length > 0) parts.push(chalk.dim(`protocols: ${protocols.join(', ')}`));
        if (categories.length > 0) {
          const rendered = categories
            .map((t) => (requestedTags.has(t.toLowerCase()) ? chalk.green(t) : t))
            .join(', ');
          parts.push(chalk.dim('tags: ') + rendered);
        }
        console.log(`    ${serviceName.padEnd(28)} ${parts.join('  ')}`);
      }
    }
    if (requestedTags.size > 0 && !renderedAnyProvider) {
      console.log(chalk.dim(`  (no services match tag(s): ${Array.from(requestedTags).sort().join(', ')})`));
    }
  }

  console.log('');
  console.log(chalk.bold('Pin this peer'));
  console.log(`  antseed buyer connection set --peer ${peer.peerId}`);
  console.log(chalk.dim(`  or per-request:   curl -H "x-antseed-pin-peer: ${peer.peerId}" ...`));
  console.log('');
}

/**
 * Register the `antseed network peer <peerId>` command.
 */
export function registerNetworkPeerCommand(networkCmd: Command): void {
  networkCmd
    .command('peer <peerId>')
    .description('Show full details for a single peer (providers, services, on-chain stats)')
    .option(
      '-t, --tag <tags>',
      'show only services matching tag(s); comma-separated for OR match '
      + '(e.g. --tag coding,privacy). Well-known tags: privacy, legal, uncensored, coding, finance, tee',
    )
    .option('--json', 'output as JSON', false)
    .action(async (peerIdArg: string, options: PeerOptions) => {
      const normalized = normalizePeerId(peerIdArg);
      if (!normalized) {
        console.error(chalk.red('Error: peerId must be a 40-char hex EVM address (with or without 0x prefix).'));
        process.exit(1);
      }

      const tagFilter = parseTagFilter(options.tag);
      const globalOpts = getGlobalOptions(networkCmd);
      const config = await loadConfig(globalOpts.config);
      const effectiveBuyerConfig = resolveEffectiveBuyerConfig({ config });

      const cachedPeers = await loadPeersFromBuyerDaemon(globalOpts.dataDir);
      let match: PeerInfo | null =
        cachedPeers?.find((p) => p.peerId.toLowerCase() === normalized) ?? null;
      let sourceLabel = match ? 'buyer daemon cache' : '';

      // Fall back to a live DHT lookup when the cache misses or the daemon
      // isn't running. Prefer the per-peer topic (deterministic, one infohash)
      // over scanning the wildcard — the wildcard is saturated on a busy
      // network and routinely omits individual peers.
      if (!match) {
        const bootstrapNodes = config.network.bootstrapNodes.length > 0
          ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
          : undefined;
        const paymentsConfig = buildPaymentsConfig(config.payments?.crypto);
        const spinner = ora(`Looking up peer ${normalized.slice(0, 12)}...`).start();
        const node = new AntseedNode({
          role: 'buyer',
          ...(bootstrapNodes ? { bootstrapNodes } : {}),
          dhtOperationTimeoutMs: 30_000,
          metadataFetchTimeoutMs: effectiveBuyerConfig.metadataFetchTimeoutMs,
          ...(paymentsConfig ? { payments: paymentsConfig } : {}),
        });
        try {
          await node.start();
          match = await node.findPeer(normalized, { awaitExternalVerification: true });
          if (match) {
            spinner.succeed(chalk.green('Found via live DHT lookup'));
            sourceLabel = 'live DHT lookup';
          } else {
            spinner.fail(chalk.red(`Peer ${normalized} not announcing right now`));
          }
        } catch (err) {
          spinner.fail(chalk.red(`Discovery failed: ${(err as Error).message}`));
          try { await node.stop(); } catch { /* ignore */ }
          process.exit(1);
        }
        try { await node.stop(); } catch { /* ignore */ }
      }

      if (!match) {
        console.error(
          chalk.red(
            `Peer ${normalized} not found${sourceLabel ? ` (source: ${sourceLabel})` : ''}.`,
          ),
        );
        console.error(chalk.dim('Run `antseed network browse` to see all peers currently visible on the network.'));
        process.exit(1);
      }

      if (options.json) {
        // Always include `matchingServices` so callers can consume the flat,
        // filtered list without walking providerPricing themselves. When no
        // tag filter is in effect it simply contains every announced service.
        const matchingServices = collectMatchingServices(match, tagFilter);
        // Surface the on-chain seller address explicitly so JSON consumers don't
        // need to dig into `metadata.sellerContract` themselves.
        const sellerAddress = sellerAddressForPeer(match);
        console.log(JSON.stringify({
          source: sourceLabel,
          filter: tagFilter.size > 0 ? { tags: Array.from(tagFilter).sort() } : null,
          sellerAddress,
          isDelegatedSeller: isDelegatedSeller(match),
          peer: match,
          matchingServices,
        }, null, 2));
        return;
      }

      console.log(chalk.dim(`Source: ${sourceLabel}`));
      printPeerDetail(match, tagFilter);
    });
}
