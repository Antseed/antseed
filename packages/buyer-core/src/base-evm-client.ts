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

export abstract class BaseEvmClient {
  protected _provider: AbstractProvider;
  protected readonly _contractAddress: string;
  protected readonly _nonceCursor = new Map<string, number>();
  private readonly _nonceLocks = new Map<string, Promise<void>>();

  constructor(rpcUrl: string, contractAddress: string, fallbackRpcUrls?: string[], evmChainId?: number) {
    this._provider = buildProvider(rpcUrl, fallbackRpcUrls, evmChainId);
    this._contractAddress = contractAddress;
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

  /**
   * Reserve a nonce, apply the gas buffer, and broadcast. On any failure —
   * estimateGas revert, RPC timeout, submission error — roll back the nonce
   * cursor. `_reserveNonce` reads `getTransactionCount(..., 'pending')` on
   * the next call, so an in-flight tx (if sendTransaction failed after the
   * node accepted it) is still accounted for and we won't reuse its nonce.
   */
  private async _sendBuffered(
    connected: AbstractSigner,
    signerAddress: string,
    populated: TransactionRequest,
  ): Promise<TransactionResponse> {
    const nonce = await this._reserveNonce(signerAddress);
    populated.nonce = nonce;
    try {
      const estimated = await connected.estimateGas(populated);
      populated.gasLimit = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
      return await connected.sendTransaction(populated);
    } catch (err) {
      this._nonceCursor.delete(signerAddress);
      throw err;
    }
  }

  protected async _reserveNonce(address: string): Promise<number> {
    // Serialize nonce reservation per address to prevent concurrent calls
    // from reading the same network nonce before either updates the cursor
    const prev = this._nonceLocks.get(address) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>(r => { resolve = r; });
    this._nonceLocks.set(address, lock);

    await prev;
    try {
      const networkNonce = await this._provider.getTransactionCount(address, 'pending');
      const cachedNext = this._nonceCursor.get(address);
      const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
      this._nonceCursor.set(address, nonce + 1);
      return nonce;
    } finally {
      resolve!();
    }
  }
}
