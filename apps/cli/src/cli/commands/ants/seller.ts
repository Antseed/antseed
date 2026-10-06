import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import Table from 'cli-table3';
import { seller, registerBinding, claimStarter, formatUsdc, formatAntsExact } from '@antseed/ants';
import { ants, printJson, runAction, runRead } from './shared.js';

export function registerAntsSellerCommand(antsCmd: Command): void {
  const sellerCmd = antsCmd.command('seller').description('Seller-side staking state: identity binding, eligibility, starter grant');

  sellerCmd.option('--json', 'output as JSON', false).action(async (options: { json: boolean }) => runRead(antsCmd, 'Loading seller state...', async ({ ctx }) => {
    const view = await seller(ctx);
    if (options.json) return printJson(view);
    const table = new Table({ head: ['Field', 'Value'] });
    table.push(
      ['Wallet', view.address], ['Agent ID', view.agentId || 'none'], ['ERC-8004 identity', view.identityRegistered ? 'registered' : 'not registered'],
      ['Seller registry binding', view.registryBound ? 'bound' : 'not bound (run: antseed seller register)'],
      ['Eligible to serve', view.eligible ? 'yes' : 'no'], ['Legacy USDC stake', `${formatUsdc(view.legacyStake)} USDC${view.legacyEligibilityEnabled === false ? ' (legacy fallback disabled)' : ''}`],
      ['Pool active stake', `${ants(view.poolActiveStake)}${view.minPoolStake ? ` (minimum ${formatAntsExact(view.minPoolStake)} ANTS)` : ''}`],
    );
    if (view.starter) {
      table.push(['Starter grant', view.starter.initialized ? 'already claimed' : view.starter.claimable ? `claimable: ${ants(view.starter.amount)} locked through epoch ${view.starter.endEpoch}` : view.starter.expired ? 'closed' : !view.starter.legacyEligible ? 'requires legacy USDC stake at or above the minimum' : 'faucet empty']);
    }
    console.log(table.toString());
  }));

  sellerCmd.command('register')
    .description('Bind your agent ID in the seller registry (same as: antseed seller register)')
    .option('--agent-id <id>', 'agent ID to bind (default: legacy staking binding)', parsePositiveInteger)
    .action(async (options: { agentId?: number }) => runAction(antsCmd, 'Registering...', async ({ ctx }, report) => {
      const result = await registerBinding(ctx, options.agentId, report);
      return result.sent ? `Agent ${result.agentId} bound to this wallet` : `Agent ${result.agentId} was already bound`;
    }));

  sellerCmd.command('claim-starter')
    .description('Claim the legacy-seller starter ANTS position (same as: antseed seller legacy claim-starter)')
    .action(async () => runAction(antsCmd, 'Claiming starter position...', async ({ ctx }, report) => {
      const result = await claimStarter(ctx, report);
      return `Starter position created for agent ${result.agentId}: ${ants(result.amount)} locked through epoch ${result.endEpoch}`;
    }));
}
