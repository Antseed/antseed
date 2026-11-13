import {
  Contract,
  FallbackProvider,
  FetchRequest,
  getBigInt,
  JsonRpcProvider,
  makeError,
  NonceManager,
  Network,
  type AbstractProvider,
  type AbstractSigner,
  type CallExceptionError,
  type InterfaceAbi,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import { hitFailpoint } from './failpoints.js';

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

function createJsonRpcProvider(url: string, network?: Network, opts?: object): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = JSON_RPC_REQUEST_TIMEOUT_MS;
  return new JsonRpcProvider(request, network, opts);
}

function buildProvider(rpcUrl: string, fallbackRpcUrls?: string[], evmChainId?: number): AbstractProvider {
  const network = evmChainId ? Network.from(evmChainId) : undefined;
  const opts = { batchMaxCount: 1, staticNetwork: network ? true : undefined };
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
  return new FallbackProvider(configs, network, { quorum: 1 });
}

function revertError(receipt: TransactionReceipt): CallExceptionError {
  return makeError('transaction execution reverted', 'CALL_EXCEPTION', {
    action: 'sendTransaction',
    data: null, reason: null, invocation: null, revert: null,
    transaction: { to: receipt.to, from: receipt.from, data: '' },
    receipt,
  });
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

/** The channel operations whose transactions carry fail points (`chain.<op>.*` in failpoints.ts). */
export type ChainFailpointOp = 'reserve' | 'top-up' | 'settle' | 'close' | 'request-close' | 'withdraw';

export abstract class BaseEvmClient {
  protected _provider: AbstractProvider;
  protected readonly _contractAddress: string;
  private readonly _nonceScope: string;

  constructor(rpcUrl: string, contractAddress: string, fallbackRpcUrls?: string[], evmChainId?: number) {
    this._provider = buildProvider(rpcUrl, fallbackRpcUrls, evmChainId);
    this._contractAddress = contractAddress;
    this._nonceScope = evmChainId ? `chain:${evmChainId}` : `rpc:${rpcUrl}`;
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

  /**
   * `_execWrite` whose speed-ups never raise the max fee per gas above `maxFeePerGasWei` (null: no
   * limit beyond MAX_SPEED_UP_TIP_WEI), for a write that only pays off below some gas price.
   */
  protected async _execWriteWithin(
    signer: AbstractSigner,
    maxFeePerGasWei: bigint | null,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, abi, connected);
    const populated = await contract.getFunction(method).populateTransaction(...args);
    const receipt = await this._sendAndWait(connected, signerAddress, populated, maxFeePerGasWei, this._failpointOp(method));
    return receipt.hash;
  }

  /** The fail point operation a contract method's transaction belongs to; null (the default) for a write without fail points. */
  protected _failpointOp(_method: string): ChainFailpointOp | null {
    return null;
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
    maxFeePerGasWei: bigint | null = null,
    failpointOp: ChainFailpointOp | null = null,
  ): Promise<TransactionReceipt> {
    const owner = {};
    if (failpointOp) await hitFailpoint(`chain.${failpointOp}.before-send`);
    const tx = await this._sendBuffered(connected, signerAddress, populated, owner);
    if (failpointOp) await hitFailpoint(`chain.${failpointOp}.after-send`);
    const replaceable = !(connected instanceof NonceManager) && typeof tx.nonce === 'number' && tx.nonce === populated.nonce;
    const receipt = await this._waitForReceipt(
      tx,
      replaceable ? () => this._speedUp(connected, signerAddress, populated, owner, maxFeePerGasWei) : undefined,
    );
    if (failpointOp) await hitFailpoint(`chain.${failpointOp}.after-receipt`);
    return receipt;
  }

  /**
   * Wait until `tx` is mined, in place of `tx.wait()`. ethers' wait polls
   * receipts from a block listener whose promise nobody handles, so a single
   * RPC timeout there is an unhandled rejection that exits the process. Here
   * read errors are retried; a revert throws CALL_EXCEPTION like `wait()`,
   * and a tx whose nonce was used by another tx throws as dropped/replaced.
   * With `speedUp`, a tx still not mined after SPEED_UP_AFTER_MS is sent
   * again on its nonce with higher fees, and whichever version mines counts.
   */
  protected async _waitForReceipt(
    tx: Pick<TransactionResponse, 'hash' | 'from' | 'nonce'>,
    speedUp?: () => Promise<Pick<TransactionResponse, 'hash'> | null>,
  ): Promise<TransactionReceipt> {
    const hashes = [tx.hash];
    let lastSentAt = Date.now();
    let speedUps = 0;
    for (let poll = 1; ; poll += 1) {
      try {
        for (const hash of hashes) {
          const receipt = await this._provider.getTransactionReceipt(hash);
          if (!receipt) continue;
          if (receipt.status === 0) throw revertError(receipt);
          return receipt;
        }
        if (poll % NONCE_CHECK_EVERY_POLLS === 0 && await this._nonceUsedElsewhere(tx, hashes)) {
          throw new Error('Transaction was dropped or replaced');
        }
        if (speedUp && speedUps < MAX_SPEED_UPS && Date.now() - lastSentAt >= SPEED_UP_AFTER_MS) {
          speedUps += 1;
          lastSentAt = Date.now();
          // A failed speed-up (the tx just mined, fees at the cap) leaves the versions already sent to mine.
          const replacement = await speedUp().catch(() => null);
          if (replacement) hashes.push(replacement.hash);
        }
      } catch (err) {
        if (err instanceof Error && ((err as Partial<CallExceptionError>).code === 'CALL_EXCEPTION' || err.message === 'Transaction was dropped or replaced')) {
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
   * and no less than a new tx would pay now). Null when the signer priced it, the tip is at the cap,
   * the replacement would cost more than `maxFeePerGasWei` allows, or the nonce now belongs to a
   * newer operation.
   */
  private async _speedUp(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    owner: object,
    maxFeePerGasWei: bigint | null,
  ): Promise<TransactionResponse | null> {
    if (populated.maxPriorityFeePerGas == null || populated.maxFeePerGas == null || populated.nonce == null) return null;
    const key = this._nonceKey(signerAddress);
    const ownerKey = `${key}:${populated.nonce}`;
    // An operation that lost its nonce prices no more replacements (checked again under the lock).
    if (nonceOwners.get(ownerKey) !== owner) return null;
    const prevTip = getBigInt(populated.maxPriorityFeePerGas);
    const prevMax = getBigInt(populated.maxFeePerGas);
    if (prevTip >= MAX_SPEED_UP_TIP_WEI) return null;
    const current = await this._feeFields();
    const bumpedTip = prevTip * 2n > prevTip + 1n ? prevTip * 2n : prevTip + 1n;
    const currentTip = current.maxPriorityFeePerGas != null ? getBigInt(current.maxPriorityFeePerGas) : 0n;
    const tip = min(MAX_SPEED_UP_TIP_WEI, max(bumpedTip, currentTip));
    const currentMax = current.maxFeePerGas != null ? getBigInt(current.maxFeePerGas) - currentTip + tip : 0n;
    const maxFee = max(prevMax + prevMax / 4n + (tip - prevTip), currentMax);
    if (maxFeePerGasWei !== null && maxFee > maxFeePerGasWei) return null;
    const replacement = { ...populated, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee };
    return this._withNonceLock(key, async () => {
      if (nonceOwners.get(ownerKey) !== owner) return null;
      const tx = await connected.sendTransaction(replacement);
      Object.assign(populated, { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee });
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
    for (const backend of this._backends()) {
      if (!(backend instanceof JsonRpcProvider)) continue;
      try {
        const history = await backend.send('eth_feeHistory', [`0x${RECENT_TIP_BLOCKS.toString(16)}`, 'latest', [RECENT_TIP_PERCENTILE]]) as { reward?: string[][] };
        const tips = (history.reward ?? [])
          .map((rewards) => getBigInt(rewards[0] ?? 0))
          .filter((tip) => tip > 0n)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return tips.length > 0 ? tips[tips.length >> 1]! : null;
      } catch {
        // RPC timeout, rate limit or no support: try the next backend.
      }
    }
    return null;
  }

  private _backends(): AbstractProvider[] {
    return this._provider instanceof FallbackProvider
      ? this._provider.providerConfigs.map((config) => config.provider)
      : [this._provider];
  }

  /**
   * eth_maxPriorityFeePerGas straight from the RPC, or null when no RPC answers. A FallbackProvider
   * answers getPriorityFee through each backend's getFeeData(), which hides a failed read behind the
   * same 1 gwei default, so its backends are asked one by one instead.
   */
  private async _readPriorityFee(): Promise<bigint | null> {
    for (const backend of this._backends()) {
      try {
        return getBigInt(await backend._perform({ method: 'getPriorityFee' }), '%response');
      } catch {
        // RPC timeout, rate limit or no support: try the next backend.
      }
    }
    return null;
  }

  /** Apply the gas buffer and fees, and broadcast on the signer's next nonce. */
  private async _sendBuffered(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
    owner?: object,
  ): Promise<TransactionResponse> {
    return this._sendWithNonce(signerAddress, async (nonce) => {
      populated.nonce = nonce;
      const estimated = await connected.estimateGas(populated);
      populated.gasLimit = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      if (populated.maxFeePerGas == null && populated.gasPrice == null) Object.assign(populated, await this._feeFields());
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
