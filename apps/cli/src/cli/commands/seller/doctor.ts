import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { assessSellerPublicAddress, probeTcpEndpoint } from './reachability.js';

export function registerSellerDoctorCommand(sellerCmd: Command): void {
  sellerCmd
    .command('doctor')
    .description('Diagnose the announced seller endpoint')
    .option('--json', 'output as JSON', false)
    .option('--timeout-ms <milliseconds>', 'TCP probe timeout', '3000')
    .action(async (options) => {
      try {
        const timeoutMs = Number(options.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
          throw new Error('--timeout-ms must be an integer >= 1');
        }

        const globalOpts = getGlobalOptions(sellerCmd);
        const config = await loadConfig(globalOpts.config);
        const assessment = assessSellerPublicAddress(config.seller.publicAddress);
        const probe = assessment.endpoint
          ? await probeTcpEndpoint(assessment.endpoint, timeoutMs)
          : null;
        const healthy = assessment.publiclyRoutable && probe?.reachable === true;
        const result = {
          configuredAddress: assessment.address || null,
          classification: assessment.classification,
          publiclyRoutable: assessment.publiclyRoutable,
          localTcpProbe: probe,
          externalReachabilityVerified: false,
          healthy,
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.bold('Seller Reachability'));
          console.log(`  Announced endpoint: ${assessment.address || chalk.red('not configured')}`);
          console.log(`  Address check: ${assessment.publiclyRoutable ? chalk.green('potentially public') : chalk.red(assessment.classification)}`);
          console.log(`  ${assessment.message}`);

          if (probe?.reachable) {
            console.log(chalk.green(`  Local TCP probe: connected in ${probe.durationMs}ms`));
          } else if (probe) {
            console.log(chalk.red(`  Local TCP probe: failed (${probe.error ?? 'unknown error'})`));
          } else {
            console.log(chalk.yellow('  Local TCP probe: skipped — configure a host:port endpoint first'));
          }

          console.log('');
          console.log(chalk.yellow('A successful local probe does not prove inbound NAT reachability.'));
          console.log('Verify the endpoint from another network, and configure port forwarding/firewall rules if needed.');
          console.log('Guide: https://antseed.com/docs/transport/');
        }

        if (!healthy) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
