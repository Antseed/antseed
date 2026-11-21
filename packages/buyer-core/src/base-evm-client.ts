import {
  Contract,
  encodeBase64,
  FallbackProvider,
  FetchRequest,
  getBigInt,
  isError,
  JsonRpcProvider,
  makeError,
  NonceManager,
  Network,
  toUtf8Bytes,
  type AbstractProvider,
  type AbstractSigner,
  type CallExceptionError,
  type FetchCancelSignal,
  type GetUrlResponse,
  type InterfaceAbi,
  type PerformActionRequest,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

const FALLBACK_STALL_TIMEOUT_MS = 750;

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const JSON_RPC_REQUEST_TIMEOUT_MS = 10_000;
const RECEIPT_POLL_MS = 2_000;
/** Polls between checks that the tx's nonce was not taken by another tx. */
const NONCE_CHECK_EVERY_POLLS = 5;
/** A tx not mined after this long is sent again on its nonce with higher fees. */
const SPEED_UP_AFTER_MS = 30_000;
const MAX_SPEED_UPS = 4;
/** A fee-capped write still unmined after this long is cancelled, so its nonce does not block the wallet. */
const CAPPED_WRITE_CANCEL_AFTER_MS = 120_000;
/** Highest tip a speed-up offers (0.5 gwei, about $0.25 on a 200k-gas tx at $2,500/ETH). */
const MAX_SPEED_UP_TIP_WEI = 500_000_000n;
/** Recent blocks whose low-end tips set the floor for a new tx's tip. */
const RECENT_TIP_BLOCKS = 10;
const RECENT_TIP_PERCENTILE = 10;
/** Most the recent-blocks floor raises a tip to (0.1 gwei), so one unusual block cannot price every tx. */
const MAX_RECENT_TIP_WEI = 100_000_000n;
/**
 * A nonce cursor ahead of the pending count is trusted this long after its last send. Past it, the
 * txs it counted were dropped (or never left one RPC backend), and the pending count is right.
 */
const NONCE_CURSOR_TRUST_MS = 60_000;

/**
 * `url` without its user and password, sent instead as a Basic Authorization header (unless one is
 * set), as Node's http module did: fetch refuses a URL with credentials in it.
 */
export function withUrlCredentials(url: string, headers: Record<string, string>): { url: string; headers: Record<string, string> } {
  const parsed = new URL(url);
  if (!parsed.username && !parsed.password) return { url, headers };
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  parsed.username = '';
  parsed.password = '';
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) return { url: parsed.href, headers };
  return { url: parsed.href, headers: { ...headers, authorization: `Basic ${encodeBase64(toUtf8Bytes(credentials))}` } };
}

/**
 * Send one RPC request with fetch, aborted once `req.timeout` has passed in total. ethers' Node
 * transport only times out a socket that goes quiet, so a response that keeps trickling in never
 * failed, and a write waiting on it held the signer's nonce lock, and every later write, forever.
 */
