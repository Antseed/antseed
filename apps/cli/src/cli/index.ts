#!/usr/bin/env node

import { Command } from 'commander';
import { loadEnvFromFiles } from '../env/load-env.js';
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
import { registerAntsCommands } from './commands/ants/index.js';

loadEnvFromFiles();

import pkg from '../../package.json' with { type: 'json' };
const version = pkg.version;

const program = new Command();

program
  .name('antseed')
  .description('P2P network for AI services')
  .version(version)
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
registerAntsCommands(program);

program.parse(process.argv);
