import type { Command } from 'commander';
import { registerBuyerStartCommand } from './start.js';
import { registerBuyerStatusCommand } from './status.js';
import { registerBuyerDepositCommand } from './deposit.js';
import { registerBuyerSetAuthorizedWalletCommand } from './set-authorized-wallet.js';
import { registerBuyerWithdrawCommand } from './withdraw.js';
import { registerBuyerSweepCommand } from './sweep.js';
import { registerBuyerBalanceCommand } from './balance.js';
import { registerBuyerConnectionCommand } from './connection.js';
import { registerBuyerChannelsCommand } from './channels.js';
import { registerBuyerActivityCommand } from './activity.js';
import { registerBuyerMeteringCommand } from './metering.js';
import { registerBuyerEmissionsCommand } from './emissions.js';

export function registerBuyerCommands(program: Command): void {
  const buyerCmd = program
    .command('buyer')
    .description('Buyer commands — connect to sellers and manage payments');

  registerBuyerStartCommand(buyerCmd);
  registerBuyerStatusCommand(buyerCmd);
  registerBuyerDepositCommand(buyerCmd);
  registerBuyerWithdrawCommand(buyerCmd);
  registerBuyerSetAuthorizedWalletCommand(buyerCmd);
  registerBuyerSweepCommand(buyerCmd);
  registerBuyerBalanceCommand(buyerCmd);
  registerBuyerConnectionCommand(buyerCmd);
  registerBuyerChannelsCommand(buyerCmd);
  registerBuyerActivityCommand(buyerCmd);
  registerBuyerMeteringCommand(buyerCmd);
  registerBuyerEmissionsCommand(buyerCmd);
}
