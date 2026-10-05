import {
  Contract,
  EventLog,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type AbstractSigner,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface VerifierClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

export type VerifierVerdict =
  | typeof VERIFIER_VERDICT_UNKNOWN
  | typeof VERIFIER_VERDICT_SAME
  | typeof VERIFIER_VERDICT_DIFF
  | typeof VERIFIER_VERDICT_UNDETERMINED;

export interface VerificationResultInput {
  agentId: number | bigint;
  serviceHash: string;
  verdict: Exclude<VerifierVerdict, typeof VERIFIER_VERDICT_UNKNOWN>;
}

export interface SubmitVerificationBundleInput {
  evidenceHash: string;
  evidenceUri: string;
  results: VerificationResultInput[];
}

export interface VerificationBundleSubmittedEvent {
  evidenceHash: string;
  verifier: string;
  resultCount: number;
  evidenceUri: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export interface AttestationSubmittedEvent {
  auditId: string;
  verifier: string;
  agentId: bigint;
  serviceHash: string;
  verdict: VerifierVerdict;
  evidenceHash: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
}

export const VERIFICATION_ABI = [
  'function setVerifier(address verifier, bool approved) external',
  'function submitVerificationBundle(bytes32 evidenceHash,string evidenceUri,(uint256 agentId,bytes32 serviceHash,uint8 verdict)[] results) external',
  'function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool)',
  'function verificationBundle(bytes32 evidenceHash) external view returns ((address verifier,uint64 submittedAt,uint32 resultCount,string evidenceUri))',
  'function verificationResult(bytes32 evidenceHash,uint256 index) external view returns ((uint256 agentId,bytes32 serviceHash,uint8 verdict))',
  'function registry() external view returns (address)',
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'event VerificationBundleSubmitted(bytes32 indexed evidenceHash,address indexed verifier,uint32 resultCount,string evidenceUri)',
  'event VerificationResultSubmitted(bytes32 indexed evidenceHash,uint256 indexed agentId,bytes32 indexed serviceHash,address verifier,uint8 verdict)',
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

export class VerifierClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFICATION_ABI, this._provider);
    return this._contractInstance;
  }

  async setVerifier(signer: AbstractSigner, verifier: string, approved: boolean): Promise<string> {
    return this._execWrite(signer, VERIFICATION_ABI, 'setVerifier', getAddress(verifier), approved);
  }

  async submitVerificationBundle(signer: AbstractSigner, input: SubmitVerificationBundleInput): Promise<string> {
    return this._execWrite(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
      input.evidenceHash,
      input.evidenceUri,
      input.results.map((result) => ({
        agentId: BigInt(result.agentId),
        serviceHash: result.serviceHash,
        verdict: result.verdict,
      })),
    );
  }

  async isVerificationSubmitted(evidenceHash: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isVerificationSubmitted')(evidenceHash));
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

  async queryAttestations(
    agentId: number | bigint,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<AttestationSubmittedEvent[]> {
    const contract = this._contract();
    const resultFilterFactory = contract.filters.VerificationResultSubmitted;
    if (!resultFilterFactory) {
      throw new Error('verification events are missing from verification ABI');
    }
    const resultLogs = await contract.queryFilter(
      resultFilterFactory(null, BigInt(agentId), null),
      fromBlock,
      toBlock,
    );
    return resultLogs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      const evidenceHash = String(log.args.evidenceHash ?? log.args[0]);
      return [{
        auditId: evidenceHash,
        verifier: getAddress(String(log.args.verifier ?? log.args[3])),
        agentId: BigInt(log.args.agentId ?? log.args[1]),
        serviceHash: String(log.args.serviceHash ?? log.args[2]),
        verdict: Number(log.args.verdict ?? log.args[4]) as VerifierVerdict,
        evidenceHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }

  async queryBundles(
    evidenceHash: string | null = null,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<VerificationBundleSubmittedEvent[]> {
    const contract = this._contract();
    const filterFactory = contract.filters.VerificationBundleSubmitted;
    if (!filterFactory) throw new Error('VerificationBundleSubmitted event is missing from verification ABI');
    return this._bundleEvents(await contract.queryFilter(filterFactory(evidenceHash), fromBlock, toBlock));
  }

  private _bundleEvents(logs: readonly unknown[]): VerificationBundleSubmittedEvent[] {
    return logs.flatMap((log) => {
      if (!(log instanceof EventLog)) return [];
      return [{
        evidenceHash: String(log.args.evidenceHash ?? log.args[0]),
        verifier: getAddress(String(log.args.verifier ?? log.args[1])),
        resultCount: Number(log.args.resultCount ?? log.args[2]),
        evidenceUri: String(log.args.evidenceUri ?? log.args[3]),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        transactionHash: log.transactionHash,
      }];
    });
  }
}
