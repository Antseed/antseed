import { computeUsageCostUsdc, type ServicePricing } from '@antseed/buyer-core/pricing';
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

/**
 * Answers on one channel a worker lets be cut off after some of it was sent
 * (cancelled, failed, or the pool connection dropped) within
 * INTERRUPTED_WINDOW_MS. The buyer never pays for such an answer (it can't
 * verify one without its end), so it isn't owed: it counts here instead, so
 * cancelling each answer before it completes gets no more than this many, and
 * an honest buyer whose answers broke off is served again once they age out.
 */
export const MAX_INTERRUPTED_ANSWERS = 2;
export const INTERRUPTED_WINDOW_MS = 30 * 60_000;

/** Per-channel accounts a worker keeps; past this many, the least recently used idle one is dropped. */
export const MAX_TRACKED_CHANNELS = 10_000;

/** Signed payments per channel whose settlement a worker has yet to see, kept to compare with what the pool credits. */
const MAX_CHECKPOINTS = 16;

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

/** USDC base units an answer costs at `price`: the buyer's own formula (computeUsageCostUsdc). */
export function answerCostUsdc(usage: { inputTokens: bigint; cachedInputTokens: bigint; outputTokens: bigint }, price: ServicePricing): bigint {
  return computeUsageCostUsdc(usage, price);
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
  /**
   * Signed payments not yet seen settled: [the channel's cumulative amount,
   * what it attributed to this worker], each attributing more than the last.
   */
  checkpoints: Array<[bigint, bigint]>;
  /** When each recent answer on the channel was cut off after some of it was sent (ms), oldest first. */
  interrupted: number[];
}

/** A worker ledger as stored between runs: amounts as decimal strings. */
export interface WorkerLedgerSnapshot {
  channels: Record<string, { paid: string; owed: string[]; settledCost: string; checkpoints: Array<[string, string]>; interrupted?: number[] }>;
}

/** Where a worker keeps its ledger, so a restart never forgets what earlier payments already paid for. */
export interface WorkerLedgerStore {
  load(): WorkerLedgerSnapshot | null;
  save(snapshot: WorkerLedgerSnapshot): void;
}

/**
 * A worker's account of what each channel owes it. `admit` before serving,
 * then `served` with the answer's cost, `interrupted` when it was cut off after
 * some of it was sent, or `released` when none was. With a store, every change is saved, so a restarted worker
 * resumes each channel where it was.
 *
 * Signed attribution is trusted until settlement shows otherwise: the pool
 * contract credits workers from the auth the pool settles, which may not be
 * the one the buyer showed this worker (an older one at the same amount, or
 * one whose attribution the settlement could not yet cover). `reconcile`
 * compares what was signed with what the contract credited once the channel
 * settled past it; what it left unpaid is owed again, for the buyer's later
 * payments and the pool's later settlements to cover.
 */
export class WorkerPaymentLedger {
  private readonly accounts = new Map<string, ChannelAccount>();

  constructor(private readonly store?: WorkerLedgerStore, private readonly now: () => number = Date.now) {
    const snapshot = store?.load();
    if (!snapshot) return;
    for (const [channel, stored] of Object.entries(snapshot.channels)) {
      this.accounts.set(channel, {
        paid: BigInt(stored.paid),
        owed: stored.owed.map(BigInt),
        settledCost: BigInt(stored.settledCost),
        running: 0,
        checkpoints: stored.checkpoints.map(([c, w]) => [BigInt(c), BigInt(w)]),
        interrupted: stored.interrupted ?? [],
      });
    }
  }

  /**
   * Admit a request on `channel` whose payment, at the channel's cumulative
   * amount `cumulative`, attributes `attributed` to this worker; throws when
   * too many of its answers are unpaid, or were cut off recently.
   */
  admit(channel: string, attributed: bigint, cumulative = 0n): void {
    const key = channel.toLowerCase();
    let account = this.accounts.get(key);
    if (account) {
      // Most recently used last, so eviction takes the stalest.
      this.accounts.delete(key);
    } else {
      if (this.accounts.size >= MAX_TRACKED_CHANNELS && !this.evictOne()) {
        throw new Error('This worker is serving too many channels at once to take another');
      }
      // A channel this worker no longer remembers: what its payment already
      // attributes paid for answers served before, never for new ones.
      account = { paid: attributed, owed: [], settledCost: attributed, running: 0, checkpoints: [], interrupted: [] };
    }
    this.accounts.set(key, account);
    if (attributed > account.paid) {
      account.paid = attributed;
      account.checkpoints.push([cumulative, attributed]);
      if (account.checkpoints.length > MAX_CHECKPOINTS) account.checkpoints.shift();
    }
    // Answers paid for leave `owed`, oldest first.
    while (account.owed.length > 0 && account.settledCost + account.owed[0]! <= account.paid) {
      account.settledCost += account.owed.shift()!;
    }
    if (account.owed.length + account.running + 1 > MAX_UNPAID_ANSWERS) {
      this.save();
      throw new Error(`Payment for this worker's earlier answers on this channel has not arrived (${account.owed.length} unpaid); retry once it is signed`);
    }
    const since = this.now() - INTERRUPTED_WINDOW_MS;
    account.interrupted = account.interrupted.filter((at) => at > since);
    if (account.interrupted.length >= MAX_INTERRUPTED_ANSWERS) {
      this.save();
      const retryInS = Math.ceil((account.interrupted[0]! - since) / 1000);
      throw new Error(`${account.interrupted.length} of this worker's answers on this channel were cut off recently; retry in ${retryInS}s`);
    }
    account.running++;
    this.save();
  }

