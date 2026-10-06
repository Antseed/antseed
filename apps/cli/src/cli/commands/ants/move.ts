import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import { move } from '@antseed/ants';
import { parseIds, runAction } from './shared.js';

export function registerAntsMoveCommand(antsCmd: Command): void {
  antsCmd
    .command('move <ids...>')
    .description('Move positions to another seller agent pool (principal and lock terms are preserved)')
    .requiredOption('--to <agentId>', 'destination agent ID', parsePositiveInteger)
    .action(async (ids: string[], options: { to: number }) => runAction(antsCmd, 'Moving stake...', async ({ ctx }, report) => {
      await move(ctx, { positionIds: parseIds(ids), toAgentId: options.to }, report);
      return `Moved ${ids.length} position(s) to agent ${options.to}; effective next epoch. Rewards accrued so far stay claimable on the old IDs.`;
    }));
}
