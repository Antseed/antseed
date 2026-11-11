import { computeCostUsdc, type ServicePricing } from '@antseed/buyer-core/pricing';
import type { WorkerPaymentProof } from '@antseed/buyer-core/worker-e2e';
import { makeChannelsDomain, SPENDING_AUTH_TYPES } from '@antseed/protocol/signatures';
import { decodeWorkerTail } from '@antseed/protocol/worker-attribution';
import { getAddress, keccak256, verifyTypedData } from 'ethers';

/**
 * Payment for a worker's earlier answers, checked before it serves the next
 * request on a channel (docs/protocol/colony-pool.md, "Paid before served").
 *
 * The buyer's request carries its latest SpendingAuth on the channel. The
 * worker checks that the channel's buyer signed it for the trusted Channels
 * contract, that the on-chain reserve covers it, and that the amount it
 * attributes to this worker pays for the worker's earlier answers on that
 * channel at the prices the pool declared. A buyer may be at most
 * MAX_UNPAID_ANSWERS answers behind, the request being admitted included.
 */

/** The buyer's latest SpendingAuth on a request's channel, as the request envelope carries it (`pay`). */
export type WorkerPayment = WorkerPaymentProof;

/** Answers on one channel a worker serves before they are paid, the one being admitted included. */
export const MAX_UNPAID_ANSWERS = 2;

/** Per-channel state kept by a worker; past this many channels the oldest is dropped. */
const MAX_TRACKED_CHANNELS = 10_000;

/** The trusted Channels deployment SpendingAuths are signed for. */
export interface ChannelsDomain {
  chainId: number;
  channelsAddress: string;
}

export function isWorkerPayment(value: unknown): value is WorkerPayment {
  if (typeof value !== 'object' || value === null) return false;
  const { cumulativeAmount, metadata, signature } = value as Record<string, unknown>;
  return typeof cumulativeAmount === 'string' && /^\d{1,39}$/.test(cumulativeAmount)
    && typeof metadata === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(metadata)
    && typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(signature);
}

/**
 * What `payment` attributes to `worker` on `channel`, once it is `buyer`'s
 * SpendingAuth for that channel and redeemable within `deposit` (the
 * channel's on-chain reserve). Throws otherwise.
 */
export function attributedPayment(
  payment: WorkerPayment,
  opts: { channel: string; buyer: string; worker: string; deposit: bigint; domain: ChannelsDomain },
): bigint {
  const cumulativeAmount = BigInt(payment.cumulativeAmount);
  const signer = verifyTypedData(
    makeChannelsDomain(opts.domain.chainId, getAddress(opts.domain.channelsAddress)),
    SPENDING_AUTH_TYPES,
    { channelId: opts.channel, cumulativeAmount, metadataHash: keccak256(payment.metadata) },
    payment.signature,
  );
  if (signer.toLowerCase() !== opts.buyer.toLowerCase()) throw new Error('The payment is not signed by the channel\'s buyer');
  if (cumulativeAmount > opts.deposit) throw new Error('The payment exceeds the channel\'s reserve');
  const entries = decodeWorkerTail(payment.metadata) ?? [];
  // The contract pays workers out of the settled amount: attribution beyond it is credit nothing funds.
  if (entries.reduce((sum, entry) => sum + entry.cumulativeAmount, 0n) > cumulativeAmount) {
    throw new Error('The payment attributes more to workers than it authorizes');
  }
  const worker = opts.worker.toLowerCase();
  return entries.find((entry) => entry.worker.toLowerCase() === worker)?.cumulativeAmount ?? 0n;
}

function count(value: unknown): bigint {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? BigInt(value) : 0n;
}

/** Token counts from an OpenAI-style (or Anthropic-style) usage object. */
export function usageCounts(usage: Record<string, unknown> | null): { inputTokens: bigint; cachedInputTokens: bigint; outputTokens: bigint } {
  if (!usage) return { inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n };
  const details = usage['prompt_tokens_details'] as { cached_tokens?: unknown } | undefined;
  const cached = count(details?.cached_tokens) + count(usage['cache_read_input_tokens']);
  // Anthropic-style input_tokens excludes cached tokens; prompt_tokens includes them.
  const input = usage['prompt_tokens'] !== undefined ? count(usage['prompt_tokens']) : count(usage['input_tokens']) + cached;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: count(usage['completion_tokens'] ?? usage['output_tokens']),
  };
}

/**
 * A price a worker serves at: some token costs something. At all-zero prices
 * every answer would cost nothing, so no payment could ever be owed.
 */
export function isChargeablePrice(price: ServicePricing | undefined): price is ServicePricing {
  return Boolean(price && (price.inputUsdPerMillion > 0 || price.outputUsdPerMillion > 0 || (price.cachedInputUsdPerMillion ?? 0) > 0));
}

/** USDC base units an answer costs at `price`: the buyer's own formula (computeCostUsdc). */
export function answerCostUsdc(usage: { inputTokens: bigint; cachedInputTokens: bigint; outputTokens: bigint }, price: ServicePricing): bigint {
  const fresh = usage.inputTokens > usage.cachedInputTokens ? usage.inputTokens - usage.cachedInputTokens : 0n;
  return computeCostUsdc(Number(fresh), Number(usage.outputTokens), price, Number(usage.cachedInputTokens));
}

interface ChannelAccount {
  /** The most a buyer-signed payment attributed to this worker (a lower, older one never lowers it). */
  paid: bigint;
  /** The cost of each answer served and not yet covered by `paid`, oldest first. */
  owed: bigint[];
  /** Cost of every answer served before `owed`. */
  settledCost: bigint;
  /** Requests admitted and still running. */
  running: number;
}

/**
 * A worker's account of what each channel owes it. `admit` before serving,
 * then `served` with the answer's cost, or `released` when no answer was
 * delivered. Kept in memory: a restarted worker starts every channel afresh.
 */
export class WorkerPaymentLedger {
  private readonly accounts = new Map<string, ChannelAccount>();

  /**
   * Admit a request on `channel` whose payment attributes `attributed` to this
   * worker, or throw when too many of its answers are unpaid.
   */
  admit(channel: string, attributed: bigint): void {
    const key = channel.toLowerCase();
    let account = this.accounts.get(key);
    if (!account) {
      if (this.accounts.size >= MAX_TRACKED_CHANNELS) this.accounts.delete(this.accounts.keys().next().value!);
      account = { paid: 0n, owed: [], settledCost: 0n, running: 0 };
      this.accounts.set(key, account);
    }
    if (attributed > account.paid) account.paid = attributed;
    // Answers paid for leave `owed`, oldest first. One whose cost rounds to
    // nothing is owed nothing: the buyer's payment never grows for it.
    while (account.owed.length > 0 && account.settledCost + account.owed[0]! <= account.paid) {
      account.settledCost += account.owed.shift()!;
    }
    if (account.owed.length + account.running + 1 > MAX_UNPAID_ANSWERS) {
      throw new Error(`Payment for this worker's earlier answers on this channel has not arrived (${account.owed.length} unpaid); retry once it is signed`);
    }
    account.running++;
  }

  /** The admitted request on `channel` delivered an answer costing `cost`. */
  served(channel: string, cost: bigint): void {
    const account = this.accounts.get(channel.toLowerCase());
    if (!account) return;
    account.running = Math.max(0, account.running - 1);
    account.owed.push(cost);
  }

  /** The admitted request on `channel` ended without an answer to pay for. */
  released(channel: string): void {
    const account = this.accounts.get(channel.toLowerCase());
    if (account) account.running = Math.max(0, account.running - 1);
  }
}
