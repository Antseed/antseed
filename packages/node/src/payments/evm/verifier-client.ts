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
  /**
   * The `AntseedKbfAudits` contract: the KBF audit auditors submit audits to, which also holds the
   * approved auditors. The results layer is discovered from it (`results()`) unless given below.
   */
  contractAddress: string;
  evmChainId?: number;
  /**
   * Block the KBF audits contract was deployed at. Default lower bound for
   * event queries; without it, queries require an explicit `fromBlock`.
   */
  deploymentBlock?: number;
  /** `AntseedVerificationResults` address; read from `kbf.results()` when absent. */
  resultsAddress?: string;
  /** Max blocks per `eth_getLogs` window (defaults to 10k). */
  logQueryChunkBlocks?: number;
}

/** Mirrors IAntseedVerificationResults.Verdict. */
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

/** AntseedKbfAudits.MAX_RESULTS_PER_AUDIT. */
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
  /** The service's report round: it moves on whenever any audit moves the service's verdict into or out of DIFF, an auditor is revoked, or the results owner clears the service; only reports of the current round count. */
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

/** How an auditor shows itself in UIs (`AntseedKbfAudits.auditorProfile`). Empty strings when unset. */
export interface AuditorProfile {
  name: string;
  /** `https://` or `ipfs://` link to a square image. */
  iconUri: string;
  /** `https://` or `ipfs://` website or profile link. */
  url: string;
}

/** AntseedKbfAudits profile limits. */
export const MAX_AUDITOR_PROFILE_NAME_BYTES = 64;
export const MAX_AUDITOR_PROFILE_URI_BYTES = 256;

/** `AntseedVerificationResults.REWARDS_OFF`: an audit's rewards start epoch while its rewards are off. */
export const VERIFICATION_REWARDS_OFF = 2n ** 64n - 1n;

