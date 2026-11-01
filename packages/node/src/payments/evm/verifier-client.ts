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

/** Mirrors IAntseedKbfVerification.Verdict. */
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

/** AntseedKbfVerification.MAX_RESULTS_PER_AUDIT. */
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
  /** The service's report round: it moves on whenever the service's verdict moves into or out of DIFF, and only reports of the current round count. */
  round: number;
  /** Distinct auditors reporting `verdict` for this service and model in the epoch and round, this report included. */
  reports: number;
  /** Reports `verdict` needs to be recorded; it is recorded once `reports` reaches it. */
  required: number;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

/** Distinct approved auditors each verdict needs in one epoch before it is recorded. */
export interface RequiredReports {
  SAME: number;
  DIFF: number;
  UNDETERMINED: number;
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

export interface AuditorSetEvent {
  auditor: string;
  approved: boolean;
  blockNumber: number;
  logIndex: number;
  /** Block timestamp in seconds. */
  timestamp: number;
  transactionHash: string;
}

export interface AuditorCredits {
  auditor: bigint;
  total: bigint;
}

export const VERIFICATION_ABI = [
  'function submitModelAudit(uint256 expectedEpoch,bytes32 modelHash,bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict)[] results) external',
  'function serviceStatus(uint256 agentId,bytes32 serviceHash) external view returns ((bytes32 modelHash,uint8 verdict,uint64 updatedAt,uint64 epoch))',
  'function agentStatus(uint256 agentId) external view returns ((uint16 verifiedCount,uint16 diffCount))',
  'function isVerified(uint256 agentId) external view returns (bool)',
  'function claimAuditorRewards(uint256[] epochs) external returns (uint256)',
  'function pendingAuditorReward(address auditor,uint256 epoch) external view returns (uint256)',
  'function epochCredits(uint256 epoch) external view returns (uint256)',
  'function auditorEpochCredits(uint256 epoch,address auditor) external view returns (uint256)',
  'function modelCredits(uint256 epoch,address auditor,bytes32 modelHash) external view returns (uint256)',
  'function maxCreditsPerAuditorPerEpoch() external view returns (uint32)',
  'function maxCreditsPerModelPerEpoch() external view returns (uint32)',
  'function validityEpochs() external view returns (uint8)',
  'function emissionsGate() external view returns (address)',
  'function registry() external view returns (address)',
  'function sellerPools() external view returns (address)',
  'function approvedAuditors(address auditor) external view returns (bool)',
  'function requiredReports(uint8 verdict) external view returns (uint8)',
  'function reportRound(uint256 agentId,bytes32 serviceHash) external view returns (uint256)',
  'event AuditorSet(address indexed auditor,bool approved)',
  'event ModelAudited(bytes32 indexed modelHash,address indexed auditor,uint256 indexed epoch,bytes32 evidenceHash,string evidenceUri,uint256 resultCount)',
  'event ServiceAudited(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed auditor,bytes32 modelHash,uint8 verdict,uint256 round,uint256 reports,uint256 required)',
  'event ServiceStatusChanged(uint256 indexed agentId,bytes32 indexed serviceHash,bytes32 modelHash,uint8 previous,uint8 current)',
  'event AuditCredited(uint256 indexed epoch,address indexed auditor,bytes32 indexed modelHash)',
] as const;

const EMISSIONS_GATE_EPOCH_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function genesis() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
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
  /** Latest result (SAME, DIFF, or UNDETERMINED); only SAME and DIFF count in the agent's status. */
  verdict: VerifierVerdict;
  updatedAt: bigint;
  /** Emissions epoch the verdict was given in; it counts while `currentEpoch < epoch + validityEpochs`. 0 when there is none. */
  epoch: bigint;
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

  /** Block the verification contract was deployed at, when configured. */
  get deploymentBlock(): number | undefined {
    return this._deploymentBlock;
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFICATION_ABI, this._provider);
    return this._contractInstance;
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

  /** The emissions gate pinned by the contract at deployment; `expectedEpoch` is checked against it. */
  async emissionsGate(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('emissionsGate')()));
  }

  async validityEpochs(): Promise<number> {
    return Number(await this._contract().getFunction('validityEpochs')());
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

  /** SAME and DIFF services whose verdicts are still within `validityEpochs`. */
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
      updatedAt: BigInt(status.updatedAt ?? status[2]),
      epoch: BigInt(status.epoch ?? status[3]),
    };
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

  /** Distinct approved auditors each verdict needs in one epoch before it is recorded. */
  async requiredReports(): Promise<RequiredReports> {
    const required = this._contract().getFunction('requiredReports');
    const [same, diff, undetermined] = await Promise.all([
      required(VERIFIER_VERDICT.SAME),
      required(VERIFIER_VERDICT.DIFF),
      required(VERIFIER_VERDICT.UNDETERMINED),
    ]);
    return { SAME: Number(same), DIFF: Number(diff), UNDETERMINED: Number(undetermined) };
  }

  /** Per-service audit results, for one agent (or every agent with `null`), optionally narrowed to one service. */
  async queryServiceAudits(
    agentId: number | bigint | null,
    service: string | null = null,
    fromBlock?: number,
    toBlock: number | 'latest' = 'latest',
  ): Promise<ServiceAuditedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.ServiceAudited;
    if (!filterFactory) throw new Error('ServiceAudited event is missing from verification ABI');
    const logs = await this._queryEvents(
      contract,
      filterFactory(agentId === null ? null : BigInt(agentId), service === null ? null : serviceHash(service)),
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
        round: Number(log.args.round ?? log.args[5]),
        reports: Number(log.args.reports ?? log.args[6]),
        required: Number(log.args.required ?? log.args[7]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    }).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
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
   * Every `AuditorSet` change in block order, with its block timestamp. The contract cannot list
   * its auditors, so replaying these events is how to rebuild the approved set at a point in time.
   */
  async queryAuditorSetEvents(fromBlock?: number, toBlock: number | 'latest' = 'latest'): Promise<AuditorSetEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.AuditorSet;
    if (!filterFactory) throw new Error('AuditorSet event is missing from verification ABI');
    const logs = await this._queryEvents(contract, filterFactory(), fromBlock, toBlock);
    const timestamps = new Map<number, number>();
    const events: AuditorSetEvent[] = [];
    for (const log of logs) {
      if (!(log instanceof EventLog)) continue;
      if (!timestamps.has(log.blockNumber)) {
        const block = await this._provider.getBlock(log.blockNumber);
        if (!block) throw new Error(`block ${log.blockNumber} of an AuditorSet event is unavailable`);
        timestamps.set(log.blockNumber, block.timestamp);
      }
      events.push({
        auditor: getAddress(String(log.args.auditor ?? log.args[0])),
        approved: Boolean(log.args.approved ?? log.args[1]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        timestamp: timestamps.get(log.blockNumber)!,
        transactionHash: log.transactionHash,
      });
    }
    return events.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  }

  /**
   * The first block whose timestamp is at or after `timestamp` (seconds), by binary search; the
   * latest block when none is. Bounds event scans to an epoch.
   */
  async firstBlockAtOrAfter(timestamp: number, floor = 0): Promise<number> {
    let low = floor;
    let high = await this._provider.getBlockNumber();
    const latest = await this._provider.getBlock(high);
    if (!latest || latest.timestamp < timestamp) return high;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const block = await this._provider.getBlock(middle);
      if (!block) throw new Error(`block ${middle} is unavailable`);
      if (block.timestamp < timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** Latest block number, for incremental event scans. */
  async latestBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
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
