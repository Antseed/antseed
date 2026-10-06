import {
  AbiCoder,
  Contract,
  EventLog,
  TypedDataEncoder,
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  type AbstractSigner,
  type ContractEventName,
  type TypedDataDomain,
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

/** Service flags, matching AntseedVerification.SERVICE_* constants. */
export const SERVICE_MODEL_MATCH = 1;
export const SERVICE_PRICE_MATCH = 2;
export const SERVICE_UNDETERMINED = 4;

export interface ServiceResultInput {
  serviceHash: string;
  referenceId: string;
  flags: number;
}

export interface AuditReportInput {
  agentId: bigint;
  metadataHash: string;
  evidenceHash: string;
  resultsHash: string;
  auditedAt: bigint;
}

export interface SubmitReportInput {
  report: AuditReportInput;
  results: ServiceResultInput[];
  evidenceUri: string;
  auditorSignature: string;
}

export interface AgentScore {
  scoreBps: number;
  validUntil: bigint;
  finalizedAt: bigint;
}

export interface ServiceAuditedEvent {
  agentId: bigint;
  serviceHash: string;
  auditor: string;
  referenceId: string;
  flags: number;
  evidenceHash: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface ReportSubmittedEvent {
  agentId: bigint;
  auditor: string;
  verifier: string;
  metadataHash: string;
  evidenceHash: string;
  resultsHash: string;
  evidenceUri: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFICATION_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function submitReport((uint256 agentId,bytes32 metadataHash,bytes32 evidenceHash,bytes32 resultsHash,uint64 auditedAt) report,(bytes32 serviceHash,bytes32 referenceId,uint16 flags)[] results,string evidenceUri,bytes auditorSignature) external',
  'function hashAuditReport((uint256 agentId,bytes32 metadataHash,bytes32 evidenceHash,bytes32 resultsHash,uint64 auditedAt) report) external view returns (bytes32)',
  'function agentScore(uint256 agentId) external view returns ((uint16 scoreBps,uint64 validUntil,uint64 finalizedAt))',
  'function activeScoreBps(uint256 agentId) external view returns (uint256)',
  'function computeScoreBps((bytes32 serviceHash,bytes32 referenceId,uint16 flags)[] results) external view returns (uint256)',
  'function reportUsed(bytes32 digest) external view returns (bool)',
  'function claimAuditorRewards(uint256[] epochs) external returns (uint256)',
  'function pendingAuditorReward(address auditor,uint256 epoch) external view returns (uint256)',
  'function registry() external view returns (address)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'event ReportSubmitted(uint256 indexed agentId,address indexed auditor,address indexed verifier,bytes32 metadataHash,bytes32 evidenceHash,bytes32 resultsHash,string evidenceUri)',
  'event ServiceAudited(uint256 indexed agentId,bytes32 indexed serviceHash,address indexed auditor,bytes32 referenceId,uint16 flags,bytes32 evidenceHash)',
  'event AgentScoreFinalized(uint256 indexed agentId,uint16 scoreBps,uint64 validUntil,bytes32 resultsHash,address[] auditors)',
] as const;

export const AUDIT_REPORT_TYPES = {
  AuditReport: [
    { name: 'agentId', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'resultsHash', type: 'bytes32' },
    { name: 'auditedAt', type: 'uint64' },
  ],
};

const SERVICE_RESULTS_TYPE = ['tuple(bytes32 serviceHash,bytes32 referenceId,uint16 flags)[]'];

const ANTSEED_REGISTRY_ABI = [
  'function identityRegistry() external view returns (address)',
] as const;

const IDENTITY_REGISTRY_ABI = [
  'function ownerOf(uint256 agentId) external view returns (address)',
] as const;

export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

/** Orders results the way the contract requires (strictly ascending serviceHash). */
export function sortServiceResults(results: readonly ServiceResultInput[]): ServiceResultInput[] {
  return [...results].sort((a, b) => {
    const left = BigInt(a.serviceHash);
    const right = BigInt(b.serviceHash);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** keccak256(abi.encode(results)), the report's `resultsHash`. */
export function hashServiceResults(results: readonly ServiceResultInput[]): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(SERVICE_RESULTS_TYPE, [
    results.map((result) => [result.serviceHash, result.referenceId, result.flags]),
  ]));
}

export function auditReportDomain(chainId: bigint | number, verifyingContract: string): TypedDataDomain {
  return { name: 'AntseedVerification', version: '1', chainId, verifyingContract: getAddress(verifyingContract) };
}

export function hashAuditReport(domain: TypedDataDomain, report: AuditReportInput): string {
  return TypedDataEncoder.hash(domain, AUDIT_REPORT_TYPES, report);
}

/** Signs a report as its auditor; the signer is who earns the audit units. */
export async function signAuditReport(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  report: AuditReportInput,
): Promise<string> {
  return signer.signTypedData(domain, AUDIT_REPORT_TYPES, report);
}

export function recoverAuditReportSigner(domain: TypedDataDomain, report: AuditReportInput, signature: string): string {
  return getAddress(verifyTypedData(domain, AUDIT_REPORT_TYPES, report, signature));
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

  async reportDomain(): Promise<TypedDataDomain> {
    const network = await this._provider.getNetwork();
    return auditReportDomain(network.chainId, this._contractAddress);
  }

  async setVerifier(signer: AbstractSigner, verifier: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setVerifier', getAddress(verifier), approved);
  }

  /** Submits an auditor-signed report. The signer must be an approved verifier. */
  async submitReport(signer: AbstractSigner, input: SubmitReportInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitReport',
      input.report,
      input.results.map((result) => [result.serviceHash, result.referenceId, result.flags]),
      input.evidenceUri,
      input.auditorSignature,
    );
  }

  async claimAuditorRewards(signer: AbstractSigner, epochs: readonly (number | bigint)[]): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'claimAuditorRewards', epochs.map((epoch) => BigInt(epoch)));
  }

  async pendingAuditorReward(auditor: string, epoch: number | bigint): Promise<bigint> {
    return BigInt(await this._contract().getFunction('pendingAuditorReward')(getAddress(auditor), BigInt(epoch)));
  }

  async reportUsed(digest: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('reportUsed')(digest));
  }

  async agentScore(agentId: number | bigint): Promise<AgentScore> {
    const score = await this._contract().getFunction('agentScore')(BigInt(agentId));
    return {
      scoreBps: Number(score.scoreBps ?? score[0]),
      validUntil: BigInt(score.validUntil ?? score[1]),
      finalizedAt: BigInt(score.finalizedAt ?? score[2]),
    };
  }

  async activeScoreBps(agentId: number | bigint): Promise<number> {
    return Number(await this._contract().getFunction('activeScoreBps')(BigInt(agentId)));
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

  async approvedVerifier(verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('approvedVerifiers')(getAddress(verifier)));
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
      filterFactory(BigInt(agentId), service === null ? null : serviceHash(service), null),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        agentId: BigInt(log.args.agentId ?? log.args[0]),
        serviceHash: String(log.args.serviceHash ?? log.args[1]),
        auditor: getAddress(String(log.args.auditor ?? log.args[2])),
        referenceId: String(log.args.referenceId ?? log.args[3]),
        flags: Number(log.args.flags ?? log.args[4]),
        evidenceHash: String(log.args.evidenceHash ?? log.args[5]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  async queryReports(
    agentId: number | bigint | null = null,
    fromBlock?: number,
    toBlock: number | 'latest' = 'latest',
  ): Promise<ReportSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.ReportSubmitted;
    if (!filterFactory) throw new Error('ReportSubmitted event is missing from verification ABI');
    const logs = await this._queryEvents(
      contract,
      filterFactory(agentId === null ? null : BigInt(agentId), null, null),
      fromBlock,
      toBlock,
    );
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        agentId: BigInt(log.args.agentId ?? log.args[0]),
        auditor: getAddress(String(log.args.auditor ?? log.args[1])),
        verifier: getAddress(String(log.args.verifier ?? log.args[2])),
        metadataHash: String(log.args.metadataHash ?? log.args[3]),
        evidenceHash: String(log.args.evidenceHash ?? log.args[4]),
        resultsHash: String(log.args.resultsHash ?? log.args[5]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[6]),
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
