import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { resolveEffectiveSellerConfig } from '../../../config/effective.js';
import { getNodeStatus } from '../../../status/node-status.js';
import {
  createSellerPoolsClient,
  formatUsdc,
  loadCryptoContext,
  resolveCliContractStack,
} from '../../payment-utils.js';
import { resolveConfigPath } from '../../../config/loader.js';
import { readSellerRegistration } from '../../../seller-monitor/standing.js';
import { sellerMonitorFor } from './monitor.js';
import { formatEarnings, formatTokens } from '../../formatters.js';

type SellerNodeState = 'seeding' | 'connected' | 'idle';

export function registerSellerStatusCommand(sellerCmd: Command): void {
  sellerCmd
    .command('status')
    .description('Show seller node status and readiness')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const globalOpts = getGlobalOptions(sellerCmd);
        const config = await loadConfig(globalOpts.config);
        const effectiveSeller = resolveEffectiveSellerConfig({ config });
        const status = await getNodeStatus(config, globalOpts.dataDir);
        const walletAddress = status.walletAddress ?? await (async () => {
          try {
            return (await loadCryptoContext(globalOpts.dataDir)).address;
          } catch {
            return null;
          }
        })();

        const providerSummary = Object.entries(effectiveSeller.providers).map(([name, cfg]) => {
          const defaults = cfg.defaults;
          const serviceCount = Object.keys(cfg.services).length;
          const priceLabel = defaults
            ? `${defaults.inputUsdPerMillion}/${defaults.outputUsdPerMillion}`
            : 'per-service';
          return {
            name,
            services: serviceCount,
            pricing: priceLabel,
            plugin: cfg.plugin,
          };
        });

        // Registration and stake: the ants `seller` read the dashboard's Reputation page uses, over the shared provider.
        let onChain: Record<string, unknown> | null = null;
        let onChainError: string | null = null;
        if (walletAddress) {
          try {
            const [registration, stack] = await Promise.all([
              readSellerRegistration({ address: walletAddress, configPath: resolveConfigPath(globalOpts.config) }),
              resolveCliContractStack(config),
            ]);
            // Pool positions are optional: legacy chains have no pool contracts, and the registration still shows.
            const positionCount = await (async () => {
              try {
                return await createSellerPoolsClient(config).stakerPositionCount(walletAddress);
              } catch {
                return null;
              }
            })();
            onChain = {
              mode: stack.mode,
              agentId: registration.agentId,
              registryBound: registration.registryBound,
              eligible: registration.eligible,
              legacyStake: registration.legacyStake,
              activePoolStake: registration.poolActiveStake,
              minPoolStake: registration.minPoolStake,
              positionCount,
            };
          } catch (error) {
            onChainError = `${(error as Error).name}: ${(error as Error).message}`;
          }
        }
        // Model health, gas and alerts from the running seller, as the dashboard shows them.
        const monitor = sellerMonitorFor(sellerCmd);
        const { status: health, rpc } = await monitor.statusWithRpc();
        // The daemon state never tracked today's totals; the metering ledger does.
        const todayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
        const today = (await monitor.usage(1).catch(() => null))?.days.find((day) => day.day === todayStart);
        if (today) {
          status.earningsToday = today.revenueUsd.toFixed(2);
          status.tokensToday = today.tokens;
        }

        if (options.json) {
          console.log(JSON.stringify({
            state: status.state,
            peerCount: status.peerCount,
            earningsToday: status.earningsToday,
            tokensToday: status.tokensToday,
            activeChannels: status.activeChannels,
            uptime: status.uptime,
            walletAddress,
            notices: status.notices,
            providers: providerSummary,
            onChain,
            onChainError,
            health,
            rpc,
          }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
          return;
        }

        const stateColors: Record<SellerNodeState, (s: string) => string> = {
          seeding: chalk.green,
          connected: chalk.cyan,
          idle: chalk.gray,
        };
        const colorFn = stateColors[status.state] ?? chalk.white;
        console.log(chalk.bold('Seller Status: ') + colorFn(status.state.toUpperCase()));
        for (const notice of status.notices) {
          console.log(chalk.yellow(`⚠ ${notice}`));
        }
        console.log('');

        const table = new Table({
          head: [chalk.bold('Metric'), chalk.bold('Value')],
          colWidths: [25, 55],
        });

        table.push(
          ['Peers connected', chalk.cyan(String(status.peerCount))],
          ['Earnings today', chalk.green(formatEarnings(status.earningsToday))],
          ['Tokens today', formatTokens(status.tokensToday)],
          ['Active channels', String(status.activeChannels)],
          ['Uptime', status.uptime],
          ['Wallet address', walletAddress ?? chalk.dim('not configured')],
        );

        table.push([
          'Configured providers',
          providerSummary.length > 0
            ? providerSummary.map((provider) => `${provider.name} (${provider.plugin}): ${provider.services} service(s), defaults ${provider.pricing}`).join('\n')
            : chalk.dim('(none)'),
        ]);

        if (onChain) {
          table.push(
            ['On-chain mode', String(onChain.mode)],
            ['Agent ID', `${onChain.agentId}${onChain.registryBound ? '' : chalk.dim(' (not bound)')}`],
            ['Legacy USDC stake', `${formatUsdc(BigInt(String(onChain.legacyStake)))} USDC`],
            ['Pool active stake', `${formatAntsForStatus(BigInt(String(onChain.activePoolStake)))} ANTS`],
            ['Seller eligible', String(onChain.eligible)],
            ['Pool positions', onChain.positionCount === null ? '—' : String(onChain.positionCount)],
          );
        } else if (onChainError) {
          table.push(['On-chain warning', chalk.yellow(onChainError)]);
        }
        if (health.available && !health.running) {
          // A seller that crashed or was killed leaves its last state behind: not live health.
          table.push(['Health', chalk.dim('not running; models, gas and alerts show once it is')]);
        } else if (health.available) {
          const withdrawn = health.models.filter((model) => !model.advertised);
          table.push(
            ['Models', health.models.length === 0 ? chalk.dim('no health data yet') : withdrawn.length === 0 ? `${health.models.length} advertised` : chalk.yellow(`${withdrawn.length} withdrawn: ${withdrawn.map((model) => `${model.service} (${model.lastStatusCode ?? model.lastDetail ?? 'failing'})`).join(', ')}`)],
            ['Gas', health.gas?.balanceEth == null ? chalk.dim('no gas checks') : `${health.gas.balanceEth} ETH${health.gas.depleted ? chalk.yellow(' (below minimum, advertising paused)') : ''}`],
            ['Alerts', health.alerts?.channels.length ? health.alerts.channels.join(', ') : chalk.dim('off (antseed seller alerts set)')],
          );
        }
        const rpcLine = Object.entries(health.available && health.running ? rpc.daemon ?? {} : {}).map(([source, usage]) => `${source} ${usage.perMinute}/min`).join(', ');
        if (rpcLine) table.push(['Chain RPC (seller)', rpcLine]);

        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}

function formatAntsForStatus(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
