import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import pkg from '../../../../package.json' with { type: 'json' };
import { resolveConfigPath } from '../../../config/loader.js';
import type { FreeTierProgramView, SellerFreeTierProgramPatch, SellerLogDetail, SellerSettingsPatch, SellerSettingsService, SellerUnitComponent } from '../../../gateway/console-api/types.js';
import { SellerMonitor } from '../../../seller-monitor/service.js';
import { unitPriceText } from '../../../seller-monitor/card.js';
import { getGlobalOptions } from '../types.js';

/**
 * `antseed seller events|usage|logs|market|reputation|promote|verify|settings`:
 * the seller dashboard's views and edits from the command line, through the
 * same SellerMonitor service the dashboard and the console call.
 */
/**
 * `antseed [--data-dir …] [--config …] seller <sub>` as this run was invoked, for
 * commands it prints to run next: a flag-chosen seller stays the one they read.
 */
export function sellerCommand(cmd: Command, sub: string): string {
  const opts = cmd.optsWithGlobals();
  const { dataDir, config } = getGlobalOptions(cmd);
  return ['antseed', ...(opts['dataDir'] ? [`--data-dir ${shellArg(dataDir)}`] : []), ...(opts['config'] ? [`--config ${shellArg(config)}`] : []), `seller ${sub}`].join(' ');
}

export function sellerMonitorFor(cmd: Command): SellerMonitor {
  const { dataDir, config } = getGlobalOptions(cmd);
  return new SellerMonitor({ dataDir: () => dataDir, configPath: () => resolveConfigPath(config), version: pkg.version });
}

/** Runs a command body: `--json` prints the result as is, errors print their message and exit 1. */
export async function runMonitorCommand<T>(json: boolean, work: () => Promise<T>, print: (value: T) => void): Promise<void> {
  try {
    const value = await work();
    if (json) console.log(JSON.stringify(value, null, 2));
    else print(value);
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exitCode = 1;
  }
}