/** Throws when `profile` would be rejected by `setAuditorProfile`, with the reason. */
export function validateAuditorProfile(profile: AuditorProfile): void {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (bytes(profile.name) > MAX_AUDITOR_PROFILE_NAME_BYTES) {
    throw new Error(`profile name is longer than ${MAX_AUDITOR_PROFILE_NAME_BYTES} bytes`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(profile.name)) throw new Error('profile name contains control characters');
  for (const [field, value] of [['icon', profile.iconUri], ['url', profile.url]] as const) {
    if (value === '') continue;
    if (bytes(value) > MAX_AUDITOR_PROFILE_URI_BYTES) {
      throw new Error(`profile ${field} is longer than ${MAX_AUDITOR_PROFILE_URI_BYTES} bytes`);
    }
    if (!/^(https:\/\/|ipfs:\/\/)./.test(value)) throw new Error(`profile ${field} must start with https:// or ipfs://`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x20\x7f"'<>\\`]/.test(value)) {
      throw new Error(`profile ${field} contains a space, control character, quote, angle bracket, backslash or backtick`);
    }
  }
}

/** `AntseedKbfAudits`: the KBF audit auditors submit to. */
export const KBF_AUDITS_ABI = [
  'function submitModelAudit(uint256 expectedEpoch,bytes32 modelHash,bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict)[] results) external',
  'function requiredReports(uint8 verdict) external view returns (uint8)',
  'function reportRound(uint256 agentId,bytes32 serviceHash) external view returns (uint256)',
  'function reportKey(uint256 epoch,uint256 agentId,bytes32 serviceHash,bytes32 modelHash,uint256 round) external pure returns (bytes32)',
  'function reportOf(bytes32 key,address auditor) external view returns (uint8)',
  'function reportCount(bytes32 key,uint8 verdict) external view returns (uint256)',
  'function creditedAudits(uint256 epoch,address auditor,bytes32 modelHash) external view returns (uint256)',
  'function maxCreditsPerModelPerEpoch() external view returns (uint32)',
  'function creditsPerAudit() external view returns (uint32)',
  'function modelCreditsPerAudit(bytes32 modelHash) external view returns (uint32)',
  'function creditsFor(bytes32 modelHash) external view returns (uint256)',
  'function validityEpochs() external view returns (uint8)',
  'function diffReplacementReports() external view returns (uint8)',
  'function results() external view returns (address)',
  'function sellerPools() external view returns (address)',
  'function identityRegistry() external view returns (address)',
  'function approvedAuditors(address auditor) external view returns (bool)',
  'function auditorRevocations() external view returns (uint256)',
  'function agentOwner(uint256 agentId) external view returns (bool known,address owner)',
  'function auditorProfile(address auditor) external view returns ((string name,string iconUri,string url))',
  'function setAuditorProfile(string name,string iconUri,string url) external',
  'event AuditorSet(address indexed auditor,bool approved,uint256 revocations)',
  'event AuditorProfileSet(address indexed auditor,string name,string iconUri,string url)',
  'event ModelAudited(bytes32 indexed modelHash,address indexed auditor,uint256 indexed epoch,bytes32 evidenceHash,string evidenceUri,uint256 resultCount)',
  'event ServiceAudited(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed auditor,bytes32 modelHash,uint8 verdict,uint256 round,uint256 reports,uint256 required)',
  'event AuditCredited(uint256 indexed epoch,address indexed auditor,bytes32 indexed modelHash,uint256 credits)',
  'event UnknownAgentSkipped(uint256 indexed agentId,bytes32 indexed modelHash)',
  'event ValidityEpochsSet(uint8 validityEpochs)',
  'event CreditsPerAuditSet(uint32 credits)',
  'event ModelCreditsPerAuditSet(bytes32 indexed modelHash,uint32 credits)',
] as const;

/** `AntseedVerificationResults`: verdicts and verification rewards, for every audit. */
export const VERIFICATION_RESULTS_ABI = [
  'function serviceStatus(uint256 agentId,bytes32 serviceHash) external view returns ((bytes32 modelHash,uint8 verdict,uint64 updatedAt,uint64 epoch,address audit,uint64 validUntilEpoch))',
  'function agentStatus(uint256 agentId) external view returns ((uint16 verifiedCount,uint16 diffCount))',
  'function isVerified(uint256 agentId) external view returns (bool)',
  'function liveVerdict(uint256 agentId,bytes32 serviceHash) external view returns (uint8)',
  'function serviceClears(uint256 agentId,bytes32 serviceHash) external view returns (uint256)',
  'function diffChanges(uint256 agentId,bytes32 serviceHash) external view returns (uint256)',
  'function emissionsGate() external view returns (address)',
  'function currentEpoch() external view returns (uint256)',
  'function isAudit(address audit) external view returns (bool)',
  'function auditShareBps(address audit) external view returns (uint16)',
  'function auditShareBpsAt(address audit,uint256 epoch) external view returns (uint16)',
  'function auditBudget(address audit,uint256 epoch) external view returns (uint256)',
  'function rewardsStartEpoch(address audit) external view returns (uint64)',
  'function maxCreditsPerAuditorPerEpoch(address audit) external view returns (uint32)',
  'function maxAuditorShareBps(address audit) external view returns (uint16)',
  'function epochCredits(address audit,uint256 epoch) external view returns (uint256)',
  'function auditorEpochCredits(address audit,uint256 epoch,address auditor) external view returns (uint256)',
  'function auditorEpochClaimed(address audit,uint256 epoch,address auditor) external view returns (bool)',
  'function claimAuditorReward(address audit,uint256 epoch) external',
  'function pendingAuditorReward(address audit,address auditor,uint256 epoch) external view returns (uint256)',
  'function paused() external view returns (bool)',
  'event ServiceStatusChanged(uint256 indexed agentId,bytes32 indexed serviceHash,bytes32 modelHash,uint8 previous,uint8 current,address audit,uint256 epoch,uint256 validUntilEpoch)',
  'event ServiceCleared(uint256 indexed agentId,bytes32 indexed serviceHash,uint256 epoch,uint256 clears)',
  'event AgentStatusChanged(uint256 indexed agentId,uint16 verifiedCount,uint16 diffCount)',
  'event Credited(address indexed audit,uint256 indexed epoch,address indexed auditor,uint256 credits)',
  'event AuditorRewardClaimed(address indexed audit,uint256 indexed epoch,address indexed auditor,uint256 credits,uint256 totalCredits,uint256 grossAmount,uint256 claimableAmount,uint256 reserveAmount)',
] as const;


const EMISSIONS_GATE_EPOCH_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function genesis() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
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
  /** Emissions epoch the verdict was given in; 0 when there is none. */
  epoch: bigint;
  /** First epoch the verdict no longer counts in, chosen by the audit that recorded it; 0 when there is none. */
  validUntilEpoch: bigint;
  /** Audit contract that recorded the verdict (e.g. the KBF audits contract); the zero address when there is none. */
  audit: string;
}

