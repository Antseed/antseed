import {
  Contract,
  EventLog,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type AbstractSigner,
  type ContractEventName,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from './block-range.js';

export interface VerifierClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
  /**
   * Block the verification contract was deployed at. Default lower bound for
   * event queries; without it, queries require an explicit `fromBlock`.
   */
  deploymentBlock?: number;
  /** Max blocks per `eth_getLogs` window (defaults to 10k). */
  logQueryChunkBlocks?: number;
}

export interface ServiceResultInput {
  serviceHash: string;
  modelHash: string;
  passed: boolean;
}

export interface SubmitAuditInput {
  agentId: bigint;
  results: ServiceResultInput[];
  evidenceHash: string;
  evidenceUri: string;
}

export interface ServiceAuditedEvent {
  agentId: bigint;
  serviceHash: string;
  modelHash: string;
  passed: boolean;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface AgentAuditedEvent {
  agentId: bigint;
  auditor: string;
  passed: boolean;
  verifiedUntil: bigint;
  evidenceHash: string;
  evidenceUri: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFICATION_ABI = [
  'function setAuditor(address auditor, bool approved) external',
  'function submitAudit(uint256 agentId,(bytes32 serviceHash,bytes32 modelHash,bool passed)[] results,bytes32 evidenceHash,string evidenceUri) external',
  'function verifiedUntil(uint256 agentId) external view returns (uint64)',
  'function isVerified(uint256 agentId) external view returns (bool)',
  'function claimAuditorRewards(uint256[] epochs) external returns (uint256)',
  'function pendingAuditorReward(address auditor,uint256 epoch) external view returns (uint256)',
  'function auditorEpochPower(uint256 epoch,address auditor) external view returns (uint256)',
  'function epochAuditPower(uint256 epoch) external view returns (uint256)',
  'function registry() external view returns (address)',
  'function sellerPools() external view returns (address)',
  'function approvedAuditors(address auditor) external view returns (bool)',
  'event AgentAudited(uint256 indexed agentId,address indexed auditor,bool passed,uint64 verifiedUntil,bytes32 evidenceHash,string evidenceUri)',
  'event ServiceAudited(uint256 indexed agentId,bytes32 indexed serviceHash,bytes32 modelHash,bool passed)',
  'event AuditPowerCredited(uint256 indexed epoch,address indexed auditor,uint256 indexed agentId,uint256 power)',
] as const;

const ANTSEED_REGISTRY_ABI = [
  'function identityRegistry() external view returns (address)',
] as const;

const IDENTITY_REGISTRY_ABI = [
  'function ownerOf(uint256 agentId) external view returns (address)',
] as const;

export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

/** Identifies the model a service was audited as. */
export function modelHash(model: string): string {
  return keccak256(toUtf8Bytes(model.trim().toLowerCase()));
}

/** Orders results the way the contract requires (strictly ascending serviceHash). */
export function sortServiceResults(results: readonly ServiceResultInput[]): ServiceResultInput[] {
  return [...results].sort((a, b) => {
    const left = BigInt(a.serviceHash);
    const right = BigInt(b.serviceHash);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export class VerifierClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;
  private readonly _deploymentBlock: number | undefined;
  private readonly _logQueryChunkBlocks: number | undefined;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._deploymentBlock = config.deploymentBlock;
    this._logQueryChunkBlocks = config.logQueryChunkBlocks;
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFICATION_ABI, this._provider);
    return this._contractInstance;
  }

  async setAuditor(signer: AbstractSigner, auditor: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setAuditor', getAddress(auditor), approved);
  }

  /** Records an audit of one agent. The signer must be an approved auditor. */
  async submitAudit(signer: AbstractSigner, input: SubmitAuditInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitAudit',
      input.agentId,
      sortServiceResults(input.results).map((result) => [result.serviceHash, result.modelHash, result.passed]),
      input.evidenceHash,
      input.evidenceUri,
    );
  }

  async claimAuditorRewards(signer: AbstractSigner, epochs: readonly (number | bigint)[]): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'claimAuditorRewards', epochs.map((epoch) => BigInt(epoch)));
  }

  async pendingAuditorReward(auditor: string, epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('pendingAuditorReward')(getAddress(auditor), BigInt(epoch)));
  }

  /** Pool power the auditor was credited with in `epoch`, and the epoch's total. */
  async auditPower(auditor: string, epoch: number | bigint): Promise<{ auditor: bigint; total: bigint }> {
    const contract = this._contract();
    const [auditorPower, total] = await Promise.all([
      contract.getFunction('auditorEpochPower')(BigInt(epoch), getAddress(auditor)),
      contract.getFunction('epochAuditPower')(BigInt(epoch)),
    ]);
    return { auditor: BigInt(auditorPower), total: BigInt(total) };
  }

  async verifiedUntil(agentId: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('verifiedUntil')(BigInt(agentId)));
  }

  async isVerified(agentId: number | bigint): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isVerified')(BigInt(agentId)));
  }

  async approvedAuditor(auditor: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedAuditors')(getAddress(auditor)));
  }

  async registry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('registry')()));
  }

  async identityRegistry(): Promise<string> {
    const registry = new Contract(await this.registry(), ANTSEED_REGISTRY_ABI, this._provider);
    return getAddress(String(await registry.getFunction('identityRegistry')()));
  }

  async agentOwner(agentId: number | bigint): Promise<string> {
    const identityRegistry = new Contract(await this.identityRegistry(), IDENTITY_REGISTRY_ABI, this._provider);
    return getAddress(String(await identityRegistry.getFunction('ownerOf')(BigInt(agentId))));
  }

  /** Per-service audit results for one agent, optionally narrowed to one service. */
  async queryServiceAudits(
    agentId: number | bigint,
    service: string | null = null,
    fromBlock?: number,
    toBlock: number | 'latest' = 'latest',
  ): Promise<ServiceAuditedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.ServiceAudited;
    if (!filterFactory) throw new Error('ServiceAudited event is missing from verification ABI');
    const logs = await this._queryEvents(
      contract,
      filterFactory(BigInt(agentId), service === null ? null : serviceHash(service)),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        agentId: BigInt(log.args.agentId ?? log.args[0]),
        serviceHash: String(log.args.serviceHash ?? log.args[1]),
        modelHash: String(log.args.modelHash ?? log.args[2]),
        passed: Boolean(log.args.passed ?? log.args[3]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  async queryAudits(
    agentId: number | bigint | null = null,
    fromBlock?: number,
    toBlock: number | 'latest' = 'latest',
  ): Promise<AgentAuditedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.AgentAudited;
    if (!filterFactory) throw new Error('AgentAudited event is missing from verification ABI');
    const logs = await this._queryEvents(
      contract,
      filterFactory(agentId === null ? null : BigInt(agentId), null),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        agentId: BigInt(log.args.agentId ?? log.args[0]),
        auditor: getAddress(String(log.args.auditor ?? log.args[1])),
        passed: Boolean(log.args.passed ?? log.args[2]),
        verifiedUntil: BigInt(log.args.verifiedUntil ?? log.args[3]),
        evidenceHash: String(log.args.evidenceHash ?? log.args[4]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[5]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  /**
   * Query logs from `fromBlock` (default: the deployment block) to `toBlock`
   * in bounded windows so RPC block-range limits are never exceeded.
   */
  private async _queryEvents(
    contract: Contract,
    event: ContractEventName,
    fromBlock: number | undefined,
    toBlock: number | 'latest',
  ): Promise<Awaited<ReturnType<Contract['queryFilter']>>> {
    const from = resolveScanFromBlock(fromBlock, this._deploymentBlock, 'verification contract');
    const openEnded = toBlock === 'latest';
    const to = openEnded ? await this._provider.getBlockNumber() : toBlock;
    return queryInBlockChunks(
      from,
      to,
      (start, end) => contract.queryFilter(event, start, end),
      { chunkBlocks: this._logQueryChunkBlocks, openEnded },
    );
  }
}