/** A value safe to paste back into a shell. */
const shellArg = (value: string) => (/^[\w@./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
/** An amount of money ($0 is $0). */
const usd = (value: number | null) => (value === null ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`);
/** A price, where 0 means the model is free. */
const price = (value: number | null) => (value === 0 ? 'Free' : usd(value));
const pair = (input: number | null, output: number | null) => `${price(input)} / ${price(output)}`;
/** A unit-billed (image, video) price per unit, else input / output per million tokens. */
const offerPrice = (offer: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; unitPrice: { name: string; minUsd: number; maxUsd: number } | null }) =>
  offer.unitPrice ? unitPriceText(offer.unitPrice) : pair(offer.inputUsdPerMillion, offer.outputUsdPerMillion);
/** A market summary (cheapest, median): per unit when the model is compared per unit. */
const summaryPrice = (unitPrice: { name: string } | null, summary: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; unitUsd: number | null } | null) =>
  summary === null ? '—' : unitPrice !== null && summary.unitUsd !== null ? unitPriceText({ name: unitPrice.name, minUsd: summary.unitUsd, maxUsd: summary.unitUsd }) : pair(summary.inputUsdPerMillion, summary.outputUsdPerMillion);
const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—');
const short = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `antseed seller logs --id`: one request with its receipt, session and payment channel. */
function printLogDetail(entry: SellerLogDetail): void {
  const rows: Array<[string, string]> = [
    ['Id', entry.id],
    ['Time', when(entry.at)],
    ['Status', `${entry.statusCode}${entry.streaming ? ' (streamed)' : ''}`],
    ...(entry.error ? [['Error', entry.error] as [string, string]] : []),
    ['Model', entry.service ?? `${entry.provider} (model not recorded)`],
    ['Upstream', entry.provider],
    ['Buyer', entry.buyer],
    ['Latency', `${entry.latencyMs} ms`],
    ['Tokens', `${entry.inputTokens} in${entry.cachedInputTokens ? ` (${entry.cachedInputTokens} cached)` : ''} → ${entry.outputTokens} out, ${entry.exactTokens ? 'as the upstream reported' : 'estimated from body size'}`],
    ['Cost', usd(entry.costUsd)],
  ];
  if (entry.receipt) {
    const check = entry.receipt.buyerCheck;
    rows.push(['Receipt', `${entry.receipt.id} · ${entry.receipt.usdPerMillionTokens === 0 ? 'free' : `signed at $${entry.receipt.usdPerMillionTokens}/1M tokens`}`]);
    rows.push(['Buyer check', check ? `${check.signatureValid ? 'signature valid' : 'signature INVALID'} · buyer counted ${check.buyerTokens} tokens (${check.differencePercent.toFixed(1)}% off)${check.disputed ? ' · DISPUTED' : ''}` : 'not checked yet']);
  }
  const session = entry.session;
  rows.push(['Session', `${session.id} · request ${session.position}${session.requests ? ` of ${session.requests}` : ''}${session.costUsd !== null ? ` · ${usd(session.costUsd)} total` : ''}`]);
  const channel = entry.channel;
  rows.push(['Channel', channel
    ? `${channel.id} · ${channel.status} · opened ${when(channel.openedAt)} · ${usd(channel.deliveredUsd)} delivered of ${usd(channel.authorizedUsd)} authorized${channel.settledUsd !== null ? ` · ${usd(channel.settledUsd)} settled` : ''} · ${channel.requests} requests`
    : chalk.dim('none (free request, or no channel was open)')]);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`${chalk.bold(label.padEnd(width))}  ${value}`);
}

/** "30m", "6h", "2d" or an ISO date → Unix ms. */
export function parseSince(value: string, now = Date.now()): number {
  const match = /^(\d+)\s*([mhd])$/.exec(value.trim());
  if (match) return now - Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`--since: use 30m, 6h, 2d or a date, not "${value}"`);
  return parsed;
}

/**
 * "glm-5.3=0.7/2.2", "glm-5.3=0.7/2.2/0.08" or "glm-5.3=0.7/2.2/none" → a pricing entry (provider resolved
 * from the config). Without a third number the cached-input price stays as it is; "none" removes it.
 */
export function parsePrice(value: string): { service: string; input: number; output: number; cached?: number | null } {
  const match = /^([^=]+)=([\d.]+)\/([\d.]+)(?:\/([\d.]+|none))?$/.exec(value.trim());
  if (!match) throw new Error(`--price: use [<provider>/]<model>=<input>/<output>[/<cached>|/none] in USD per million tokens, not "${value}"`);
  const cached = match[4] === undefined ? {} : { cached: match[4] === 'none' ? null : Number(match[4]) };
  return { service: match[1]!.trim(), input: Number(match[2]), output: Number(match[3]), ...cached };
}

/** `--unit-price <[provider/]model[match]=usd>`: `wan-2.6[1080p]=0.08`, `veo[4k,audio]=0.4`, or `qwen-image=0.03` for a single price. */
export function parseUnitPrice(value: string): { service: string; match: string[] | null; priceUsd: number } {
  const parsed = /^([^=[\]]+)(?:\[([^\]]*)\])?=([\d.]+)$/.exec(value.trim());
  if (!parsed) throw new Error(`--unit-price: use [<provider>/]<model>[<match>]=<usd>, e.g. wan-2.6[1080p]=0.08, not "${value}"`);
  return { service: parsed[1]!.trim(), match: parsed[2] === undefined ? null : parsed[2].split(',').map((part) => part.trim()).filter(Boolean), priceUsd: Number(parsed[3]) };
}

/** The unit-billing component a `--unit-price` names: by its match values (`1080p`, `4k,audio`), or the only one. */
export function resolveUnitComponent(service: SellerSettingsService, match: string[] | null): SellerUnitComponent {
  const label = (component: SellerUnitComponent) => Object.entries(component.match ?? {}).map(([field, value]) => (value === true ? field : value === false ? `no ${field}` : String(value)))
  const found = match === null
    ? (service.unitComponents.length === 1 ? service.unitComponents : [])
    : service.unitComponents.filter((component) => label(component).join(',').toLowerCase() === match.join(',').toLowerCase());
  if (found.length === 1) return found[0]!;
  const choices = service.unitComponents.map((component) => `${service.service}[${label(component).join(',')}]`).join(', ');
  throw new Error(`--unit-price: ${service.service}${match ? `[${match.join(',')}]` : ''} names ${found.length === 0 ? 'no' : 'more than one'} unit price${choices ? `; its prices are ${choices}` : ' (it is not billed per unit)'}`);
}

/**
 * The offering a `--price` name means: `<provider>/<model>` picks one exactly;
 * a bare model must be offered by only one provider.
 */
export function resolvePriceTarget<T extends { provider: string; service: string }>(services: readonly T[], name: string, flag = '--price'): T {
  const exact = services.find((entry) => `${entry.provider}/${entry.service}` === name);
  if (exact) return exact;
  const matches = services.filter((entry) => entry.service === name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`${flag}: ${name} is not one of this seller's services`);
  throw new Error(`${flag}: ${name} is offered by more than one provider; name one: ${matches.map((entry) => `${entry.provider}/${entry.service}`).join(', ')}`);
}

/** `--json` on a subcommand whose parent also takes `--json` (commander gives it to the parent). */
export function jsonFlag(command: Command): boolean {
  return Boolean(command.optsWithGlobals()['json']);
}

const onOff = (value: string, flag: string): boolean => {
  if (value === 'on' || value === 'true') return true;
  if (value === 'off' || value === 'false') return false;
  throw new Error(`${flag}: use on or off`);
};
const limitOrNone = (value: string): number | null => (value === 'none' ? null : Number(value));

/** Tiers are staking power, ANTS × weeks of lock remaining; flags and output use ANTS locked for a year. */
const WEEKS_PER_YEAR = 52;

/**
 * `--free-stake-tiers 10000:5,50000:20,200000:unlimited` (ANTS locked for a
 * year : multiplier), `default` for the network's tiers, or `none`.
 */
export function parseStakeTiers(value: string): SellerFreeTierProgramPatch['stakeTiers'] {
  if (value === 'default') return null;
  if (value === 'none') return [];
  return value.split(',').map((part) => {
    const match = /^\s*(\d+(?:\.\d+)?):(\d+|unlimited)\s*$/.exec(part);
    if (!match) throw new Error(`--free-stake-tiers: use <ANTS for a year>:<multiplier|unlimited>,… or default or none, not "${part}"`);
    return { minPower: Math.round(Number(match[1]) * WEEKS_PER_YEAR), multiplier: match[2] === 'unlimited' ? 'unlimited' as const : Number(match[2]) };
  });
}

/**
 * `--model-free-tier [provider/]model=<per-address>/<per-ip>[/<hours>][/stakers]`
 * (`none` for no limit there) sets a model's own program; `=off` removes it.
 */
export function parseModelFreeTier(value: string): { service: string; freeTier: SellerFreeTierProgramPatch | null } {
  const at = value.lastIndexOf('=');
  const service = value.slice(0, at).trim();
  const spec = value.slice(at + 1).trim();
  const usage = `--model-free-tier: use [provider/]model=<per-address|none>/<per-ip|none>[/<hours>][/stakers] or model=off, not "${value}"`;
  if (at <= 0) throw new Error(usage);
  if (spec === 'off') return { service, freeTier: null };
  const parts = spec.split('/');
  const stakersOnly = parts.at(-1) === 'stakers';
  if (stakersOnly) parts.pop();
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part !== 'none' && !/^\d+(\.\d+)?$/.test(part))) throw new Error(usage);
  const hours = parts[2] === undefined ? undefined : limitOrNone(parts[2]);
  return {
    service,
    freeTier: {
      maxRequestsPerAddress: limitOrNone(parts[0]!), maxRequestsPerIp: limitOrNone(parts[1]!),
      ...(hours !== undefined ? { windowMs: hours === null ? null : Math.round(hours * 3_600_000) } : {}),
      stakersOnly,
    },
  };
}

