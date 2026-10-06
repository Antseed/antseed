import type { Command } from 'commander';
import Table from 'cli-table3';
import { singlePool, formatAnts, formatBps } from '@antseed/ants';
import { ants, printJson, runRead, usdc } from './shared.js';

export function registerAntsPoolCommand(antsCmd: Command): void {
  antsCmd
    .command('pool <agentId>')
    .description('Show one seller agent pool')
    .option('--json', 'output as JSON', false)
    .action(async (agentId: string, options: { json: boolean }) => runRead(antsCmd, 'Loading pool...', async ({ ctx }) => {
      const pool = await singlePool(ctx, Number(agentId));
      if (options.json) return printJson(pool);
      const table = new Table({ head: ['Field', 'Value'] });
      table.push(
        ['Agent', pool.agentId],
        ['Seller', pool.seller ?? 'unknown'],
        ['Name', pool.profile?.name ?? '—'],
        ['Stakeable', pool.stakeable ? 'yes (bound in seller registry)' : 'no (seller not bound)'],
        ['Has pool this epoch', pool.hasPool ? 'yes' : 'no'],
        ['Active stake', ants(pool.activeStake)],
        ['Power', `${formatAnts(pool.weight, 0)} (${formatBps(pool.powerShareBps)} of all pools)`],
        ['Security share', formatBps(pool.securityShareBps)],
        ['Volume by epoch', pool.volumes.map((row) => `e${row.epoch} ${usdc(row.usdc)}`).join('  ')],
        ['Usage points (epoch)', `${pool.usagePoints} (weighted ${pool.weightedUsagePoints})`],
        ['Last epoch pool emission', pool.lastEpochEmission === null ? 'not settled' : `${ants(pool.lastEpochEmission)} (${pool.lastEpochRewardPer1kPower ? formatAnts(pool.lastEpochRewardPer1kPower, 2) : '—'} ANTS per 1k power)`],
        ['Projected this epoch', pool.projectedRewardPer1kPower ? `${formatAnts(pool.projectedRewardPer1kPower, 2)} ANTS per 1k power` : '—'],
        ['Your stake / power', `${ants(pool.yourStake)} / ${formatAnts(pool.yourPower, 0)} (${formatBps(pool.yourPoolShareBps)} of pool)${pool.yourPositionIds.length ? ` positions ${pool.yourPositionIds.join(', ')}` : ''}`],
      );
      if (pool.profile) {
        table.push(['Explorer profile', `${pool.profile.modelsServed ?? '?'} models, ${pool.profile.uniqueBuyers ?? '?'} buyers, lifetime ${usdc(pool.profile.lifetimeVolumeUsdc ?? '0')}, ghost rate ${pool.profile.ghostRate ?? '?'}%`]);
      }
      console.log(table.toString());
    }));
}
