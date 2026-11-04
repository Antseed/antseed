import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ColonyPoolClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const COLONY_POOL_ABI = [
  'function claimUsdc() external',
  'function claimAnts(uint256[] epochs) external',
  'function claimEpochEmissions(uint256[] epochs) external',
  'function setPayout(address worker, address payout, uint256 deadline, bytes signature) external',
  'function usdcBalance(address account) external view returns (uint256)',
  'function pendingAnts(address account, uint256[] epochs) external view returns (uint256)',
  'function epochAnts(uint256 epoch) external view returns (uint256)',
  'function payoutOf(address worker) external view returns (address)',
  'function payoutNonce(address worker) external view returns (uint256)',
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

  async setPayout(signer: AbstractSigner, authorization: WorkerPayoutAuthorization): Promise<string> {
    return this._execWrite(
      signer, COLONY_POOL_ABI, 'setPayout',
      authorization.worker, authorization.payout, authorization.deadline, authorization.signature,
    );
  }
}
