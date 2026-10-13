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

/** Mirrors IAntseedVerification.Verdict. */
export const VERIFIER_VERDICT = {
  NONE: 0,
  SAME: 1,
  DIFF: 2,
  UNDETERMINED: 3,
} as const;

export type VerifierVerdictName = Exclude<keyof typeof VERIFIER_VERDICT, 'NONE'>;
export type VerifierVerdict = (typeof VERIFIER_VERDICT)[keyof typeof VERIFIER_VERDICT];

export function verifierVerdict(name: VerifierVerdictName): VerifierVerdict {
  return VERIFIER_VERDICT[name];
}

/** AntseedVerification.MAX_RESULTS_PER_AUDIT. */
export const MAX_RESULTS_PER_MODEL_AUDIT = 256;

export interface ServiceResultInput {
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
}

export interface SubmitModelAuditInput {
  expectedEpoch: bigint;
  modelHash: string;
  evidenceHash: string;
  evidenceUri: string;
  results: ServiceResultInput[];
}

export interface ServiceAuditedEvent {
  agentId: bigint;
  serviceHash: string;
  auditor: string;
  modelHash: string;
  verdict: VerifierVerdict;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface ModelAuditedEvent {
  modelHash: string;
  auditor: string;
  epoch: bigint;
  evidenceHash: string;
  evidenceUri: string;
  resultCount: number;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface ServiceKey {
  agentId: bigint;
  serviceHash: string;
}

/** Max services per `expire` transaction sent by `expireServices`. */
export const MAX_SERVICES_PER_EXPIRE = 100;

export interface AuditorCredits {
  auditor: bigint;
  total: bigint;
}

export const VERIFICATION_ABI = [
  'function setAuditor(address auditor, bool approved) external',
  'function submitModelAudit(uint256 expectedEpoch,bytes32 modelHash,bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict)[] results) external',
  'function serviceStatus(uint256 agentId,bytes32 serviceHash) external view returns ((bytes32 modelHash,uint8 verdict,uint16 diffVotes,uint32 round,uint64 updatedAt,uint8 lastResult,uint16 undeterminedStreak,uint64 lastAuditedAt,uint64 expiresAt))',
  'function agentStatus(uint256 agentId) external view returns ((uint16 verifiedCount,uint16 diffCount))',
  'function isVerified(uint256 agentId) external view returns (bool)',
  'function expire((uint256 agentId,bytes32 serviceHash)[] services) external returns (uint256)',
  'function usedEvidence(bytes32 evidenceHash) external view returns (bool)',
  'function claimAuditorRewards(uint256[] epochs) external returns (uint256)',
  'function pendingAuditorReward(address auditor,uint256 epoch) external view returns (uint256)',
  'function epochCredits(uint256 epoch) external view returns (uint256)',
  'function auditorEpochCredits(uint256 epoch,address auditor) external view returns (uint256)',
  'function modelCredits(uint256 epoch,address auditor,bytes32 modelHash) external view returns (uint256)',
  'function maxCreditsPerAuditorPerEpoch() external view returns (uint32)',
  'function maxCreditsPerModelPerEpoch() external view returns (uint32)',
  'function diffConfirmations() external view returns (uint16)',
  'function validity() external view returns (uint64)',
  'function registry() external view returns (address)',
  'function sellerPools() external view returns (address)',
  'function approvedAuditors(address auditor) external view returns (bool)',
  'event ModelAudited(bytes32 indexed modelHash,address indexed auditor,uint256 indexed epoch,bytes32 evidenceHash,string evidenceUri,uint256 resultCount)',
  'event ServiceAudited(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed auditor,bytes32 modelHash,uint8 verdict)',
  'event ServiceStatusChanged(uint256 indexed agentId,bytes32 indexed serviceHash,bytes32 modelHash,uint8 previous,uint8 current)',
  'event AuditCredited(uint256 indexed epoch,address indexed auditor,bytes32 indexed modelHash)',
] as const;

const EMISSIONS_GATE_EPOCH_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function genesis() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
] as const;

const EMISSIONS_GATE_SOURCE_ABI = [
  'function emissionsGate() external view returns (address)',
] as const;

const ANTSEED_REGISTRY_ABI = [
  'function identityRegistry() external view returns (address)',
  'function emissions() external view returns (address)',
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

/** Orders results the way the contract requires: strictly ascending (agentId, serviceHash). */
export function sortServiceResults(results: readonly ServiceResultInput[]): ServiceResultInput[] {
  return [...results].sort((a, b) => {
    if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
    const left = BigInt(a.serviceHash);
    const right = BigInt(b.serviceHash);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export interface VerifierServiceStatus {
  modelHash: string;
  verdict: VerifierVerdict;
  diffVotes: number;
  lastResult: VerifierVerdict;
  undeterminedStreak: number;
  updatedAt: bigint;
  lastAuditedAt: bigint;
  /** When the SAME/DIFF verdict stops applying; 0 when there is none. */
  expiresAt: bigint;
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

  /** Records one auditor's results for every seller audited as one model. */
  async submitModelAudit(signer: AbstractSigner, input: SubmitModelAuditInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitModelAudit',
      input.expectedEpoch,
      input.modelHash,
      input.evidenceHash,
      input.evidenceUri,
      sortServiceResults(input.results).map((result) => [result.agentId, result.serviceHash, result.verdict]),
    );
  }

  async claimAuditorRewards(signer: AbstractSigner, epochs: readonly (number | bigint)[]): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'claimAuditorRewards', epochs.map((epoch) => BigInt(epoch)));
  }

  async pendingAuditorReward(auditor: string, epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('pendingAuditorReward')(getAddress(auditor), BigInt(epoch)));
  }

  /** Credits the auditor earned in `epoch`, and the epoch's total. */
  async auditCredits(auditor: string, epoch: number | bigint): Promise<AuditorCredits> {
    const contract = this._contract();
    const [auditorCredits, total] = await Promise.all([
      contract.getFunction('auditorEpochCredits')(BigInt(epoch), getAddress(auditor)),
      contract.getFunction('epochCredits')(BigInt(epoch)),
    ]);
    return { auditor: BigInt(auditorCredits), total: BigInt(total) };
  }

  async modelCredits(epoch: number | bigint, auditor: string, model: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('modelCredits')(BigInt(epoch), getAddress(auditor), model));
  }

