import { Command } from 'commander';
import { registerSellerCommands } from './commands/seller/index.js';
import { registerBuyerCommands } from './commands/buyer/index.js';
import { registerConfigCommand } from './commands/config/index.js';
import { registerNetworkCommands } from './commands/network/index.js';
import { registerIdentityCommands } from './commands/identity/index.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerDevCommand } from './commands/dev.js';
import { registerPaymentsCommand } from './commands/payments.js';
import { registerDepositAlias } from './commands/buyer/deposit.js';
import { registerMetricsCommand } from './commands/metrics.js';
import { registerWrappedToolCommands } from './commands/wrapped-tools.js';
import { registerSystemProxyCommands } from './commands/system-proxy/index.js';
import { registerTunnelCommands } from './commands/tunnel/index.js';
import { registerGatewayCommands } from './commands/gateway/index.js';
import { registerAntsCommands } from './commands/ants/index.js';

import pkg from '../../package.json' with { type: 'json' };

/** The full `antseed` command tree, without parsing argv (tests build it too). */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('antseed')
    .description('P2P network for AI services')
    .version(pkg.version)
    .option('-c, --config <path>', 'path to config file (env: ANTSEED_CONFIG, default: ~/.antseed/config.json)')
    .option('--data-dir <path>', 'path to node identity/state directory (env: ANTSEED_DATA_DIR, default: ~/.antseed)')
    .option('-v, --verbose', 'enable verbose logging', false);

  registerSellerCommands(program);
  registerBuyerCommands(program);
  registerConfigCommand(program);
  registerNetworkCommands(program);
  registerIdentityCommands(program);
  registerDevCommand(program);
  registerAgentCommand(program);
  registerPaymentsCommand(program);
  registerDepositAlias(program);
  registerMetricsCommand(program);
  registerWrappedToolCommands(program);
  registerSystemProxyCommands(program);
  registerTunnelCommands(program);
  registerGatewayCommands(program);
  registerAntsCommands(program);

  return program;
}
