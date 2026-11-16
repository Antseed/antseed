import type { Command } from 'commander';
import { split } from '@antseed/ants';
import { runAction } from './shared.js';

export function registerAntsSplitCommand(antsCmd: Command): void {
  antsCmd
    .command('split <id> <amount>')
    .description('Split ANTS out of a position into a second position with the same terms')
    .action(async (id: string, amount: string) => runAction(antsCmd, 'Splitting position...', async ({ ctx }, report) => {
      await split(ctx, { positionId: Number(id), amount }, report);
      return `Split ${amount} ANTS out of position ${id}; both parts take effect next epoch`;
    }));
}
