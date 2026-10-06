import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { readFile } from 'node:fs/promises';
import { verification, proofStatus, submitProof, formatBps, formatUsdc, validateSellerProofArtifact, sellerProofId } from '@antseed/ants';
import { confirm, printJson, runAction, runRead } from './shared.js';

export function registerAntsVerifyCommand(antsCmd: Command): void {
  const verify = antsCmd.command('verify').description('Wash-trading verification: seller status, proof submission, proof progress');

  verify.argument('[seller]', 'seller address to inspect (default: your wallet)')
    .option('--json', 'output as JSON', false)
    .action(async (seller: string | undefined, options: { json: boolean }) => runRead(antsCmd, 'Loading verification status...', async ({ ctx }) => {
      const view = await verification(ctx, seller);
      if (options.json) return printJson(view);
      if (!view.registry) return console.log(chalk.yellow('No wash-trading registry is configured for this chain.'));
      console.log(chalk.bold('Wash-trading registry\n'));
      const table = new Table({ head: ['Field', 'Value'] });
      table.push(
        ['Registry', view.registry.address], ['SP1 verifier', `${view.registry.verifier} (hash ${view.registry.verifierHash})`],
        ['Seller program vkey', view.registry.sellerProgramVKey], ['Historical period', `blocks ${view.registry.periodStartBlock}–${view.registry.periodEndBlock}`],
        ['Flag threshold', `${formatBps(view.registry.thresholdBps)} of authenticated volume`], ['Blockhash store', view.registry.blockhashStore],
        ['Enforced in accounting', view.enforced ? 'yes (points policy registry pins this registry)' : 'no'],
      );
      console.log(table.toString());
      if (view.seller) {
        console.log(chalk.bold(`\nSeller ${view.seller.seller}\n`));
        const status = new Table({ head: ['Field', 'Value'] });
        status.push(
          ['Proven wash volume', `${formatUsdc(view.seller.provenWashVolume)} USDC`], ['Authenticated total volume', `${formatUsdc(view.seller.totalSellerVolume)} USDC`],
          ['Proven wash share', formatBps(view.seller.provenWashShareBps)], ['Flagged', view.seller.isProvenWashTrader ? chalk.red('yes — new usage earns zero points') : 'no'],
          ['Evidence digest', view.seller.evidenceDigest],
        );
        console.log(status.toString());
      }
    }));

  verify.command('submit <artifact>')
    .description('Stage, authenticate, and finalize a loop-proof seller proof artifact (resumable)')
    .option('-y, --yes', 'skip the confirmation', false)
    .action(async (artifactPath: string, options: { yes: boolean }) => runAction(antsCmd, 'Reading artifact...', async ({ ctx }, report, spinner) => {
      const artifact = validateSellerProofArtifact(JSON.parse(await readFile(artifactPath, 'utf-8')));
      spinner.stop();
      console.log(`Seller ${artifact.seller}, proof ${sellerProofId(artifact.publicValues)}, ${artifact.blockAuthenticationChunkCount} chunk(s) / ${artifact.blockReferenceCount} block references.`);
      console.log(chalk.yellow('Submission is permanent and permissionless: a finalized result records the seller\'s proven wash ratio on chain.'));
      if (!options.yes && !(await confirm('Submit this proof? [y/N] '))) throw new Error('Submission cancelled.');
      spinner.start('Submitting proof...');
      const result = await submitProof(ctx, artifact, report);
      return `Proof ${result.proofId} finalized for ${result.seller} (${result.transactions.length} transaction(s))`;
    }));

  verify.command('proof <proofId>')
    .description('Show staging/authentication/finalization progress of a proof ID')
    .option('--json', 'output as JSON', false)
    .action(async (proofId: string, options: { json: boolean }) => runRead(antsCmd, 'Loading proof...', async ({ ctx }) => {
      const status = await proofStatus(ctx, proofId);
      if (options.json || verify.opts<{ json: boolean }>().json) return printJson(status);
      console.log(`Proof ${status.proofId}: ${status.finalized ? 'finalized' : status.staged ? 'staged' : 'not staged'}; ${status.authenticatedBlockChunkCount} chunk(s) / ${status.authenticatedBlockReferenceCount} block reference(s) authenticated.`);
    }));
}