/**
 * Reads and writes the split verification contracts on behalf of a KBF verifier:
 *
 * - `AntseedKbfAudits` (`contractAddress`): approved auditors (`AuditorSet` events), audits, report
 *   tallies, per-model credits;
 * - `AntseedVerificationResults` (`kbf.results()`): verdicts, epochs, credits and reward claims,
 *   keyed by the KBF contract as the audit.
 *
 * The results address is discovered from the KBF contract on first use and cached.
 */
export class VerifierClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;
  private _resultsInstance: Promise<Contract> | null = null;
  private readonly _config: VerifierClientConfig;
  private readonly _deploymentBlock: number | undefined;
  private readonly _logQueryChunkBlocks: number | undefined;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._config = config;
    this._deploymentBlock = config.deploymentBlock;
    this._logQueryChunkBlocks = config.logQueryChunkBlocks;
  }

  /** Block the KBF audits contract was deployed at, when configured. */
  get deploymentBlock(): number | undefined {
    return this._deploymentBlock;
  }

  /** The `AntseedKbfAudits` contract. */
  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, KBF_AUDITS_ABI, this._provider);
    return this._contractInstance;
  }

  /** The `AntseedVerificationResults` contract the KBF contract records into. */
  private _results(): Promise<Contract> {
    this._resultsInstance ??= (async () => {
      const address = this._config.resultsAddress
        ?? String(await this._contract().getFunction('results')());
      return new Contract(getAddress(address), VERIFICATION_RESULTS_ABI, this._provider);
    })();
    this._resultsInstance.catch(() => { this._resultsInstance = null; });
    return this._resultsInstance;
  }

  /** `AntseedVerificationResults` address (configured, or read from the KBF contract). */
  async resultsAddress(): Promise<string> {
    return getAddress(String((await this._results()).target));
  }

  /** Records one auditor's results for every seller audited as one model, on the KBF contract. */
  async submitModelAudit(signer: AbstractSigner, input: SubmitModelAuditInput): Promise<string> {
    return this._execWrite(
      signer,
      KBF_AUDITS_ABI,
      'submitModelAudit',
      input.expectedEpoch,
      input.modelHash,
      input.evidenceHash,
      input.evidenceUri,
      sortServiceResults(input.results).map((result) => [result.agentId, result.serviceHash, result.verdict]),
    );
  }

  /**
   * Claims KBF rewards on the results contract, one transaction per epoch as the contract takes
   * them: `results.claimAuditorReward(kbf, epoch)`. Returns the transaction hashes in order.
   */
  async claimAuditorRewards(signer: AbstractSigner, epochs: readonly (number | bigint)[]): Promise<string[]> {
    const writer = new ResultsWriter(this._config, await this.resultsAddress()).withProvider(this._provider);
    const audit = getAddress(this._contractAddress);
    const hashes: string[] = [];
    for (const epoch of epochs) hashes.push(await writer.claimAuditorReward(signer, audit, BigInt(epoch)));
    return hashes;
  }

  /** Claimable KBF reward of a finalized epoch: `results.pendingAuditorReward(kbf, auditor, epoch)`. */
  async pendingAuditorReward(auditor: string, epoch: number | bigint): Promise<bigint> {
    const results = await this._results();
    return BigInt(await results.getFunction('pendingAuditorReward')(this._contractAddress, getAddress(auditor), BigInt(epoch)));
  }

  /** KBF credits the auditor earned in `epoch`, and the epoch's KBF total, from the results contract. */
  async auditCredits(auditor: string, epoch: number | bigint): Promise<AuditorCredits> {
    const results = await this._results();
    const [auditorCredits, total] = await Promise.all([
      results.getFunction('auditorEpochCredits')(this._contractAddress, BigInt(epoch), getAddress(auditor)),
      results.getFunction('epochCredits')(this._contractAddress, BigInt(epoch)),
    ]);
    return { auditor: BigInt(auditorCredits), total: BigInt(total) };
  }

  /** Audits of `model` (a model hash) by `auditor` in `epoch` that earned credits; at most `perModel` of `creditLimits`. */
  async creditedAudits(epoch: number | bigint, auditor: string, model: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('creditedAudits')(BigInt(epoch), getAddress(auditor), model));
  }

  /** Credits one audit of `model` (a model hash) earns now: its own amount on the KBF contract, else the default. */
  async creditsFor(model: string): Promise<bigint> {
    return BigInt(await this._contract().getFunction('creditsFor')(model));
  }

  /** Per-auditor credit cap (results layer, for the KBF audit, per epoch) and per-model cap on credited audits (KBF contract). */
  async creditLimits(): Promise<{ perAuditor: bigint; perModel: bigint }> {
    const results = await this._results();
    const [perAuditor, perModel] = await Promise.all([
      results.getFunction('maxCreditsPerAuditorPerEpoch')(this._contractAddress),
      this._contract().getFunction('maxCreditsPerModelPerEpoch')(),
    ]);
    return { perAuditor: BigInt(perAuditor), perModel: BigInt(perModel) };
  }

  /**
   * KBF reward settings on the results contract: the first epoch whose audits earn credits
   * (`VERIFICATION_REWARDS_OFF` while rewards are off), KBF's share of the bucket for `epoch`
   * (default: the latest setting) and the most of that share one auditor can receive, both in bps.
   */
  async rewardSettings(epoch?: number | bigint): Promise<{ rewardsStartEpoch: bigint; shareBps: number; maxAuditorShareBps: number }> {
    const results = await this._results();
    const audit = this._contractAddress;
    const [start, share, cap] = await Promise.all([
      results.getFunction('rewardsStartEpoch')(audit),
      epoch === undefined
        ? results.getFunction('auditShareBps')(audit)
        : results.getFunction('auditShareBpsAt')(audit, BigInt(epoch)),
      results.getFunction('maxAuditorShareBps')(audit),
    ]);
    return { rewardsStartEpoch: BigInt(start), shareBps: Number(share), maxAuditorShareBps: Number(cap) };
  }

  /** The auditor's display profile on the KBF contract; empty strings when never set. */
  async auditorProfile(auditor: string): Promise<AuditorProfile> {
    const profile = await this._contract().getFunction('auditorProfile')(getAddress(auditor));
    return {
      name: String(profile.name ?? profile[0]),
      iconUri: String(profile.iconUri ?? profile[1]),
      url: String(profile.url ?? profile[2]),
    };
  }

  /** Sets the signer's display profile on the KBF contract (approved auditors only). */
  async setAuditorProfile(signer: AbstractSigner, profile: AuditorProfile): Promise<string> {
    validateAuditorProfile(profile);
    return this._execWrite(signer, KBF_AUDITS_ABI, 'setAuditorProfile', profile.name, profile.iconUri, profile.url);
  }

  /** The emissions gate the results contract pinned at deployment; `expectedEpoch` is checked against it. */
  async emissionsGate(): Promise<string> {
    return getAddress(String(await (await this._results()).getFunction('emissionsGate')()));
  }

  /** Epochs a KBF verdict counts for (KBF contract), including the one it was given in. */
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
    return Boolean(await (await this._results()).getFunction('isVerified')(BigInt(agentId)));
  }

  /** SAME and DIFF services whose verdicts still count (`currentEpoch < validUntilEpoch`). */
  async agentStatus(agentId: number | bigint): Promise<{ verifiedCount: number; diffCount: number }> {
    const status = await (await this._results()).getFunction('agentStatus')(BigInt(agentId));
    return {
      verifiedCount: Number(status.verifiedCount ?? status[0]),
      diffCount: Number(status.diffCount ?? status[1]),
    };
  }

  async serviceStatus(agentId: number | bigint, service: string): Promise<VerifierServiceStatus> {
    return this.serviceStatusByHash(agentId, serviceHash(service));
  }

  async serviceStatusByHash(agentId: number | bigint, hash: string): Promise<VerifierServiceStatus> {
    const status = await (await this._results()).getFunction('serviceStatus')(BigInt(agentId), hash);
    return {
      modelHash: String(status.modelHash ?? status[0]),
      verdict: Number(status.verdict ?? status[1]) as VerifierVerdict,
      updatedAt: BigInt(status.updatedAt ?? status[2]),
      epoch: BigInt(status.epoch ?? status[3]),
      audit: getAddress(String(status.audit ?? status[4])),
      validUntilEpoch: BigInt(status.validUntilEpoch ?? status[5]),
    };
  }

  /** Whether `auditor` is approved on the KBF contract. */
  async approvedAuditor(auditor: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedAuditors')(getAddress(auditor)));
  }

  /** The identity registry the KBF contract resolves agent owners with. */
  async identityRegistry(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('identityRegistry')()));
  }

  async agentOwner(agentId: number | bigint): Promise<string> {
    const identityRegistry = new Contract(await this.identityRegistry(), IDENTITY_REGISTRY_ABI, this._provider);
    return getAddress(String(await identityRegistry.getFunction('ownerOf')(BigInt(agentId))));
  }

  /**
   * The service's current report round: only reports made in it count. It moves on whenever any
   * source moves the service's verdict into or out of DIFF, an auditor is revoked, or the results
   * owner clears the service.
   */
  async reportRound(agentId: number | bigint, serviceHashValue: string): Promise<number> {
    return Number(await this._contract().getFunction('reportRound')(BigInt(agentId), serviceHashValue));
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
    if (!filterFactory) throw new Error('ServiceAudited event is missing from the KBF audits ABI');
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
    if (!filterFactory) throw new Error('ModelAudited event is missing from the KBF audits ABI');
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
   * Every `AuditorSet` change of the KBF contract in block order, with its block timestamp. The
   * contract cannot list its auditors, so replaying these events is how to rebuild the approved set
   * at a point in time.
   */
  async queryAuditorSetEvents(fromBlock?: number, toBlock: number | 'latest' = 'latest'): Promise<AuditorSetEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.AuditorSet;
    if (!filterFactory) throw new Error('AuditorSet event is missing from the KBF audits ABI');
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

/** Sends writes to the results contract on the same provider and nonce scope as the client. */
class ResultsWriter extends BaseEvmClient {
  constructor(config: VerifierClientConfig, resultsAddress: string) {
    super(config.rpcUrl, resultsAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  claimAuditorReward(signer: AbstractSigner, audit: string, epoch: bigint): Promise<string> {
    return this._execWrite(signer, VERIFICATION_RESULTS_ABI, 'claimAuditorReward', audit, epoch);
  }
}