  async creditLimits(): Promise<{ perAuditor: bigint; perModel: bigint }> {
    const contract = this._contract();
    const [perAuditor, perModel] = await Promise.all([
      contract.getFunction('maxCreditsPerAuditorPerEpoch')(),
      contract.getFunction('maxCreditsPerModelPerEpoch')(),
    ]);
    return { perAuditor: BigInt(perAuditor), perModel: BigInt(perModel) };
  }

  async evidenceUsed(evidenceHash: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('usedEvidence')(evidenceHash));
  }

  /**
   * The emissions gate the contract checks `expectedEpoch` against: the gate behind
   * `registry.emissions()` (usage accounting's `emissionsGate()` after M001), else that entry itself.
   */
  async emissionsGate(): Promise<string> {
    const registry = new Contract(await this.registry(), ANTSEED_REGISTRY_ABI, this._provider);
    const emissions = getAddress(String(await registry.getFunction('emissions')()));
    try {
      const source = new Contract(emissions, EMISSIONS_GATE_SOURCE_ABI, this._provider);
      const gate = getAddress(String(await source.getFunction('emissionsGate')()));
      if ((await this._provider.getCode(gate)) !== '0x') return gate;
    } catch {
      // `emissions` is the gate itself.
    }
    return emissions;
  }

  /** The current epoch exactly as `submitModelAudit` checks it. */
  async currentEpochWindow(): Promise<{ epoch: bigint; startedAt: number; endsAt: number }> {
    const gate = new Contract(await this.emissionsGate(), EMISSIONS_GATE_EPOCH_ABI, this._provider);
    const [epoch, genesis, duration] = await Promise.all([
      gate.getFunction('currentEpoch')(),
      gate.getFunction('genesis')(),
      gate.getFunction('epochDuration')(),
    ]);
    const startedAt = Number(BigInt(genesis) + BigInt(epoch) * BigInt(duration));
    return { epoch: BigInt(epoch), startedAt, endsAt: startedAt + Number(duration) };
  }

  async isVerified(agentId: number | bigint): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isVerified')(BigInt(agentId)));
  }

  /** Counted SAME and DIFF services; expired ones stay counted until `expire` is called. */
  async agentStatus(agentId: number | bigint): Promise<{ verifiedCount: number; diffCount: number }> {
    const status = await this._contract().getFunction('agentStatus')(BigInt(agentId));
    return {
      verifiedCount: Number(status.verifiedCount ?? status[0]),
      diffCount: Number(status.diffCount ?? status[1]),
    };
  }

  async serviceStatus(agentId: number | bigint, service: string): Promise<VerifierServiceStatus> {
    return this.serviceStatusByHash(agentId, serviceHash(service));
  }

  async serviceStatusByHash(agentId: number | bigint, hash: string): Promise<VerifierServiceStatus> {
    const status = await this._contract().getFunction('serviceStatus')(BigInt(agentId), hash);
    return {
      modelHash: String(status.modelHash ?? status[0]),
      verdict: Number(status.verdict ?? status[1]) as VerifierVerdict,
      diffVotes: Number(status.diffVotes ?? status[2]),
      updatedAt: BigInt(status.updatedAt ?? status[4]),
      lastResult: Number(status.lastResult ?? status[5]) as VerifierVerdict,
      undeterminedStreak: Number(status.undeterminedStreak ?? status[6]),
      lastAuditedAt: BigInt(status.lastAuditedAt ?? status[7]),
      expiresAt: BigInt(status.expiresAt ?? status[8]),
    };
  }

  /**
   * Services whose SAME or DIFF verdict has expired but is still counted, found from
   * `ServiceStatusChanged` events and checked against the latest block's timestamp.
   */
  async findExpiredServices(fromBlock?: number, toBlock: number | 'latest' = 'latest'): Promise<ServiceKey[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.ServiceStatusChanged;
    if (!filterFactory) throw new Error('ServiceStatusChanged event is missing from verification ABI');
    const logs = await this._queryEvents(contract, filterFactory(), fromBlock, toBlock);
    const candidates = new Map<string, ServiceKey>();
    for (const log of logs) {
      if (!(log instanceof EventLog)) continue;
      const current = Number(log.args.current ?? log.args[4]);
      if (current !== VERIFIER_VERDICT.SAME && current !== VERIFIER_VERDICT.DIFF) continue;
      const key = { agentId: BigInt(log.args.agentId ?? log.args[0]), serviceHash: String(log.args.serviceHash ?? log.args[1]) };
      candidates.set(`${key.agentId}:${key.serviceHash.toLowerCase()}`, key);
    }
    const block = await this._provider.getBlock('latest');
    if (!block) throw new Error('latest block is unavailable');
    const now = BigInt(block.timestamp);
    const expired: ServiceKey[] = [];
    for (const key of candidates.values()) {
      const status = await this.serviceStatusByHash(key.agentId, key.serviceHash);
      const counted = status.verdict === VERIFIER_VERDICT.SAME || status.verdict === VERIFIER_VERDICT.DIFF;
      if (counted && status.expiresAt <= now) expired.push(key);
    }
    return expired.sort((a, b) => (a.agentId === b.agentId
      ? (BigInt(a.serviceHash) < BigInt(b.serviceHash) ? -1 : 1)
      : (a.agentId < b.agentId ? -1 : 1)));
  }

  /** Drops expired verdicts from their agents' counts, in batches; returns the transaction hashes. */
  async expireServices(signer: AbstractSigner, services: readonly ServiceKey[]): Promise<string[]> {
    const hashes: string[] = [];
    for (let start = 0; start < services.length; start += MAX_SERVICES_PER_EXPIRE) {
      const batch = services.slice(start, start + MAX_SERVICES_PER_EXPIRE);
      hashes.push(await this._execWrite(
        signer,
        VERIFICATION_ABI,
        'expire',
        batch.map((service) => [service.agentId, service.serviceHash]),
      ));
    }
    return hashes;
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
        auditor: getAddress(String(log.args.auditor ?? log.args[2])),
        modelHash: String(log.args.modelHash ?? log.args[3]),
        verdict: Number(log.args.verdict ?? log.args[4]) as VerifierVerdict,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  /** Model audits, optionally narrowed to one model and auditor. */
  async queryModelAudits(
    filter: { model?: string | null; auditor?: string | null } = {},
    fromBlock?: number,
    toBlock: number | 'latest' = 'latest',
  ): Promise<ModelAuditedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.ModelAudited;
    if (!filterFactory) throw new Error('ModelAudited event is missing from verification ABI');
    const logs = await this._queryEvents(
      contract,
      filterFactory(filter.model ?? null, filter.auditor ? getAddress(filter.auditor) : null),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        modelHash: String(log.args.modelHash ?? log.args[0]),
        auditor: getAddress(String(log.args.auditor ?? log.args[1])),
        epoch: BigInt(log.args.epoch ?? log.args[2]),
        evidenceHash: String(log.args.evidenceHash ?? log.args[3]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[4]),
        resultCount: Number(log.args.resultCount ?? log.args[5]),
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
