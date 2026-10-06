import type { Command } from 'commander';
import { registerAntsDashboardAction } from './dashboard.js';
import { registerAntsStatusCommand } from './status.js';
import { registerAntsPositionsCommand } from './positions.js';
import { registerAntsStakeCommand } from './stake.js';
import { registerAntsMoveCommand } from './move.js';
import { registerAntsSplitCommand } from './split.js';
import { registerAntsMergeCommand } from './merge.js';
import { registerAntsExtendCommand } from './extend.js';
import { registerAntsMaxLockCommand } from './max-lock.js';
import { registerAntsWithdrawCommand } from './withdraw.js';
import { registerAntsRewardsCommand } from './rewards.js';
import { registerAntsPoolsCommand } from './pools.js';
import { registerAntsPoolCommand } from './pool.js';
import { registerAntsUsageCommand } from './usage.js';
import { registerAntsEmissionsCommand } from './emissions.js';
import { registerAntsAddressesCommand } from './addresses.js';
import { registerAntsSellerCommand } from './seller.js';
import { registerAntsVerifyCommand } from './verify.js';

/**
 * `antseed ants` opens the local ANTS staking dashboard; every dashboard
 * action is also a subcommand so the dashboard stays optional.
 */
export function registerAntsCommands(program: Command): void {
  const antsCmd = program
    .command('ants')
    .description('ANTS staking: local dashboard (default) or CLI commands for positions, rewards, pools, verification');

  registerAntsDashboardAction(antsCmd);
  registerAntsStatusCommand(antsCmd);
  registerAntsPositionsCommand(antsCmd);
  registerAntsStakeCommand(antsCmd);
  registerAntsMoveCommand(antsCmd);
  registerAntsSplitCommand(antsCmd);
  registerAntsMergeCommand(antsCmd);
  registerAntsExtendCommand(antsCmd);
  registerAntsMaxLockCommand(antsCmd);
  registerAntsWithdrawCommand(antsCmd);
  registerAntsRewardsCommand(antsCmd);
  registerAntsPoolsCommand(antsCmd);
  registerAntsPoolCommand(antsCmd);
  registerAntsUsageCommand(antsCmd);
  registerAntsEmissionsCommand(antsCmd);
  registerAntsAddressesCommand(antsCmd);
  registerAntsSellerCommand(antsCmd);
  registerAntsVerifyCommand(antsCmd);
}
