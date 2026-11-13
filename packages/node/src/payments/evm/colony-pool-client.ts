import { Contract, getBytes, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ColonyPoolClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export const COLONY_POOL_ABI = [
  'function claimUsdc() external',
  'function claimAnts(uint256[] epochs) external',
  'function claimAntsFor(address worker, uint256[] epochs) external',
  'function payoutDigest(address worker, address payout, uint256 deadline) external view returns (bytes32)',
  'function claimEpochEmissions(uint256[] epochs) external',
  'function setPayout(address worker, address payout, uint256 deadline, bytes signature) external',
  'function usdcBalance(address account) external view returns (uint256)',
  'function pendingAnts(address account, uint256[] epochs) external view returns (uint256)',
  'function epochAnts(uint256 epoch) external view returns (uint256)',
  'function epochWeight(uint256 epoch, address account) external view returns (uint256)',
  'function payoutOf(address worker) external view returns (address)',
  'function payoutNonce(address worker) external view returns (uint256)',
  'function workerCredit(bytes32 channelId, address worker) external view returns (uint128 settled, uint128 credited)',
] as const;

/** A worker's signed instruction to pay its earnings to `payout` (see AntseedColonyPool.setPayout). */
export interface WorkerPayoutAuthorization {
  chainId: number;
  pool: string;
  worker: string;
  payout: string;
  deadline: number;
  signature: string;
}

const LINK_PREFIX = 'antseed-link:';

/** The `antseed-link:<base64url JSON>` code the ANTS dashboard submits (Rewards → Link a Mac). */
export function encodeWorkerPayoutLink(authorization: WorkerPayoutAuthorization): string {
  const { chainId, pool, worker, payout, deadline, signature } = authorization;
  return LINK_PREFIX + Buffer.from(JSON.stringify({ chainId, pool, worker, payout, deadline, signature }), 'utf-8').toString('base64url');
}

/** Parse the `antseed-link:<base64url JSON>` code the Mac app copies. Returns null when malformed. */
export function parseWorkerPayoutLink(code: string): WorkerPayoutAuthorization | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(LINK_PREFIX)) return null;
  try {
    const value = JSON.parse(Buffer.from(trimmed.slice(LINK_PREFIX.length), 'base64url').toString('utf-8')) as Partial<WorkerPayoutAuthorization>;
    const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
    if (!isAddress(value.pool) || !isAddress(value.worker) || !isAddress(value.payout)) return null;
    if (typeof value.chainId !== 'number' || typeof value.deadline !== 'number') return null;
    if (typeof value.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) return null;
    return value as WorkerPayoutAuthorization;
  } catch {
    return null;
  }
}

/** AntseedColonyPool: what a worker (or its payout wallet) is owed, and the calls to claim it. */
export class ColonyPoolClient extends BaseEvmClient {
  constructor(config: ColonyPoolClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private read(): Contract {
    return new Contract(this._contractAddress, COLONY_POOL_ABI, this._provider);
  }

  async usdcBalance(account: string): Promise<bigint> {
    return this.read().getFunction('usdcBalance')(account);
  }

  async pendingAnts(account: string, epochs: number[]): Promise<bigint> {
    if (epochs.length === 0) return 0n;
    return this.read().getFunction('pendingAnts')(account, epochs);
  }

  async epochAnts(epoch: number): Promise<bigint> {
    return this.read().getFunction('epochAnts')(epoch);
  }

  /** The account's credited weight in `epoch` (its share of that epoch's ANTS). */
  async epochWeight(epoch: number, account: string): Promise<bigint> {
    return this.read().getFunction('epochWeight')(epoch, account);
  }

  /**
   * What this pool settled on the channel and paid `worker` there, from one
   * read. null when no contract is deployed at the address: a seller that pays
   * its workers from its own address, with no credit on-chain to read.
   */
  async workerCredit(channelId: string, worker: string): Promise<{ settled: bigint; credited: bigint } | null> {
    try {
      const [settled, credited] = await this.read().getFunction('workerCredit')(channelId, worker) as [bigint, bigint];
      return { settled, credited };
    } catch (err) {
      if (await this._provider.getCode(this._contractAddress) === '0x') return null;
      throw err;
    }
  }

  async payoutOf(worker: string): Promise<string> {
    return this.read().getFunction('payoutOf')(worker);
  }

  async claimUsdc(signer: AbstractSigner): Promise<string> {
    return this._execWrite(signer, COLONY_POOL_ABI, 'claimUsdc');
  }

  /** Pull the pool's seller emissions for finished epochs into the contract (anyone may call). */
  async claimEpochEmissions(signer: AbstractSigner, epochs: number[]): Promise<string> {
    return this._execWrite(signer, COLONY_POOL_ABI, 'claimEpochEmissions', epochs);
  }

  async claimAnts(signer: AbstractSigner, epochs: number[]): Promise<string> {
    return this._execWrite(signer, COLONY_POOL_ABI, 'claimAnts', epochs);
  }

  /** Pay a linked worker's own ANTS for `epochs` (older than its link moved) to its payout wallet (anyone may call). */
  async claimAntsFor(signer: AbstractSigner, worker: string, epochs: number[]): Promise<string> {
    return this._execWrite(signer, COLONY_POOL_ABI, 'claimAntsFor', worker, epochs);
  }

  /**
   * The worker `signer` signs an instruction to pay its earnings to `payout`,
   * valid until `deadline` (unix seconds): the digest is the pool's own, so it
   * binds this chain, this pool and the worker's current nonce. Nothing is sent.
   */
  async signPayoutAuthorization(signer: AbstractSigner, payout: string, deadline: number): Promise<WorkerPayoutAuthorization> {
    const worker = await signer.getAddress();
    const digest = await this.read().getFunction('payoutDigest')(worker, payout, deadline) as string;
    const signature = await signer.signMessage(getBytes(digest));
    const { chainId } = await this._provider.getNetwork();
    return { chainId: Number(chainId), pool: this._contractAddress, worker, payout, deadline, signature };
  }

  async setPayout(signer: AbstractSigner, authorization: WorkerPayoutAuthorization): Promise<string> {
    return this._execWrite(
      signer, COLONY_POOL_ABI, 'setPayout',
      authorization.worker, authorization.payout, authorization.deadline, authorization.signature,
    );
  }
}