  /** The admitted request on `channel` delivered an answer costing `cost`. One costing nothing is owed nothing. */
  served(channel: string, cost: bigint): void {
    const account = this.accounts.get(channel.toLowerCase());
    if (!account) return;
    account.running = Math.max(0, account.running - 1);
    if (cost > 0n) account.owed.push(cost);
    this.save();
  }

  /** The admitted request on `channel` was cut off after some of its answer was sent: not owed, but counted (MAX_INTERRUPTED_ANSWERS). */
  interrupted(channel: string): void {
    const account = this.accounts.get(channel.toLowerCase());
    if (!account) return;
    account.running = Math.max(0, account.running - 1);
    account.interrupted.push(this.now());
    if (account.interrupted.length > MAX_INTERRUPTED_ANSWERS) account.interrupted.shift();
    this.save();
  }

  /** Forget `channel`: it closed on-chain, so it never gets another request to replay a payment on. */
  forget(channel: string): void {
    if (this.accounts.delete(channel.toLowerCase())) this.save();
  }

  /** The admitted request on `channel` ended without an answer to pay for. */
  released(channel: string): void {
    const account = this.accounts.get(channel.toLowerCase());
    if (account) account.running = Math.max(0, account.running - 1);
  }

  /**
   * Compare what the buyer signed to this worker on `channel` with what the
   * pool contract credited it there (`credited`), now that the channel settled
   * up to `settled`. A payment settled past but credited short counts only as
   * far as the contract can still pay it: what it credited, plus what each
   * newer payment adds beyond the settlement. Answers it no longer covers are
   * owed again, so the buyer gets no further work until a later payment, or a
   * later settlement, pays for them. That is no misconduct: the pool may have
   * settled an older auth at the same amount, and the contract pays what a
   * settlement could not cover from the next one. Returns whether any was short.
   */
  reconcile(channel: string, settled: bigint, credited: bigint): boolean {
    const account = this.accounts.get(channel.toLowerCase());
    if (!account) return false;
    const short = account.checkpoints.some(([cumulative, attributed]) => cumulative <= settled && attributed > credited);
    account.checkpoints = account.checkpoints.filter(([cumulative]) => cumulative > settled);
    if (short) {
      let redeemable = credited;
      for (const [cumulative, attributed] of account.checkpoints) {
        const cap = credited + (cumulative - settled);
        const counted = attributed < cap ? attributed : cap;
        if (counted > redeemable) redeemable = counted;
      }
      if (redeemable < account.paid) {
        account.paid = redeemable;
        // Answers counted paid beyond it are owed again, ahead of the rest.
        if (account.settledCost > redeemable) {
          account.owed.unshift(account.settledCost - redeemable);
          account.settledCost = redeemable;
        }
      }
    }
    this.save();
    return short;
  }

  /**
   * Drop the least recently used account with nothing running. A buyer's last
   * answer on a channel stays owed until a payment the worker never sees, so
   * an idle account may still list it; dropping it forgives at most the
   * answers a channel may run ahead, as a fresh channel would get anyway, and
   * a forgotten channel's payment never pays for new answers (see admit).
   */
  private evictOne(): boolean {
    for (const [key, account] of this.accounts) {
      if (account.running === 0) {
        this.accounts.delete(key);
        return true;
      }
    }
    return false;
  }

  private save(): void {
    if (!this.store) return;
    const channels: WorkerLedgerSnapshot['channels'] = {};
    for (const [key, account] of this.accounts) {
      channels[key] = {
        paid: account.paid.toString(),
        owed: account.owed.map(String),
        settledCost: account.settledCost.toString(),
        checkpoints: account.checkpoints.map(([c, w]) => [c.toString(), w.toString()]),
        interrupted: account.interrupted,
      };
    }
    this.store.save({ channels });
  }
}
