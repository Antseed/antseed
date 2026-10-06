import type { Command } from 'commander';
import { merge } from '@antseed/ants';
import { parseIds, runAction } from './shared.js';

export function registerAntsMergeCommand(antsCmd: Command): void {
  antsCmd
    .command('merge <ids...>')
    .description('Merge positions in the same pool with the same lock end into one position')
    .action(async (ids: string[]) => runAction(antsCmd, 'Merging positions...', async ({ ctx }, report) => {
      await merge(ctx, { positionIds: parseIds(ids) }, report);
      return `Merged ${ids.length} positions; the replacement takes over their power next epoch`;
    }));
}