export async function fetchWithDeadline(req: FetchRequest, signal?: FetchCancelSignal): Promise<GetUrlResponse> {
  const controller = new AbortController();
  let cancelled = false;
  signal?.addListener(() => {
    cancelled = true;
    controller.abort();
  });
  const timer = setTimeout(() => controller.abort(), req.timeout);
  try {
    const { url, headers: requestHeaders } = withUrlCredentials(req.url, req.headers);
    const response = await fetch(url, {
      method: req.method,
      headers: requestHeaders,
      ...(req.body ? { body: new Uint8Array(req.body) } : {}),
      // Like ethers' own transport: an RPC POST is never redirected, so an HTTPS endpoint can't move it to plain HTTP.
      redirect: 'error',
      signal: controller.signal,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    return { statusCode: response.status, statusMessage: response.statusText, headers, body: body.length > 0 ? body : null };
  } catch (err) {
    if (cancelled) throw makeError('request cancelled', 'CANCELLED');
    if (controller.signal.aborted) throw makeError('request timeout', 'TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function createJsonRpcProvider(url: string, network?: Network, opts?: object): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = JSON_RPC_REQUEST_TIMEOUT_MS;
  request.getUrlFunc = fetchWithDeadline;
  return new JsonRpcProvider(request, network, opts);
}

export interface BaseEvmClientOptions {
  /**
   * How long ethers shares identical reads (`eth_blockNumber`, `eth_getLogs`, `eth_call`, ...), in
   * milliseconds; ethers' default is 250. `-1` turns the cache off, for a client that reads the chain
   * before and right after its own transaction: the second read, if identical and within 250 ms of the
   * first, is otherwise answered from the first one and misses the transaction's events.
   */
  cacheTimeout?: number;
  /**
   * Longest a write waits for its transaction to mine, in milliseconds, before it throws
   * `ReceiptWaitTimeoutError`. Unset (the default) waits until it mines, is dropped or reverts, as
   * a buyer or seller payment must; a periodic job sets it so one stuck transaction cannot hang it.
   */
  receiptWaitLimitMs?: number;
}

/** An answer from the chain itself, which another backend would give too, rather than a failed request. */
function isChainAnswer(err: unknown): boolean {
  return isError(err, 'CALL_EXCEPTION')
    || isError(err, 'INSUFFICIENT_FUNDS')
    || isError(err, 'NONCE_EXPIRED')
    || isError(err, 'REPLACEMENT_UNDERPRICED');
}

/**
 * Run `attempts` in order and settle with the first answer: the next attempt starts when the one
 * before fails or has not answered within `stallMs`, and the slower ones keep running (each request
 * ends at its own deadline). A chain answer (a revert) settles at once; when every attempt fails,
 * the first failure is thrown.
 */
function firstAnswer<T>(attempts: Array<() => Promise<T>>, stallMs: number): Promise<T> {
  if (attempts.length === 0) return Promise.reject(new Error('No RPC backend to ask'));
  return new Promise<T>((resolve, reject) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let firstError: unknown;
    const start = (): void => {
      if (settled || next >= attempts.length) return;
      const attempt = attempts[next++]!;
      running += 1;
      const stall = setTimeout(start, stallMs);
      attempt().then(
        (result) => {
          clearTimeout(stall);
          if (settled) return;
          settled = true;
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(stall);
          running -= 1;
          if (settled) return;
          if (isChainAnswer(err)) {
            settled = true;
            reject(err);
            return;
          }
          firstError ??= err;
          if (next < attempts.length) {
            start();
          } else if (running === 0) {
            settled = true;
            reject(firstError);
          }
        },
      );
    };
    start();
  });
}

/**
 * A FallbackProvider whose reads fail over. ethers' own starts the next backend when one stalls,
 * but the promises it then waits on leave the new backend out, so each read still waited for the
 * first backend to finish. Here a read goes to the backends in priority order (`firstAnswer`). A
 * broadcast still goes to every backend at once, as before.
 */
export class StaggeredFallbackProvider extends FallbackProvider {
  private _chainId?: Promise<bigint>;
  private _backendChainIds?: Map<AbstractProvider, Promise<bigint>>;

  override async _perform<T = unknown>(req: PerformActionRequest): Promise<T> {
    if (req.method === 'broadcastTransaction') return super._perform(req);
    const configs = [...this.providerConfigs].sort((a, b) => a.priority - b.priority);
    const stallMs = Math.min(...configs.map((config) => config.stallTimeout));
    // ethers checks that every backend is on one chain before it reads. Here each backend is
    // checked on its own, so a stalled one doesn't hold the others up: a backend on another
    // chain (a misconfigured fallback) fails like one that is down.
    const chainId = req.method === 'chainId' ? null : await this._expectedChainId();
    return firstAnswer(configs.map((config) => async () => {
      if (chainId !== null && await this._backendChainId(config.provider) !== chainId) {
        throw makeError('RPC backend is on another chain', 'NETWORK_ERROR', { event: 'changed' });
      }
      return this._translatePerform(config.provider, req) as Promise<T>;
    }), stallMs);
  }

  /** The chain this provider is on: its configured network, or the first backend that answers. */
  private _expectedChainId(): Promise<bigint> {
    if (!this._chainId) {
      const chainId = this.getNetwork().then((network) => network.chainId);
      chainId.catch(() => { if (this._chainId === chainId) this._chainId = undefined; });
      this._chainId = chainId;
    }
    return this._chainId;
  }

  private _backendChainId(provider: AbstractProvider): Promise<bigint> {
    this._backendChainIds ??= new Map();
    let chainId = this._backendChainIds.get(provider);
    if (!chainId) {
      const read = provider.getNetwork().then((network) => network.chainId);
      read.catch(() => { if (this._backendChainIds?.get(provider) === read) this._backendChainIds.delete(provider); });
      this._backendChainIds.set(provider, read);
      chainId = read;
    }
    return chainId;
  }
}

function buildProvider(
  rpcUrl: string, fallbackRpcUrls?: string[], evmChainId?: number, options: BaseEvmClientOptions = {},
): AbstractProvider {
  const network = evmChainId ? Network.from(evmChainId) : undefined;
  const opts = {
    batchMaxCount: 1,
    staticNetwork: network ? true : undefined,
    ...(options.cacheTimeout === undefined ? {} : { cacheTimeout: options.cacheTimeout }),
  };
  if (!fallbackRpcUrls || fallbackRpcUrls.length === 0) {
    return createJsonRpcProvider(rpcUrl, network, opts);
  }
  const urls = [rpcUrl, ...fallbackRpcUrls];
  const configs = urls.map((url, i) => ({
    provider: createJsonRpcProvider(url, network, opts),
    priority: i + 1,
    stallTimeout: FALLBACK_STALL_TIMEOUT_MS,
    weight: 1,
  }));
  // The fallback provider has a read cache of its own, in front of its backends': disable both.
  return new StaggeredFallbackProvider(configs, network, {
    quorum: 1,
    ...(options.cacheTimeout === undefined ? {} : { cacheTimeout: options.cacheTimeout }),
  });
}

function revertError(receipt: TransactionReceipt): CallExceptionError {
  return makeError('transaction execution reverted', 'CALL_EXCEPTION', {
    action: 'sendTransaction',
    data: null, reason: null, invocation: null, revert: null,
    transaction: { to: receipt.to, from: receipt.from, data: '' },
    receipt,
  });
}

/**
 * A sent transaction that was not mined within the client's receipt wait limit
 * (`receiptWaitLimitMs`). It may still mine: callers must not send the same
 * operation again while the wallet has a pending transaction.
 */
export class ReceiptWaitTimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(readonly hashes: readonly string[], readonly waitedMs: number) {
    super(`transaction ${hashes.at(-1)} was sent but not mined within ${Math.round(waitedMs / 1_000)} s`);
    this.name = 'ReceiptWaitTimeoutError';
  }
}

/**
 * A fee-capped write that did not mine in time (see `WriteFeeLimit`) and was replaced on its nonce
 * by a 0-value transfer to the signer. The write itself never ran.
 */
export class TransactionCancelledError extends Error {
  readonly code = 'TX_CANCELLED';
  constructor(readonly hashes: readonly string[], readonly cancelHash: string) {
    super(`transaction ${hashes[0]} was cancelled by ${cancelHash}: it did not mine within its fee limit in time`);
    this.name = 'TransactionCancelledError';
  }
}

/**
 * For a write that only pays off below some gas price. Its first send and speed-ups never offer a
 * max fee per gas above `maxFeePerGasWei`. If it has not mined by CAPPED_WRITE_CANCEL_AFTER_MS, or by
 * `cancelByMs` (ms since epoch) when that is sooner, it is cancelled: its nonce gets a 0-value
 * transfer to the signer at market fees, and the write throws TransactionCancelledError. From then on
 * the write is not sped up, even with room left under the cap. A client `receiptWaitLimitMs` that
 * ends the wait first leaves the write pending, uncancelled.
 */
export interface WriteFeeLimit {
  maxFeePerGasWei: bigint;
  cancelByMs?: number;
}

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

/** Gas limit buffer multiplier over `eth_estimateGas` (30%). Protects against
 *  non-deterministic gas in contract branches (cold vs. warm SSTOREs, try/catch
 *  fallback paths, variable-length metadata hashing) — without a buffer, a tx
 *  whose actual gas is even a hair above the estimate reverts with OOG. */
const GAS_BUFFER_NUMERATOR = 130n;
const GAS_BUFFER_DENOMINATOR = 100n;

/** Tip used when no RPC reports one: about a normal Base tip (0.001 gwei), not ethers' 1 gwei fallback. */
export const DEFAULT_PRIORITY_FEE_WEI = 1_000_000n;

/**
 * Next nonce and reservation lock per chain and signer, shared by every client
 * in the process. A seller signs with one wallet from several clients
 * (channels, free usage, ...); per-client cursors let two of them pick the
 * same nonce, and the second send fails with "replacement fee too low".
 */
const nonceCursors = new Map<string, { next: number; at: number }>();
const nonceLocks = new Map<string, Promise<void>>();
/**
 * The operation each sent nonce belongs to. A stale cursor can hand a dropped tx's nonce to a newer
 * operation; the older one's speed-ups then stop, so they cannot replace the newer tx.
 */
const nonceOwners = new Map<string, object>();
const MAX_NONCE_OWNERS = 1_024;

export abstract class BaseEvmClient {
  protected _provider: AbstractProvider;
  protected readonly _contractAddress: string;
  private readonly _nonceScope: string;
  private readonly _receiptWaitLimitMs: number | null;

  constructor(
    rpcUrl: string, contractAddress: string, fallbackRpcUrls?: string[], evmChainId?: number, options?: BaseEvmClientOptions,
  ) {
    this._provider = buildProvider(rpcUrl, fallbackRpcUrls, evmChainId, options);
    this._contractAddress = contractAddress;
    this._nonceScope = evmChainId ? `chain:${evmChainId}` : `rpc:${rpcUrl}`;
    this._receiptWaitLimitMs = options?.receiptWaitLimitMs ?? null;
  }

  get provider(): AbstractProvider { return this._provider; }

  /**
   * Route every read and write through `provider` instead of the one built
   * from the RPC URLs, e.g. a single batching provider shared by many clients.
   */
  withProvider(provider: AbstractProvider): this {
    this._provider = provider;
    return this;
  }
  get contractAddress(): string { return this._contractAddress; }

  protected _ensureConnected(signer: AbstractSigner): AbstractSigner {
    if (signer.provider) return signer;
    return signer.connect(this._provider);
  }

  protected async _execWrite(
    signer: AbstractSigner,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    return this._execWriteWithin(signer, null, abi, method, ...args);
  }

  /** `_execWrite` within `limit` (see `WriteFeeLimit`); null is no limit beyond MAX_SPEED_UP_TIP_WEI. */
  protected async _execWriteWithin(
    signer: AbstractSigner,
    limit: WriteFeeLimit | null,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, abi, connected);
    const populated = await contract.getFunction(method).populateTransaction(...args);
    const receipt = await this._sendAndWait(connected, signerAddress, populated, limit);
    return receipt.hash;
  }

  /**
   * Approve USDC spending then execute a contract method.
   */
  protected async _approveAndExec(
    signer: AbstractSigner,
    usdcAddress: string,
    amount: bigint,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(usdcAddress, ERC20_ABI, connected);
    const approvePopulated = await usdc.getFunction('approve').populateTransaction(this._contractAddress, amount);
    await this._sendAndWait(connected, signerAddress, approvePopulated);
    return this._execWrite(signer, abi, method, ...args);
  }

  /**
   * Send `populated` on the signer's next nonce and wait until it mines, speeding it up when it
   * stalls. Only a tx broadcast on the nonce assigned here is sped up: a signer that picks its own
   * nonce (ethers NonceManager) would send the replacement as a second operation.
   */
  private async _sendAndWait(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    limit: WriteFeeLimit | null = null,
  ): Promise<TransactionReceipt> {
    const owner = {};
    const maxFeePerGasWei = limit?.maxFeePerGasWei ?? null;
    // Once cancelled, speed-ups bump the cancel past both the fee cap and the speed-up tip cap, or a
    // cancel priced near that tip could not follow a rising base fee (at most MAX_SPEED_UPS bumps).
    let cancelled = false;
    const tx = await this._sendBuffered(connected, signerAddress, populated, owner, maxFeePerGasWei);
    const sentAt = Date.now();
    const replaceable = !(connected instanceof NonceManager) && typeof tx.nonce === 'number' && tx.nonce === populated.nonce;
    const cancel = replaceable && limit ? {
      atMs: Math.min(sentAt + CAPPED_WRITE_CANCEL_AFTER_MS, limit.cancelByMs ?? Infinity),
      send: async () => {
        const sent = await this._cancel(connected, signerAddress, populated, owner);
        if (sent) cancelled = true;
        return sent;
      },
    } : undefined;
    return this._waitForReceipt(
      tx,
      replaceable
        ? () => this._speedUp(connected, signerAddress, populated, owner, cancelled ? null : maxFeePerGasWei, cancelled ? null : MAX_SPEED_UP_TIP_WEI)
        : undefined,
      cancel,
    );
  }

  /**
   * Wait until `tx` is mined, in place of `tx.wait()`. ethers' wait polls
   * receipts from a block listener whose promise nobody handles, so a single
   * RPC timeout there is an unhandled rejection that exits the process. Here
   * read errors are retried; a revert throws CALL_EXCEPTION like `wait()`,
   * and a tx whose nonce was used by another tx throws as dropped/replaced.
   * With `speedUp`, a tx still not mined after SPEED_UP_AFTER_MS is sent
   * again on its nonce with higher fees, and whichever version mines counts.
   * With `cancel`, a tx still not mined at `cancel.atMs` is replaced by the
   * cancel, which `speedUp` then bumps; if the cancel mines, the wait throws
   * TransactionCancelledError.
   */
  protected async _waitForReceipt(
    tx: Pick<TransactionResponse, 'hash' | 'from' | 'nonce'>,
    speedUp?: () => Promise<Pick<TransactionResponse, 'hash'> | null>,
    cancel?: { atMs: number; send: () => Promise<Pick<TransactionResponse, 'hash'> | null> },
  ): Promise<TransactionReceipt> {
    const hashes = [tx.hash];
    const startedAt = Date.now();
    let lastSentAt = startedAt;
    let speedUps = 0;
    let cancelIndex = -1; // where the cancel's versions start in `hashes`
    for (let poll = 1; ; poll += 1) {
      if (this._receiptWaitLimitMs !== null && poll > 1 && Date.now() - startedAt >= this._receiptWaitLimitMs) {
        throw new ReceiptWaitTimeoutError(hashes, Date.now() - startedAt);
      }
      try {
        for (const [i, hash] of hashes.entries()) {
          const receipt = await this._provider.getTransactionReceipt(hash);
          if (!receipt) continue;
          if (cancelIndex >= 0 && i >= cancelIndex) throw new TransactionCancelledError(hashes.slice(0, cancelIndex), hash);
          if (receipt.status === 0) throw revertError(receipt);
          return receipt;
        }
        if (poll % NONCE_CHECK_EVERY_POLLS === 0 && await this._nonceUsedElsewhere(tx, hashes)) {
          throw new Error('Transaction was dropped or replaced');
        }
        if (cancel && cancelIndex < 0 && Date.now() >= cancel.atMs) {
          // Retried every poll until it is sent (fees unreadable, an RPC error). A cancel broadcast
          // whose response was lost is not known here: if it mines, the wait ends as dropped/replaced.
          const sent = await cancel.send().catch(() => null);
          if (sent) {
            cancelIndex = hashes.length;
            hashes.push(sent.hash);
            speedUps = 0;
            lastSentAt = Date.now();
          }
        } else if (speedUp && speedUps < MAX_SPEED_UPS && Date.now() - lastSentAt >= SPEED_UP_AFTER_MS) {
          speedUps += 1;
          lastSentAt = Date.now();
          // A failed speed-up (the tx just mined, fees at the cap) leaves the versions already sent to mine.
          const replacement = await speedUp().catch(() => null);
          if (replacement) hashes.push(replacement.hash);
        }
      } catch (err) {
        if (err instanceof TransactionCancelledError || (err instanceof Error && ((err as Partial<CallExceptionError>).code === 'CALL_EXCEPTION' || err.message === 'Transaction was dropped or replaced'))) {
          throw err;
        }
        // Transient RPC failure (timeout, 5xx, rate limit): poll again.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
    }
  }

  /** The tx's nonce is mined but none of its versions has a receipt (checked after the nonce read, to not race its mining). */
  private async _nonceUsedElsewhere(tx: Pick<TransactionResponse, 'hash' | 'from' | 'nonce'>, hashes: string[]): Promise<boolean> {
    if (!tx.from || typeof tx.nonce !== 'number') return false;
    const mined = await this._provider.getTransactionCount(tx.from, 'latest');
    if (mined <= tx.nonce) return false;
    for (const hash of hashes) {
      if (await this._provider.getTransactionReceipt(hash)) return false;
    }
    return true;
  }

  /**
   * Send `populated` again on the same nonce with fees high enough to replace it (at least 25% more,
   * and no less than a new tx would pay now). Null when the signer priced it, the tip is at `tipCap`,
   * the replacement would cost more than `maxFeePerGasWei` allows, or the nonce now belongs to a
   * newer operation.
   */
  private async _speedUp(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    owner: object,
    maxFeePerGasWei: bigint | null,
    tipCap: bigint | null = MAX_SPEED_UP_TIP_WEI,
  ): Promise<TransactionResponse | null> {
    if (populated.maxPriorityFeePerGas == null || populated.maxFeePerGas == null || populated.nonce == null) return null;
    const key = this._nonceKey(signerAddress);
    const ownerKey = `${key}:${populated.nonce}`;
    // An operation that lost its nonce prices no more replacements (checked again under the lock).
    if (nonceOwners.get(ownerKey) !== owner) return null;
    // At the tip cap no replacement is possible, so skip the fee reads.
    if (tipCap !== null && getBigInt(populated.maxPriorityFeePerGas) >= tipCap) return null;
    const fees = this._replacementFees(populated, await this._feeFields(), tipCap);
    if (maxFeePerGasWei !== null && fees.maxFeePerGas > maxFeePerGasWei) return null;
    const replacement = { ...populated, ...fees };
    return this._withNonceLock(key, async () => {
      if (nonceOwners.get(ownerKey) !== owner) return null;
      const tx = await connected.sendTransaction(replacement);
      Object.assign(populated, fees);
      return tx;
    });
  }

  /**
   * Fees that replace `populated` on its nonce: the tip doubled (or the current one, if higher) and a
   * max fee 25% higher (or what a new tx would pay now). The tip stops at `tipCap`; a cancel and its
   * bumps have none, or a write priced near that tip could never be cancelled.
   */
  private _replacementFees(
    populated: TransactionRequest,
    current: Pick<TransactionRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'>,
    tipCap: bigint | null = MAX_SPEED_UP_TIP_WEI,
  ): { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } {
    const prevTip = getBigInt(populated.maxPriorityFeePerGas ?? 0);
    const prevMax = getBigInt(populated.maxFeePerGas ?? 0);
    const bumpedTip = prevTip * 2n > prevTip + 1n ? prevTip * 2n : prevTip + 1n;
    const currentTip = current.maxPriorityFeePerGas != null ? getBigInt(current.maxPriorityFeePerGas) : 0n;
    const tip = tipCap !== null ? min(tipCap, max(bumpedTip, currentTip)) : max(bumpedTip, currentTip);
    const currentMax = current.maxFeePerGas != null ? getBigInt(current.maxFeePerGas) - currentTip + tip : 0n;
    return { maxPriorityFeePerGas: tip, maxFeePerGas: max(prevMax + prevMax / 4n + (tip - prevTip), currentMax) };
  }

  /**
   * Replace `populated` on its nonce with a 0-value transfer to the signer at market fees, so a write
   * that cannot mine within its fee limit stops blocking the wallet's later nonces. `populated` then
   * holds the cancel, so speed-ups bump it. Null when the fees cannot be read (the caller retries) or
   * the nonce now belongs to a newer operation.
   */
  private async _cancel(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    owner: object,
  ): Promise<TransactionResponse | null> {
    if (populated.nonce == null) return null;
    const key = this._nonceKey(signerAddress);
    const ownerKey = `${key}:${populated.nonce}`;
    if (nonceOwners.get(ownerKey) !== owner) return null;
    const current = await this._feeFields();
    if (current.maxFeePerGas == null) return null;
    const fees = this._replacementFees(populated, current, null);
    const transfer = { to: signerAddress, value: 0n, data: '0x' };
    // Estimated, not 21,000: a delegated (EIP-7702) account runs code on a call to itself.
    const estimated = await connected.estimateGas({ ...transfer, from: signerAddress });
    const cancelTx: TransactionRequest = {
      ...transfer,
      nonce: populated.nonce,
      gasLimit: (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR,
      ...fees,
    };
    return this._withNonceLock(key, async () => {
      if (nonceOwners.get(ownerKey) !== owner) return null;
      const tx = await connected.sendTransaction(cancelTx);
      Object.assign(populated, cancelTx);
      return tx;
    });
  }

  /**
   * EIP-1559 fees for the next write. Left to the signer, ethers' getFeeData() turns a failed
   * eth_maxPriorityFeePerGas read into a 1 gwei tip, 100-1000x a normal Base tip, without any error.
   * Here the tip is read directly and a failure falls back to DEFAULT_PRIORITY_FEE_WEI instead. If the
   * base fee cannot be read, or the chain has none, the signer prices the transaction as before.
   */
  protected async _feeFields(): Promise<Pick<TransactionRequest, 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    let baseFee: bigint | null | undefined;
    try {
      baseFee = (await this._provider.getBlock('latest'))?.baseFeePerGas;
    } catch {
      return {};
    }
    if (baseFee == null) return {};
    const [suggested, recent] = await Promise.all([this._readPriorityFee(), this._readRecentTip()]);
    // The RPC's suggestion can trail what blocks include (0.001 gwei while blocks take 0.02), and a tx
    // below that waits unmined; a delegated (EIP-7702) account then cannot send anything else.
    const tip = max(suggested ?? DEFAULT_PRIORITY_FEE_WEI, min(recent ?? 0n, MAX_RECENT_TIP_WEI));
    return { maxPriorityFeePerGas: tip, maxFeePerGas: baseFee * 2n + tip };
  }

  /** Median over recent blocks of their RECENT_TIP_PERCENTILE tip (eth_feeHistory), or null when no RPC answers. */
  private async _readRecentTip(): Promise<bigint | null> {
    const backends = this._backends().filter((backend) => backend instanceof JsonRpcProvider);
    // An RPC timeout, rate limit or no support moves on to the next backend.
    return firstAnswer(backends.map((backend) => async () => {
      const history = await backend.send('eth_feeHistory', [`0x${RECENT_TIP_BLOCKS.toString(16)}`, 'latest', [RECENT_TIP_PERCENTILE]]) as { reward?: string[][] };
      const tips = (history.reward ?? [])
        .map((rewards) => getBigInt(rewards[0] ?? 0))
        .filter((tip) => tip > 0n)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return tips.length > 0 ? tips[tips.length >> 1]! : null;
    }), FALLBACK_STALL_TIMEOUT_MS).catch(() => null);
  }

  private _backends(): AbstractProvider[] {
    return this._provider instanceof FallbackProvider
      ? this._provider.providerConfigs.map((config) => config.provider)
      : [this._provider];
  }

  /**
   * eth_maxPriorityFeePerGas straight from the RPC, or null when no RPC answers. A FallbackProvider
   * answers getPriorityFee through each backend's getFeeData(), which hides a failed read behind the
   * same 1 gwei default, so its backends are asked directly instead.
   */
  private async _readPriorityFee(): Promise<bigint | null> {
    // An RPC timeout, rate limit or no support moves on to the next backend.
    return firstAnswer(this._backends().map((backend) => async () => (
      getBigInt(await backend._perform({ method: 'getPriorityFee' }), '%response')
    )), FALLBACK_STALL_TIMEOUT_MS).catch(() => null);
  }

  /** Apply the gas buffer and fees, and broadcast on the signer's next nonce. */
  private async _sendBuffered(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    owner?: object,
    maxFeePerGasWei: bigint | null = null,
  ): Promise<TransactionResponse> {
    return this._sendWithNonce(signerAddress, async (nonce) => {
      populated.nonce = nonce;
      const estimated = await connected.estimateGas(populated);
      populated.gasLimit = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      if (populated.maxFeePerGas == null && populated.gasPrice == null) Object.assign(populated, await this._feeFields());
      // A capped write never offers more per gas than it can afford, even if the base fee climbs
      // while it waits. Clamped at the cap, it cannot be sped up (a replacement must offer more).
      // Without fee fields the signer would price it uncapped, so it is not sent.
      if (maxFeePerGasWei !== null) {
        if (populated.maxFeePerGas == null) throw new Error('cannot read the base fee to price a fee-capped transaction');
        populated.maxFeePerGas = min(getBigInt(populated.maxFeePerGas), maxFeePerGasWei);
        if (populated.maxPriorityFeePerGas != null) {
          populated.maxPriorityFeePerGas = min(getBigInt(populated.maxPriorityFeePerGas), maxFeePerGasWei);
        }
      }
      return connected.sendTransaction(populated);
    }, owner);
  }

  /**
   * Run `send` with the signer's next nonce. The wallet's lock is held until
   * `send` returns (the node accepted the tx), and the cursor only moves past
   * a nonce once its tx is sent. A failed send (estimateGas revert, RPC
   * error) leaves the cursor alone, so its nonce goes to the next tx; the
   * pending count may not include txs that were sent but not yet mined, so
   * it cannot be trusted alone right after a send; a cursor older than
   * NONCE_CURSOR_TRUST_MS is dropped, so txs that were never mined cannot
   * leave every later send on a nonce gap. The sent nonce then belongs to
   * `owner` (see nonceOwners).
   */
  protected async _sendWithNonce<T>(address: string, send: (nonce: number) => Promise<T>, owner: object = {}): Promise<T> {
    const key = this._nonceKey(address);
    return this._withNonceLock(key, async () => {
      const networkNonce = await this._provider.getTransactionCount(address, 'pending');
      const cursor = nonceCursors.get(key);
      const trustCursor = cursor !== undefined && Date.now() - cursor.at < NONCE_CURSOR_TRUST_MS;
      const nonce = trustCursor ? Math.max(networkNonce, cursor.next) : networkNonce;
      const result = await send(nonce);
      nonceCursors.set(key, { next: nonce + 1, at: Date.now() });
      nonceOwners.delete(`${key}:${nonce}`);
      nonceOwners.set(`${key}:${nonce}`, owner);
      if (nonceOwners.size > MAX_NONCE_OWNERS) {
        const oldest = nonceOwners.keys().next().value;
        if (oldest !== undefined) nonceOwners.delete(oldest);
      }
      return result;
    });
  }

  /** Run `fn` holding the signer's nonce lock, shared by every client in the process. */
  private async _withNonceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = nonceLocks.get(key) ?? Promise.resolve();
    let release: () => void;
    const lock = new Promise<void>(r => { release = r; });
    nonceLocks.set(key, lock);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private _nonceKey(address: string): string {
    return `${this._nonceScope}:${address}`;
  }
}
