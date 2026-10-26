import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import pkg from '../../../../package.json' with { type: 'json' };
import { resolveConfigPath } from '../../../config/loader.js';
import type { SellerLogDetail, SellerSettingsPatch } from '../../../gateway/console-api/types.js';
import { SellerMonitor } from '../../../seller-monitor/service.js';
import { getGlobalOptions } from '../types.js';

/**
 * `antseed seller events|usage|logs|market|reputation|promote|verify|settings`:
 * the seller dashboard's views and edits from the command line, through the
 * same SellerMonitor service the dashboard and the console call.
 */
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

const usd = (value: number | null) => (value === null ? '—' : value === 0 ? 'Free' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`);
const pair = (input: number | null, output: number | null) => `${usd(input)} / ${usd(output)}`;
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

/** "glm-5.3=0.7/2.2" or "glm-5.3=0.7/2.2/0.08" → a pricing entry (provider resolved from the config). */
export function parsePrice(value: string): { service: string; input: number; output: number; cached: number | null } {
  const match = /^([^=]+)=([\d.]+)\/([\d.]+)(?:\/([\d.]+))?$/.exec(value.trim());
  if (!match) throw new Error(`--price: use [<provider>/]<model>=<input>/<output>[/<cached>] in USD per million tokens, not "${value}"`);
  return { service: match[1]!.trim(), input: Number(match[2]), output: Number(match[3]), cached: match[4] === undefined ? null : Number(match[4]) };
}

/**
 * The offering a `--price` name means: `<provider>/<model>` picks one exactly;
 * a bare model must be offered by only one provider.
 */
export function resolvePriceTarget<T extends { provider: string; service: string }>(services: readonly T[], name: string): T {
  const exact = services.find((entry) => `${entry.provider}/${entry.service}` === name);
  if (exact) return exact;
  const matches = services.filter((entry) => entry.service === name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`--price: ${name} is not one of this seller's services`);
  throw new Error(`--price: ${name} is offered by more than one provider; name one: ${matches.map((entry) => `${entry.provider}/${entry.service}`).join(', ')}`);
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

export function registerSellerMonitorCommands(sellerCmd: Command): void {
  sellerCmd
    .command('events')
    .description('Recent seller events: starts and stops, models withdrawn or restored, gas, quiet periods')
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
        if (!entry) throw new Error(`No request with id ${options.id}`);
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
      if (page.entries.length === 0) return console.log(chalk.dim('No requests.'));
      const table = new Table({ head: ['Id', 'Time', 'Buyer', 'Model', 'In', 'Out', 'Cost', 'Latency', 'Status'].map((h) => chalk.bold(h)) });
      for (const entry of page.entries) {
        const status = entry.statusCode >= 400 || entry.error ? chalk.yellow(`${entry.statusCode}${entry.error ? ` ${clip(entry.error, 40)}` : ''}`) : String(entry.statusCode);
        table.push([chalk.dim(entry.id.slice(0, 8)), when(entry.at), short(entry.buyer), entry.service ?? chalk.dim(entry.provider), entry.inputTokens, entry.outputTokens, usd(entry.costUsd), `${entry.latencyMs} ms`, status]);
      }
      console.log(table.toString());
      if (page.next) console.log(chalk.dim(`Older: antseed seller logs --cursor ${page.next}`));
      console.log(chalk.dim('One request in full: antseed seller logs --id <Id>'));
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
        table.push([service.service, pair(service.mine.inputUsdPerMillion, service.mine.outputUsdPerMillion), service.unique ? 'only you' : service.competitors,
          service.cheapest ? pair(service.cheapest.inputUsdPerMillion, service.cheapest.outputUsdPerMillion) : '—',
          service.median ? pair(service.median.inputUsdPerMillion, service.median.outputUsdPerMillion) : '—',
          service.rank === null ? '—' : `${service.rank} of ${service.of}`, service.deltaPct === null ? '—' : `${service.deltaPct > 0 ? '+' : ''}${service.deltaPct}%`]);
      }
      console.log(table.toString());
      const focus = options.model ? market.services.find((service) => service.service === options.model) : null;
      if (focus) {
        const offers = new Table({ head: ['Seller', 'Input / output', 'Cached', 'Trust', 'TEE', 'Load'].map((h) => chalk.bold(h)) });
        for (const offer of focus.offers) offers.push([`${offer.mine ? '→ ' : ''}${offer.name ?? short(offer.peerId)}`, pair(offer.inputUsdPerMillion, offer.outputUsdPerMillion), usd(offer.cachedInputUsdPerMillion), offer.trustScore === null ? '—' : Math.round(offer.trustScore), offer.tee ? 'TEE' : '', offer.load === null ? '—' : `${Math.round(offer.load * 100)}%`]);
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
      if (options.card) await writeFile(options.card, await monitor.card());
      return monitor.promote();
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
        const current = await monitor.promote();
        const removed = options.remove?.toLowerCase();
        const domains = current.domains.map(({ domain }) => domain).filter((domain) => domain !== removed);
        if (options.addDomain) domains.push(options.addDomain);
        const github = current.github.map(({ username, repository }) => ({ username, repository })).filter((entry) => entry.username.toLowerCase() !== removed);
        if (options.addGithub) {
          const [username, repository] = options.addGithub.replace(/^@/, '').split('/');
          github.push({ username: username!, repository: repository || username! });
        }
        await monitor.saveVerifications({ domains: domains.map((domain) => ({ domain })), github });
      }
      return options.check ? monitor.checkVerifications() : monitor.promote();
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
      console.log(`Max concurrent buyers ${view.maxConcurrentBuyers} · health checks ${view.healthCheck.enabled ? `every ${view.healthCheck.intervalMs / 1000}s, withdraw after ${view.healthCheck.failureThreshold}` : 'off'} · gas checks ${view.gasCheck.enabled ? `min ${view.gasCheck.minBalanceEth} ETH` : 'off'}`);
      console.log(`Refused countries ${view.restrictedCountries.join(', ') || 'none'}${view.restrictedCountriesDefault ? chalk.dim(' (built-in)') : ''}`);
      const table = new Table({ head: ['Model', 'Provider', 'Input', 'Output', 'Cached'].map((h) => chalk.bold(h)) });
      for (const service of view.services) table.push([service.service, service.provider, usd(service.inputUsdPerMillion), usd(service.outputUsdPerMillion), usd(service.cachedInputUsdPerMillion)]);
      console.log(table.toString());
    }));

  settings
    .command('set')
    .description('Change seller settings (validated, previous config kept as config.json.bak; restart the seller to apply)')
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
    .option('--countries <codes|default>', 'comma-separated ISO codes, "" for none, or default')
    .option('--price <[provider/]model=in/out[/cached]>', 'USD per million tokens; repeatable. Name the provider when two offer the model', (value: string, all: string[] = []) => [...all, value])
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
      if (text('freePerAddress') !== undefined || text('freePerIp') !== undefined || text('freeWindowHours') !== undefined) {
        const hours = text('freeWindowHours') === undefined ? undefined : limitOrNone(text('freeWindowHours')!);
        patch.freeTier = {
          ...(text('freePerAddress') !== undefined ? { maxRequestsPerAddress: limitOrNone(text('freePerAddress')!) } : {}),
          ...(text('freePerIp') !== undefined ? { maxRequestsPerIp: limitOrNone(text('freePerIp')!) } : {}),
          ...(hours !== undefined ? { windowMs: hours === null ? null : Math.round(hours * 3_600_000) } : {}),
        };
      }
      if (text('countries') !== undefined) patch.restrictedCountries = text('countries') === 'default' ? null : text('countries')!.split(',').map((code) => code.trim()).filter(Boolean);
      const prices = Array.isArray(options.price) ? options.price : [];
      if (prices.length > 0) {
        const { settings: view } = await monitor.settings();
        patch.pricing = prices.map(parsePrice).map((price) => {
          const service = resolvePriceTarget(view.services, price.service);
          return { provider: service.provider, service: service.service, inputUsdPerMillion: price.input, outputUsdPerMillion: price.output, cachedInputUsdPerMillion: price.cached };
        });
      }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change: pass at least one option (see --help).');
      return monitor.updateSettings(patch);
    }, (result) => console.log(chalk.green(`Saved ${result.changed.join(', ')}. Restart the seller to apply; the previous config is kept as config.json.bak.`))));
}
