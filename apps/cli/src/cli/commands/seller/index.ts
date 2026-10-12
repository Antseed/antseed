import type { Command } from 'commander';
import { registerSellerStartCommand } from './start.js';
import { registerSellerSetupCommand } from './setup.js';
import { registerSellerStatusCommand } from './status.js';
import { registerSellerRegisterCommand } from './register.js';
import { registerSellerStakeCommand } from './stake.js';
import { registerSellerDoctorCommand } from './doctor.js';
import { registerSellerPoolCommand } from './pool.js';
import { registerSellerRewardsCommand } from './rewards.js';

export function registerSellerCommands(program: Command): void {
  const sellerCmd = program
    .command('seller')
    .description('Seller commands — provide AI services on the network');

  registerSellerStartCommand(sellerCmd);
  registerSellerSetupCommand(sellerCmd);
  registerSellerStatusCommand(sellerCmd);
  registerSellerRegisterCommand(sellerCmd);
  registerSellerStakeCommand(sellerCmd);
  registerSellerPoolCommand(sellerCmd);
  registerSellerRewardsCommand(sellerCmd);
  registerSellerDoctorCommand(sellerCmd);
}