/** One line for a program as buyers see it: "100/day per address, then paid · stakers: 10000 ANTS 5×, …". */
export function freeTierSummary(program: FreeTierProgramView | null, paid: boolean): string {
  if (!program) return paid ? '—' : 'free, no limit';
  const { maxRequestsPerAddress, maxRequestsPerIp, windowMs, stakersOnly } = program.base;
  const window = windowMs === 86_400_000 ? 'day' : `${+(windowMs / 3_600_000).toFixed(2)}h`;
  const limits = [maxRequestsPerAddress !== null ? `${maxRequestsPerAddress}/${window} per address` : null, maxRequestsPerIp !== null ? `${maxRequestsPerIp}/${window} per IP` : null].filter(Boolean).join(', ');
  const head = stakersOnly ? `stakers only (${limits} base)` : limits;
  const tiers = program.stakeTiers.map((tier) => `${Math.ceil(tier.minPower / WEEKS_PER_YEAR)} ANTS ${tier.multiplier === 'unlimited' ? 'unlimited' : `${tier.multiplier}×`}`).join(', ');
  return `${head}${paid ? ', then paid' : ''}${tiers ? ` · staked: ${tiers}` : ''}`;
}

export function registerSellerMonitorCommands(sellerCmd: Command): void {
  sellerCmd
    .command('events')
    .description('Recent seller events: starts and stops, models failing or recovered, gas, quiet periods')
    .option('--limit <n>', 'how many, newest first', '25')
    .option('--json', 'output as JSON', false)
    .action((options: { limit: string; json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).events(Number(options.limit) || 25), (events) => {
      if (events.length === 0) return console.log(chalk.dim('No events yet.'));
      for (const event of events) {
        const mark = event.severity === 'info' ? chalk.dim('·') : chalk.yellow('●');
        console.log(`${mark} ${chalk.dim(when(event.at))}  ${event.title}${event.detail ? chalk.dim(`\n    ${event.detail}`) : ''}`);
      }
    }));

  sellerCmd
    .command('usage')
    .description('Requests, tokens, sessions and revenue per UTC day, and payment channel totals')
    .option('--days <n>', 'days back, up to 30', '14')
    .option('--json', 'output as JSON', false)
    .action((options: { days: string; json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).usage(Number(options.days) || 14), (usage) => {
      const table = new Table({ head: ['Day (UTC)', 'Requests', 'Tokens', 'Sessions', 'Revenue'].map((h) => chalk.bold(h)) });
      for (const day of usage.days) table.push([new Date(day.day).toISOString().slice(0, 10), day.requests, day.tokens, day.sessions, usd(day.revenueUsd)]);
      console.log(table.toString());
      console.log(`Channels: ${usage.channels.active} open, ${usage.channels.settled} settled · settled ${usd(usage.settledUsdc)}, delivered ${usd(usage.deliveredUsdc)}`);
    }));

  sellerCmd
    .command('logs')
    .description('The request log from metering.db, newest first (failures included)')
    .option('--limit <n>', 'rows per page', '50')
    .option('--cursor <cursor>', 'continue from a previous page (printed at the end)')
    .option('--model <id>', 'only this model')
    .option('--buyer <peerId>', 'only this buyer')
    .option('--since <when>', 'only newer than 30m, 6h, 2d or a date')
    .option('--errors', 'only failed requests (HTTP 400 and above)', false)
    .option('--id <id>', 'everything kept about one request: receipt, session, payment channel (the Id column is enough)')
    .option('--json', 'output as JSON', false)
    .action((options: { limit: string; cursor?: string; model?: string; buyer?: string; since?: string; errors: boolean; id?: string; json: boolean }) => options.id
      ? runMonitorCommand(options.json, async () => {
        const entry = sellerMonitorFor(sellerCmd).logDetail(options.id!.trim());
        if (!entry) throw new Error(`No request with id ${options.id} (or several start with it: give more of the id)`);
        return entry;
      }, printLogDetail)
      : runMonitorCommand(options.json, async () => sellerMonitorFor(sellerCmd).logs({
      limit: Number(options.limit) || 50,
      cursor: options.cursor ?? null,
      service: options.model ?? null,
      buyer: options.buyer ?? null,
      from: options.since ? parseSince(options.since) : null,
      errorsOnly: options.errors,
    }), (page) => {
      // The next page keeps this page's seller, size and filters; --since is resolved to the time it meant.
      const logs = sellerCommand(sellerCmd, 'logs');
      const older = page.next ? [logs, ...(options.limit !== '50' ? [`--limit ${shellArg(options.limit)}`] : []), ...(options.model ? [`--model ${shellArg(options.model)}`] : []), ...(options.buyer ? [`--buyer ${shellArg(options.buyer)}`] : []),
        ...(options.since ? [`--since ${new Date(parseSince(options.since)).toISOString()}`] : []), ...(options.errors ? ['--errors'] : []), `--cursor ${page.next}`].join(' ') : null;
      if (page.entries.length === 0) {
        console.log(chalk.dim(older ? 'No matching requests among the latest scanned.' : 'No requests.'));
        if (older) console.log(chalk.dim(`Look further back: ${older}`));
        return;
      }
      const table = new Table({ head: ['Id', 'Time', 'Buyer', 'Model', 'In', 'Out', 'Cost', 'Latency', 'Status'].map((h) => chalk.bold(h)) });
      for (const entry of page.entries) {
        const status = entry.statusCode >= 400 || entry.error ? chalk.yellow(`${entry.statusCode}${entry.error ? ` ${clip(entry.error, 40)}` : ''}`) : String(entry.statusCode);
        table.push([chalk.dim(entry.id.slice(0, 8)), when(entry.at), short(entry.buyer), entry.service ?? chalk.dim(entry.provider), entry.inputTokens, entry.outputTokens, usd(entry.costUsd), `${entry.latencyMs} ms`, status]);
      }
      console.log(table.toString());
      if (older) console.log(chalk.dim(`Older: ${older}`));
      console.log(chalk.dim(`One request in full: ${logs} --id <Id>`));
    }));

  sellerCmd
    .command('market')
    .description('Your prices against every other seller of the same model')
    .option('--model <id>', 'list every seller of this model')
    .option('--refresh', 'rediscover the network instead of reusing a recent snapshot', false)
    .option('--json', 'output as JSON', false)
    .action((options: { model?: string; refresh: boolean; json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).market({ wait: true, refresh: options.refresh }), (market) => {
      console.log(chalk.dim(`${market.network.peers} sellers, from ${market.network.source ?? 'nowhere'}${market.network.error ? ` (${market.network.error})` : ''}`));
      const table = new Table({ head: ['Model', 'Your price', 'Others', 'Cheapest', 'Median', 'Rank', 'vs median'].map((h) => chalk.bold(h)) });
      for (const service of market.services) {
        table.push([service.service, offerPrice(service.mine), market.network.peers === 0 ? '—' : service.unique ? 'only you' : service.competitors,
          summaryPrice(service.mine.unitPrice, service.cheapest),
          summaryPrice(service.mine.unitPrice, service.median),
          service.rank === null ? '—' : `${service.rank} of ${service.of}`, service.deltaPct === null ? '—' : `${service.deltaPct > 0 ? '+' : ''}${service.deltaPct}%`]);
      }
      console.log(table.toString());
      const focus = options.model ? market.services.find((service) => service.service === options.model) : null;
      if (focus) {
        const offers = new Table({ head: ['Seller', 'Input / output', 'Cached', 'Trust', 'TEE', 'Load'].map((h) => chalk.bold(h)) });
        for (const offer of focus.offers) offers.push([`${offer.mine ? '→ ' : ''}${offer.name ?? short(offer.peerId)}`, offerPrice(offer), price(offer.cachedInputUsdPerMillion), offer.trustScore === null ? '—' : Math.round(offer.trustScore), offer.tee ? 'TEE' : '', offer.load === null ? '—' : `${Math.round(offer.load * 100)}%`]);
        console.log(offers.toString());
      }
      if (market.notOffered.length > 0) console.log(chalk.dim(`Others also sell: ${market.notOffered.map((entry) => `${entry.service} (${entry.sellers})`).join(', ')}`));
    }));

  sellerCmd
    .command('reputation')
    .description('Your trust score part by part, how to raise it, and your on-chain standing')
    .option('--refresh', 'rediscover the network and re-read the chain', false)
    .option('--json', 'output as JSON', false)
    .action((options: { refresh: boolean; json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).reputation({ wait: true, refresh: options.refresh }), (reputation) => {
      const trust = reputation.trust;
      if (!trust) console.log(chalk.yellow('No trust score yet: this seller was not found on the network, or nothing about it is on-chain.'));
      else {
        console.log(`${chalk.bold('Trust score')} ${trust.washFlagged ? 0 : trust.score.toFixed(1)} / 100${reputation.rank ? chalk.dim(`  (#${reputation.rank.position} of ${reputation.rank.of})`) : ''}`);
        const part = (label: string, value: { score: number; max: number } | null) => console.log(`  ${label.padEnd(18)} ${value ? `${value.score.toFixed(1)} / ${value.max}` : '—'}`);
        part('Service history', trust.history); part('Recognized usage', trust.usage); part('Staking power', trust.power); part('Verified identity', trust.identity); part('Free model bonus', trust.freeModels);
      }
      if (reputation.steps.length) console.log(`\n${chalk.bold('How to raise it')}\n${reputation.steps.map((step, index) => `  ${index + 1}. ${step.text}`).join('\n')}`);
      const standing = reputation.standing;
      if (standing) console.log(`\n${chalk.bold('On-chain')}  agent ${standing.agentId || '—'} · ${standing.eligible ? 'eligible' : 'not eligible'} · pool stake ${standing.poolActiveStake} ANTS${Number(standing.minPoolStake) > 0 ? ` (min ${standing.minPoolStake})` : ''} · pending rewards ${standing.pendingRewards ?? '—'} ANTS`);
      else if (reputation.standingError) console.log(chalk.dim(`\nOn-chain standing unavailable: ${reputation.standingError}`));
    }));

  sellerCmd
    .command('promote')
    .description('Your explorer profile, pinned model ids and a shareable seller card')
    .option('--card <file>', 'write the seller card as SVG')
    .option('--json', 'output as JSON', false)
    .action((options: { card?: string; json: boolean }) => runMonitorCommand(options.json, async () => {
      const monitor = sellerMonitorFor(sellerCmd);
      // One discovery for the trust score, shared by the card and the profile.
      if (options.card) await writeFile(options.card, await monitor.card({ wait: true, startChecks: false }));
      return monitor.promote({ wait: true, startChecks: false });
    }, (promote) => {
      if (promote.profileUrl) console.log(`${chalk.bold('Profile')}  ${promote.profileUrl}`);
      if (promote.peerId) console.log(`${chalk.bold('Pinned model ids')}\n${promote.services.map((service) => `  ${promote.peerId}@${service.service}`).join('\n')}`);
      if (options.card) console.log(chalk.green(`Seller card written to ${options.card}`));
    }));

  sellerCmd
    .command('verify')
    .description('Domain and GitHub verification: the proof to publish, and live checks')
    .option('--add-domain <domain>', 'add a domain claim')
    .option('--add-github <user[/repo]>', 'add a GitHub claim')
    .option('--remove <claim>', 'remove a domain or GitHub username')
    .option('--check', 'run the checks buyers run, now', false)
    .option('--json', 'output as JSON', false)
    .action((options: { addDomain?: string; addGithub?: string; remove?: string; check: boolean; json: boolean }) => runMonitorCommand(options.json, async () => {
      const monitor = sellerMonitorFor(sellerCmd);
      if (options.addDomain || options.addGithub || options.remove) {
        const current = await monitor.promote({ network: false, startChecks: false });
        const removed = options.remove?.toLowerCase();
        const domains = current.domains.map(({ domain }) => domain).filter((domain) => domain !== removed);
        if (options.addDomain) domains.push(options.addDomain);
        const github = current.github.map(({ username, repository }) => ({ username, repository })).filter((entry) => entry.username.toLowerCase() !== removed);
        if (options.addGithub) {
          const [username, repository] = options.addGithub.replace(/^@/, '').split('/');
          github.push({ username: username!, repository: repository || username! });
        }
        await monitor.saveVerifications({ domains: domains.map((domain) => ({ domain })), github }, { network: false, startChecks: false });
      }
      return options.check ? monitor.checkVerifications({ network: false }) : monitor.promote({ network: false, startChecks: false });
    }, (promote) => {
      if (promote.domains.length === 0 && promote.github.length === 0) return console.log(chalk.dim('No claims. Add one with --add-domain or --add-github.'));
      const status = (value: { verified: boolean; error: string | null } | null) => (!value ? chalk.dim('not checked') : value.verified ? chalk.green('verified') : chalk.yellow(`not verified: ${value.error ?? ''}`));
      for (const claim of promote.domains) console.log(`${chalk.bold(claim.domain)}  ${status(claim.status)}\n  DNS TXT ${claim.txtName} = ${claim.txtValue}\n  or serve ${claim.wellKnownUrl}`);
      for (const claim of promote.github) console.log(`${chalk.bold(`github.com/${claim.username}`)}  ${status(claim.status)}\n  commit antseed.json to github.com/${claim.username}/${claim.repository}:\n${claim.proofBody.replace(/^/gm, '    ')}`);
      console.log(chalk.dim('Claims are announced after a seller restart.'));
    }));

  const settings = sellerCmd
    .command('settings')
    .description('The seller settings the dashboard edits (show with no subcommand)')
    .option('--json', 'output as JSON', false)
    .action((options: { json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).settings(), ({ settings: view }) => {
      console.log(`${chalk.bold(view.displayName || '(no display name)')}  ${chalk.dim(view.configPath)}${view.writable ? '' : chalk.yellow(`  read-only: ${view.readOnlyReason}`)}`);
      if (view.overridden.length > 0) console.log(chalk.yellow(`Saved over the config file (${view.overridesPath}): ${view.overridden.join(', ')}. \`seller settings reset\` drops them.`));
      else if (view.savesTo === 'overrides') console.log(chalk.dim(`The config file is read-only here: changes are saved in ${view.overridesPath} and apply over it.`));
      console.log(`Max concurrent buyers ${view.maxConcurrentBuyers} · health checks ${view.healthCheck.enabled ? `every ${view.healthCheck.intervalMs / 1000}s, withdraw after ${view.healthCheck.failureThreshold}` : 'off'} · gas checks ${view.gasCheck.enabled ? `min ${view.gasCheck.minBalanceEth} ETH` : 'off'}`);
      console.log(`Refused countries ${view.restrictedCountries.join(', ') || 'none'}${view.restrictedCountriesDefault ? chalk.dim(' (built-in)') : ''}`);
      const wide = view.freeTier;
      const wideTiers = wide.stakeTiers === null ? 'network default tiers' : wide.stakeTiers.length === 0 ? 'no staked tiers' : `tiers ${wide.stakeTiers.map((tier) => `${Math.ceil(tier.minPower / WEEKS_PER_YEAR)}:${tier.multiplier}`).join(',')}`;
      console.log(`Free tier (free models) ${wide.maxRequestsPerAddress === null && wide.maxRequestsPerIp === null ? 'no limits' : `${wide.maxRequestsPerAddress ?? '—'} per address, ${wide.maxRequestsPerIp ?? '—'} per IP per ${(wide.windowMs ?? 86_400_000) / 3_600_000}h`}${wide.stakersOnly ? ', stakers only' : ''} · ${wideTiers}`);
      const table = new Table({ head: ['Model', 'Provider', 'Input', 'Output', 'Cached', 'Free tier'].map((h) => chalk.bold(h)) });
      for (const service of view.services) {
        const free = freeTierSummary(service.freeTier, service.paid);
        // An image or video model bills per unit; its zero token prices would read as free.
        const tokens = service.unitPrice ? [unitPriceText(service.unitPrice), '—', '—'] : [price(service.inputUsdPerMillion), price(service.outputUsdPerMillion), price(service.cachedInputUsdPerMillion)];
        table.push([service.enabled ? service.service : chalk.dim(`${service.service} (off)`), service.provider, ...tokens, service.ownFreeTier ? free : chalk.dim(free)]);
      }
      console.log(table.toString());
    }));

  settings
    .command('set')
    .description('Change seller settings (validated; saved in the config file, or over it in the data dir when it is read-only; restart the seller to apply)')
    .option('--display-name <name>')
    .option('--max-buyers <n>')
    .option('--health <on|off>')
    .option('--health-interval <seconds>')
    .option('--health-failures <n>')
    .option('--gas <on|off>')
    .option('--gas-min <eth>')
    .option('--free-per-address <n|none>')
    .option('--free-per-ip <n|none>')
    .option('--free-window-hours <hours|none>')
    .option('--free-stakers-only <on|off>', 'serve free models only to buyers whose stake reaches a tier')
    .option('--free-stake-tiers <ants:x,…|default|none>', 'staked tiers, as ANTS locked for a year : multiplier, e.g. 10000:5,50000:20,200000:unlimited')
    .option('--model-free-tier <[provider/]model=address/ip[/hours][/stakers]|model=off>', "a model's own free tier (a free allowance on a paid model); repeatable", (value: string, all: string[] = []) => [...all, value])
    .option('--countries <codes|default>', 'comma-separated ISO codes, "" for none, or default')
    .option('--price <[provider/]model=in/out[/cached]>', 'USD per million tokens (cached kept unless given; /none removes it); repeatable. Name the provider when two offer the model', (value: string, all: string[] = []) => [...all, value])
    .option('--unit-price <[provider/]model[match]=usd>', 'a per-image or per-video price, e.g. wan-2.6[1080p]=0.08; repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--model-off <[provider/]model>', 'stop offering a model, keeping its settings; repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--model-on <[provider/]model>', 'offer a model turned off again; repeatable', (value: string, all: string[] = []) => [...all, value])
    .option('--json', 'output as JSON', false)
    .action((options: Record<string, string | string[] | boolean | undefined>, command: Command) => runMonitorCommand(jsonFlag(command), async () => {
      const monitor = sellerMonitorFor(sellerCmd);
      const patch: SellerSettingsPatch = {};
      const text = (key: string) => (typeof options[key] === 'string' ? options[key] as string : undefined);
      if (text('displayName') !== undefined) patch.displayName = text('displayName');
      if (text('maxBuyers') !== undefined) patch.maxConcurrentBuyers = Number(text('maxBuyers'));
      if (text('health') !== undefined || text('healthInterval') !== undefined || text('healthFailures') !== undefined) {
        patch.healthCheck = {
          ...(text('health') !== undefined ? { enabled: onOff(text('health')!, '--health') } : {}),
          ...(text('healthInterval') !== undefined ? { intervalMs: Number(text('healthInterval')) * 1000 } : {}),
          ...(text('healthFailures') !== undefined ? { failureThreshold: Number(text('healthFailures')) } : {}),
        };
      }
      if (text('gas') !== undefined || text('gasMin') !== undefined) {
        patch.gasCheck = { ...(text('gas') !== undefined ? { enabled: onOff(text('gas')!, '--gas') } : {}), ...(text('gasMin') !== undefined ? { minBalanceEth: Number(text('gasMin')) } : {}) };
      }
      if (['freePerAddress', 'freePerIp', 'freeWindowHours', 'freeStakersOnly', 'freeStakeTiers'].some((key) => text(key) !== undefined)) {
        const hours = text('freeWindowHours') === undefined ? undefined : limitOrNone(text('freeWindowHours')!);
        patch.freeTier = {
          ...(text('freePerAddress') !== undefined ? { maxRequestsPerAddress: limitOrNone(text('freePerAddress')!) } : {}),
          ...(text('freePerIp') !== undefined ? { maxRequestsPerIp: limitOrNone(text('freePerIp')!) } : {}),
          ...(hours !== undefined ? { windowMs: hours === null ? null : Math.round(hours * 3_600_000) } : {}),
          ...(text('freeStakersOnly') !== undefined ? { stakersOnly: onOff(text('freeStakersOnly')!, '--free-stakers-only') } : {}),
          ...(text('freeStakeTiers') !== undefined ? { stakeTiers: parseStakeTiers(text('freeStakeTiers')!) } : {}),
        };
      }
      if (text('countries') !== undefined) patch.restrictedCountries = text('countries') === 'default' ? null : text('countries')!.split(',').map((code) => code.trim()).filter(Boolean);
      const prices = Array.isArray(options.price) ? options.price : [];
      const modelFree = Array.isArray(options.modelFreeTier) ? options.modelFreeTier : [];
      const unitPrices = Array.isArray(options.unitPrice) ? options.unitPrice : [];
      const modelsOff = Array.isArray(options.modelOff) ? options.modelOff : [];
      const modelsOn = Array.isArray(options.modelOn) ? options.modelOn : [];
      if (prices.length > 0 || modelFree.length > 0 || unitPrices.length > 0 || modelsOff.length > 0 || modelsOn.length > 0) {
        const { settings: view } = await monitor.settings();
        // One entry per model: a price and a free tier for the same model go together.
        const entries = new Map<string, NonNullable<SellerSettingsPatch['pricing']>[number]>();
        const entryFor = (name: string, flag: string) => {
          const service = resolvePriceTarget(view.services, name, flag);
          const key = `${service.provider}/${service.service}`;
          if (!entries.has(key)) entries.set(key, { provider: service.provider, service: service.service });
          return entries.get(key)!;
        };
        for (const entry of prices.map(parsePrice)) {
          Object.assign(entryFor(entry.service, '--price'), {
            inputUsdPerMillion: entry.input, outputUsdPerMillion: entry.output,
            ...(entry.cached !== undefined ? { cachedInputUsdPerMillion: entry.cached } : {}),
          });
        }
        for (const { service, freeTier } of modelFree.map(parseModelFreeTier)) entryFor(service, '--model-free-tier').freeTier = freeTier;
        for (const name of modelsOff) entryFor(name, '--model-off').enabled = false;
        for (const name of modelsOn) entryFor(name, '--model-on').enabled = true;
        for (const { service, match, priceUsd } of unitPrices.map(parseUnitPrice)) {
          const component = resolveUnitComponent(resolvePriceTarget(view.services, service, '--unit-price'), match);
          const entry = entryFor(service, '--unit-price');
          entry.unitPrices = [...(entry.unitPrices ?? []), { protocol: component.protocol, unit: component.unit, match: component.match, priceUsd }];
        }
        patch.pricing = [...entries.values()];
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass at least one option (see --help).');
      return monitor.updateSettings(patch);
    }, (result) => console.log(chalk.green(result.settings.savesTo === 'overrides'
      ? `Saved ${result.changed.join(', ')} in ${result.settings.overridesPath} (over the read-only config file). Restart the seller to apply.`
      : `Saved ${result.changed.join(', ')}. Restart the seller to apply; the previous config is kept as config.json.bak.`))));

  settings
    .command('add-model <model>')
    .description('Add a model billed by tokens under a configured provider ([provider/]model; the provider is needed when there are several)')
    .requiredOption('--input <usd>', 'USD per million input tokens')
    .requiredOption('--output <usd>', 'USD per million output tokens')
    .option('--cached <usd>', 'USD per million cached input tokens')
    .option('--upstream <id>', "the model id the provider's API knows it by (default: the model id)")
    .option('--categories <list>', 'comma-separated tags, e.g. chat,coding')
    .option('--json', 'output as JSON', false)
    .action((name: string, options: { input: string; output: string; cached?: string; upstream?: string; categories?: string }, command: Command) => runMonitorCommand(jsonFlag(command), async () => {
      const monitor = sellerMonitorFor(sellerCmd);
      const { settings: view } = await monitor.settings();
      const slash = name.indexOf('/');
      const named = slash > 0 && view.providers.some((provider) => provider.name === name.slice(0, slash)) ? name.slice(0, slash) : null;
      const tokenProviders = view.providers.filter((provider) => !provider.unitBilled && !provider.singleService);
      const provider = named ?? (tokenProviders.length === 1 ? tokenProviders[0]!.name : null);
      if (!provider) throw new Error(`Name the provider: <provider>/<model>, one of ${tokenProviders.map((entry) => entry.name).join(', ') || '(none bill by tokens)'}`);
      return monitor.updateSettings({ addServices: [{
        provider, service: named ? name.slice(slash + 1) : name,
        inputUsdPerMillion: Number(options.input), outputUsdPerMillion: Number(options.output),
        ...(options.cached !== undefined ? { cachedInputUsdPerMillion: Number(options.cached) } : {}),
        ...(options.upstream ? { upstreamModel: options.upstream } : {}),
        ...(options.categories ? { categories: options.categories.split(',') } : {}),
      }] });
    }, () => console.log(chalk.green(`Added ${name}. Restart the seller to offer it.`))));

  settings
    .command('remove-model <model>')
    .description("Remove a model from the config, with its prices and own free tier ([provider/]model). To keep its settings, use `settings set --model-off` instead")
    .option('--json', 'output as JSON', false)
    .action((name: string, _options: unknown, command: Command) => runMonitorCommand(jsonFlag(command), async () => {
      const monitor = sellerMonitorFor(sellerCmd);
      const { settings: view } = await monitor.settings();
      const service = resolvePriceTarget(view.services, name, 'remove-model');
      return monitor.updateSettings({ removeServices: [{ provider: service.provider, service: service.service }] });
    }, () => console.log(chalk.green(`Removed ${name}. The seller stops offering it when it restarts.`))));

  settings
    .command('reset')
    .description('Drop the settings saved over a read-only config file (the dashboard\'s overrides); the config file applies alone from the next restart')
    .option('--json', 'output as JSON', false)
    .action((options: { json: boolean }) => runMonitorCommand(options.json, () => sellerMonitorFor(sellerCmd).resetOverrides(),
      () => console.log(chalk.green('Removed the saved settings. The config file applies alone from the seller\'s next restart.'))));
}
