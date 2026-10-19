import {
  Contract,
  FallbackProvider,
  FetchRequest,
  JsonRpcProvider,
  Network,
  type AbstractProvider,
  type AbstractSigner,
  type InterfaceAbi,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';

const FALLBACK_STALL_TIMEOUT_MS = 750;
const JSON_RPC_REQUEST_TIMEOUT_MS = 10_000;

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

/**
 * Next nonce and reservation lock per chain and signer, shared by every client
 * in the process. A seller signs with one wallet from several clients
 * (channels, free usage, ...); per-client cursors let two of them pick the
 * same nonce, and the second send fails with "replacement fee too low".
 */
const nonceCursors = new Map<string, number>();
const nonceLocks = new Map<string, Promise<void>>();

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
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, abi, connected);
    const populated = await contract.getFunction(method).populateTransaction(...args);
    const tx = await this._sendBuffered(connected, signerAddress, populated);
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
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
    const approveTx = await this._sendBuffered(connected, signerAddress, approvePopulated);
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Approve transaction was dropped or replaced');
    return this._execWrite(signer, abi, method, ...args);
  }

  /** Apply the gas buffer and broadcast on the signer's next nonce. */
  private async _sendBuffered(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
  ): Promise<TransactionResponse> {
    return this._sendWithNonce(signerAddress, async (nonce) => {
      populated.nonce = nonce;
      const estimated = await connected.estimateGas(populated);
      populated.gasLimit = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      return connected.sendTransaction(populated);
    });
  }

  /**
   * Run `send` with the signer's next nonce. The wallet's lock is held until
   * `send` returns (the node accepted the tx), and the cursor only moves past
   * a nonce once its tx is sent. A failed send (estimateGas revert, RPC
   * error) leaves the cursor alone, so its nonce goes to the next tx; the
   * pending count may not include txs that were sent but not yet mined, so
   * it cannot be trusted alone.
   */
  protected async _sendWithNonce<T>(address: string, send: (nonce: number) => Promise<T>): Promise<T> {
    const key = this._nonceKey(address);
    const prev = nonceLocks.get(key) ?? Promise.resolve();
    let release: () => void;
    const lock = new Promise<void>(r => { release = r; });
    nonceLocks.set(key, lock);

    await prev;
    try {
      const networkNonce = await this._provider.getTransactionCount(address, 'pending');
      const cachedNext = nonceCursors.get(key);
      const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
      const result = await send(nonce);
      nonceCursors.set(key, nonce + 1);
      return result;
    } finally {
      release!();
    }
  }

  private _nonceKey(address: string): string {
    return `${this._nonceScope}:${address}`;
  }
}
