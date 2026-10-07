import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { CloseChannelResultPayload, StoredChannel } from '@antseed/node';
import { CHANNEL_STATUS } from '@antseed/node/payments';
import { getGlobalOptions } from '../types.js';
import { proxyAuthHeaders } from '../../../proxy/proxy-auth.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createChannelsClient,
  formatUsdc,
  loadCryptoContext,
  openChannelStore,
  shortId,
} from '../../payment-utils.js';

export const CHANNEL_CLOSE_GRACE_PERIOD_SECONDS = 15 * 60;
// Contract channel status is a uint8; 1 maps to the on-chain Active enum value.
const ON_CHAIN_STATUS_ACTIVE = 1;

const CHANNEL_STATUS_LABELS: Record<number, string> = {
  0: 'none',
  1: 'active',
  2: 'settled',
  3: 'timed out',
};

function normalizeChannelId(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveBuyerChannelById(
  channels: StoredChannel[],
  channelIdOrPrefix: string,
): StoredChannel {
  const query = normalizeChannelId(channelIdOrPrefix);
  const matches = channels.filter((channel) => normalizeChannelId(channel.sessionId).startsWith(query));

  if (matches.length === 0) {
    throw new Error(`No local buyer channel found for ${channelIdOrPrefix}. Run \`antseed buyer channels\` to list channels.`);
  }
  if (matches.length > 1) {
    const examples = matches.slice(0, 5).map((channel) => channel.sessionId).join(', ');
    throw new Error(`Channel id prefix is ambiguous. Matches: ${examples}`);
  }
  return matches[0]!;
}

export function secondsUntilChannelWithdrawReady(
  closeRequestedAtSeconds: bigint,
  nowSeconds: number,
  gracePeriodSeconds = CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
): number {
  if (closeRequestedAtSeconds <= 0n) return gracePeriodSeconds;
  const readyAt = Number(closeRequestedAtSeconds) + gracePeriodSeconds;
  return Math.max(0, readyAt - nowSeconds);
}

function formatWait(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return 'about 1 minute';
  return `about ${minutes} minutes`;
}

function openChannelStoreOrExit(dataDir: string): ReturnType<typeof openChannelStore> {
  try {
    return openChannelStore(dataDir);
  } catch (err) {
    console.error(chalk.red(`Failed to open channel store: ${(err as Error).message}`));
    console.error(chalk.dim('Have you connected to the network yet? Channels are stored locally after first use.'));
    process.exit(1);
  }
}

/**
 * Human-readable guidance per seller rejection code. The seller declining is a
 * normal outcome — it means the channel is still accumulating — so we explain
 * what to do rather than treating it as a failure of the command.
 */
const REJECT_HINTS: Record<string, string> = {
  busy: 'The seller is still serving a request on this channel. Retry in a few seconds.',
  pending_auth: 'The seller has served work you have not signed for yet. The catch-up authorization was just requested — retry in a few seconds.',
  no_channel: 'The seller has no active channel with you. It may already be closed on-chain — check `antseed buyer channels list`.',
  invalid_auth: 'The seller rejected the attached authorization. Retry with --no-auth to let the seller close using the signature it already holds.',
  close_failed: 'The seller could not submit the on-chain close.',
  unsupported: 'This peer does not support cooperative close. Use `antseed buyer channels request-close` instead.',
};

async function daemonRequestClose(
  port: number,
  dataDir: string,
  peerId: string,
  includeAuth: boolean,
): Promise<CloseChannelResultPayload> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/_antseed/channels/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proxyAuthHeaders(dataDir, port) },
      body: JSON.stringify({ peerId, includeAuth }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error(
      `No buyer daemon is listening on port ${port}. A cooperative close runs over the daemon's live `
      + 'connection to the seller — start it with `antseed buyer start`, or fall back to '
      + '`antseed buyer channels request-close <channelId>`.',
    );
  }
  const body = await res.json().catch(() => null) as {
    ok?: boolean; result?: CloseChannelResultPayload; error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.result) {
    throw new Error(body?.error ?? `Daemon returned HTTP ${res.status}`);
  }
  return body.result;
}

