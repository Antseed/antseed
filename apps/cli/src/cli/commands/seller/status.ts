import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { resolveEffectiveSellerConfig } from '../../../config/effective.js';
import { getNodeStatus } from '../../../status/node-status.js';
import {
  createLegacyStakingClient,
  createSellerPoolsClient,
  createSellerRegistryClient,
  createStakingClient,
  formatUsdc,
  loadCryptoContext,
  resolveCliContractStack,
} from '../../payment-utils.js';
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

        let onChain: Record<string, unknown> | null = null;
        let onChainError: string | null = null;
        if (walletAddress) {
          try {
            const stack = await resolveCliContractStack(config);
            if (stack.mode === 'recognized-usage') {
              const registry = createSellerRegistryClient(config);
              const pools = createSellerPoolsClient(config);
              const agentId = await registry.getAgentId(walletAddress);
              const [legacyStake, activePoolStake, eligible, positionCount] = await Promise.all([
                stack.addresses.legacyStakingContractAddress ? createLegacyStakingClient(config).getStake(walletAddress) : 0n,
                agentId ? pools.poolActiveStakeAtEpoch(agentId, stack.currentEpoch) : 0n,
                registry.isStakedAboveMin(walletAddress),
                pools.stakerPositionCount(walletAddress),
              ]);
              onChain = { mode: stack.mode, agentId, legacyStake, activePoolStake, eligible, positionCount };
            } else {
              const staking = createStakingClient(config);
              const [agentId, legacyStake, eligible] = await Promise.all([
                staking.getAgentId(walletAddress), staking.getStake(walletAddress), staking.isStakedAboveMin(walletAddress),
              ]);
              onChain = { mode: stack.mode, agentId, legacyStake, activePoolStake: 0n, eligible, positionCount: 0 };
            }
          } catch (error) {
            onChainError = `${(error as Error).name}: ${(error as Error).message}`;
          }
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
            ['Agent ID', String(onChain.agentId)],
            ['Legacy USDC stake', `${formatUsdc(onChain.legacyStake as bigint)} USDC`],
            ['Pool active stake', `${formatAntsForStatus(onChain.activePoolStake as bigint)} ANTS`],
            ['Seller eligible', String(onChain.eligible)],
            ['Pool positions', String(onChain.positionCount)],
          );
        } else if (onChainError) {
          table.push(['On-chain warning', chalk.yellow(onChainError)]);
        }

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
