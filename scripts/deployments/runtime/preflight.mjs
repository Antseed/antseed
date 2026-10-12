import path from 'node:path';
import readline from 'node:readline/promises';
import { gitStatusPorcelain } from './exec.mjs';

/** Requires an explicit typed confirmation (or ANTSEED_DEPLOY_CONFIRM) before broadcasting. */
export async function confirmBroadcast(migrationId, network) {
  if (process.env.ANTSEED_DEPLOY_CONFIRM === network) return;
  if (!process.stdin.isTTY) throw new Error(`Set ANTSEED_DEPLOY_CONFIRM=${network} in non-interactive environments`);
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await reader.question(`Type ${network} to broadcast ${migrationId}: `);
  reader.close();
  if (answer !== network) throw new Error('Broadcast cancelled');
}

/**
 * Production broadcasts must run from a clean tree so `sourceCommit` in the
 * ledger always describes the exact code that was deployed. Records written by
 * an earlier phase of the same migration are the only permitted exception.
 */
export function assertCleanForBroadcast(context, allowedReleases = []) {
  if (context.forkTest) return;
  const networkPath = path.posix.join('packages/contracts/deployments', context.network);
  const allowed = new Set(allowedReleases.map((release) => path.posix.join(networkPath, 'history', `${release}.json`)));
  // A broadcast consumes the reviewed plan for the phase it is executing, so
  // removing those artifacts must not count as an unexpected local change.
  const pendingPrefix = path.posix.join(networkPath, 'pending/');
  const unexpected = gitStatusPorcelain().split('\n').filter(Boolean).filter((line) => {
    const file = line.slice(3).replace(/^"|"$/g, '');
    return !allowed.has(file) && !file.startsWith(pendingPrefix);
  });
  if (unexpected.length) {
    throw new Error(`Production broadcasts require a clean Git working tree:\n${unexpected.join('\n')}`);
  }
}
