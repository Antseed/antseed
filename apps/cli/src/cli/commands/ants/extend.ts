import type { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import { extend } from '@antseed/ants';
import { runAction } from './shared.js';

export function registerAntsExtendCommand(antsCmd: Command): void {
  antsCmd
    .command('extend <id>')
    .description('Extend a position lock by additional epochs')
    .requiredOption('--epochs <n>', 'additional epochs', parsePositiveInteger)
    .action(async (id: string, options: { epochs: number }) => runAction(antsCmd, 'Extending lock...', async ({ ctx }, report) => {
      await extend(ctx, { positionId: Number(id), epochs: options.epochs }, report);
      return `Extended position ${id} by ${options.epochs} epoch(s)`;
    }));
}
