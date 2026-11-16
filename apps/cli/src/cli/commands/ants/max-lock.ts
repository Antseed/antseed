import type { Command } from 'commander';
import { maxLock } from '@antseed/ants';
import { runAction } from './shared.js';

export function registerAntsMaxLockCommand(antsCmd: Command): void {
  antsCmd
    .command('max-lock <id>')
    .description('Enable max lock (constant maximum power) on a position, or disable it with --off')
    .option('--off', 'disable max lock; a fresh full-length countdown starts next epoch', false)
    .action(async (id: string, options: { off: boolean }) => runAction(antsCmd, options.off ? 'Disabling max lock...' : 'Enabling max lock...', async ({ ctx }, report) => {
      await maxLock(ctx, { positionId: Number(id), enable: !options.off }, report);
      return options.off ? `Max lock disabled on position ${id}` : `Max lock enabled on position ${id}`;
    }));
}