export function registerBuyerChannelWithdrawCommands(channelsCmd: Command, buyerCmd: Command): void {
  channelsCmd
    .command('close <channelId>')
    .description('Ask the seller to close an active channel now, skipping the request-close grace period')
    .option('--no-auth', 'do not attach your latest spending authorization; let the seller use the one it holds')
    .option('--json', 'output as JSON', false)
    .action(async (channelId: string, options: { auth: boolean; json: boolean }) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      const { address } = await loadCryptoContext(globalOpts.dataDir);

      let localChannel: StoredChannel;
      const store = openChannelStoreOrExit(globalOpts.dataDir);
      try {
        localChannel = resolveBuyerChannelById(
          store.getAllChannelsByBuyer('buyer', address),
          channelId,
        );
      } finally {
        store.close();
      }

      if (localChannel.status !== CHANNEL_STATUS.ACTIVE) {
        console.error(chalk.red(`Error: Local channel ${shortId(localChannel.sessionId, 18)} is ${localChannel.status}, not active.`));
        console.error(chalk.dim('Only active channels can be closed.'));
        process.exit(1);
      }

      const spinner = ora(`Asking seller ${shortId(localChannel.peerId, 12)} to close ${shortId(localChannel.sessionId, 18)}...`).start();
      let result: CloseChannelResultPayload;
      try {
        result = await daemonRequestClose(config.buyer.proxyPort, globalOpts.dataDir, localChannel.peerId, options.auth);
      } catch (err) {
        // An unreachable seller lands here, and that is the likeliest reason to
        // be running this command at all — so give the same actionable fallback
        // the decline path gives, not just the raw error.
        spinner.fail(chalk.red(`Close request failed: ${(err as Error).message}`));
        console.log(chalk.dim('The channel is unchanged. To release the reserve without the seller:'));
        console.log(chalk.cyan(`  antseed buyer channels request-close ${localChannel.sessionId}`));
        console.log(chalk.dim(`  ...then after ${formatWait(CHANNEL_CLOSE_GRACE_PERIOD_SECONDS)}: antseed buyer channels withdraw ${localChannel.sessionId}`));
        process.exit(1);
      }

      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== 'closed') process.exit(1);
        return;
      }

      if (result.status === 'closed') {
        spinner.succeed(chalk.green(`Seller closed ${shortId(result.channelId, 18)}`));
        console.log(chalk.dim(`Transaction: ${result.txHash}`));
        console.log(chalk.dim(`Settled at: ${formatUsdc(BigInt(result.finalAmount ?? '0'))} USDC`));
        console.log(chalk.dim('Your remaining reserve is released — no grace period to wait out.'));
        return;
      }

      spinner.warn(chalk.yellow(`Seller declined to close ${shortId(result.channelId, 18)}: ${result.code ?? 'unknown'}`));
      if (result.reason) console.log(chalk.dim(result.reason));
      const hint = result.code ? REJECT_HINTS[result.code] : undefined;
      if (hint) console.log(hint);
      console.log(chalk.dim(`Fallback: antseed buyer channels request-close ${localChannel.sessionId}`));
      process.exit(1);
    });

  channelsCmd
    .command('request-close <channelId>')
    .description('Request timeout close for an active buyer payment channel so reserved funds can be withdrawn after the grace period')
    .option('--json', 'output as JSON', false)
    .action(async (channelId: string, options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const channelsClient = createChannelsClient(config);

      let localChannel: StoredChannel;
      const store = openChannelStoreOrExit(globalOpts.dataDir);
      try {
        localChannel = resolveBuyerChannelById(
          store.getAllChannelsByBuyer('buyer', address),
          channelId,
        );
      } finally {
        store.close();
      }

      if (localChannel.status !== CHANNEL_STATUS.ACTIVE) {
        console.error(chalk.red(`Error: Local channel ${shortId(localChannel.sessionId, 18)} is ${localChannel.status}, not active.`));
        console.error(chalk.dim('Only active channels can be timeout closed.'));
        process.exit(1);
      }

      const spinner = ora(`Requesting timeout close for channel ${shortId(localChannel.sessionId, 18)}...`).start();
      try {
        const onChain = await channelsClient.getSession(localChannel.sessionId);
        if (onChain.buyer.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`Configured wallet ${address} is not the on-chain buyer for this channel.`);
        }
        if (onChain.status !== ON_CHAIN_STATUS_ACTIVE) {
          throw new Error(`On-chain channel is ${CHANNEL_STATUS_LABELS[onChain.status] ?? `status ${onChain.status}`}, not active.`);
        }
        if (onChain.closeRequestedAt > 0n) {
          const waitSeconds = secondsUntilChannelWithdrawReady(
            onChain.closeRequestedAt,
            Math.floor(Date.now() / 1000),
          );
          spinner.stop();
          if (options.json) {
            console.log(JSON.stringify({
              channelId: localChannel.sessionId,
              alreadyRequested: true,
              closeRequestedAt: onChain.closeRequestedAt.toString(),
              withdrawReady: waitSeconds === 0,
              waitSeconds,
            }, null, 2));
            return;
          }
          console.log(chalk.yellow(`Close was already requested for ${shortId(localChannel.sessionId, 18)}.`));
          console.log(waitSeconds === 0
            ? chalk.green('It is ready to withdraw now: antseed buyer channels withdraw ' + localChannel.sessionId)
            : chalk.dim(`Withdraw should be available in ${formatWait(waitSeconds)}.`));
          return;
        }

        const txHash = await channelsClient.requestClose(wallet, localChannel.sessionId);
        spinner.succeed(chalk.green(`Requested timeout close for ${shortId(localChannel.sessionId, 18)}`));
        if (options.json) {
          console.log(JSON.stringify({
            channelId: localChannel.sessionId,
            transaction: txHash,
            withdrawAfterSeconds: CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
          }, null, 2));
          return;
        }
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log(chalk.dim(`Withdraw reserved funds after ${formatWait(CHANNEL_CLOSE_GRACE_PERIOD_SECONDS)}:`));
        console.log(chalk.cyan(`  antseed buyer channels withdraw ${localChannel.sessionId}`));
      } catch (err) {
        spinner.fail(chalk.red(`Close request failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  channelsCmd
    .command('withdraw <channelId>')
    .description('Withdraw/release reserved buyer funds after a channel timeout close grace period has elapsed')
    .option('--json', 'output as JSON', false)
    .action(async (channelId: string, options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const channelsClient = createChannelsClient(config);

      let localChannel: StoredChannel;
      const store = openChannelStoreOrExit(globalOpts.dataDir);
      try {
        localChannel = resolveBuyerChannelById(
          store.getAllChannelsByBuyer('buyer', address),
          channelId,
        );
      } finally {
        store.close();
      }

      const spinner = ora(`Withdrawing reserved funds for channel ${shortId(localChannel.sessionId, 18)}...`).start();
      try {
        const onChain = await channelsClient.getSession(localChannel.sessionId);
        if (onChain.buyer.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`Configured wallet ${address} is not the on-chain buyer for this channel.`);
        }
        if (onChain.status !== ON_CHAIN_STATUS_ACTIVE) {
          throw new Error(`On-chain channel is ${CHANNEL_STATUS_LABELS[onChain.status] ?? `status ${onChain.status}`}; nothing active remains to withdraw.`);
        }
        if (onChain.closeRequestedAt <= 0n) {
          throw new Error(`Close has not been requested yet. Run \`antseed buyer channels request-close ${localChannel.sessionId}\` first.`);
        }
        const waitSeconds = secondsUntilChannelWithdrawReady(
          onChain.closeRequestedAt,
          Math.floor(Date.now() / 1000),
        );
        if (waitSeconds > 0) {
          throw new Error(`Close grace period is not over yet. Try again in ${formatWait(waitSeconds)}.`);
        }

        const refund = onChain.deposit > onChain.settled ? onChain.deposit - onChain.settled : 0n;
        const txHash = await channelsClient.withdraw(wallet, localChannel.sessionId);
        spinner.succeed(chalk.green(`Withdrew reserved funds for ${shortId(localChannel.sessionId, 18)}`));
        if (options.json) {
          console.log(JSON.stringify({
            channelId: localChannel.sessionId,
            transaction: txHash,
            deposit: onChain.deposit.toString(),
            settled: onChain.settled.toString(),
            estimatedRefund: refund.toString(),
          }, null, 2));
          return;
        }
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log(chalk.dim(`Estimated released reserve: ${formatUsdc(refund)} USDC`));
      } catch (err) {
        spinner.fail(chalk.red(`Withdraw failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
