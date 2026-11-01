import { Contract, EventLog, getAddress, type AbstractSigner, type ContractEventName } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from './block-range.js';
import { VERIFIER_VERDICT, type VerifierClientConfig, type VerifierVerdict } from './kbf-verdict.js';

/**
 * Client for the distributed KBF verification round (AntseedKbfVerification): epoch state,
 * publisher and verifier writes, and the events verifiers rebuild an epoch from.
 */

export const KBF_ROUND_ABI = [
  'function isVerifier(address verifier) view returns (bool)',
  'function verifiers() view returns (address[])',
  'function encryptionKeys(address verifier) view returns (bytes32)',
  'function publisher() view returns (address)',
  'function publisherGraceSeconds() view returns (uint32)',
  'function modelsVersion() view returns (uint32)',
  'function models(uint32 version) view returns ((bytes32 modelHash, string service)[])',
  'function schedule() view returns ((uint32 collectSeconds, uint32 backupSeconds, uint32 attestSeconds, uint16 probesPerService, uint16 slicesPerService))',
  'function epochInfo(uint256 epoch) view returns ((uint256 startedAt, uint64 seedBlock, bytes32 seed, uint32 modelsVersion, uint16 verifierCount, (uint32 collectSeconds, uint32 backupSeconds, uint32 attestSeconds, uint16 probesPerService, uint16 slicesPerService) schedule, bytes32 bankHash, bytes32 bankKeyHash, bytes32 bankKey, bytes32 planHash, bytes32 finalizedRoot, bool voided, address publisher, uint64 takenOverAt, bytes32 keySharesHash, bool planActive))',
  'function epochVerifiers(uint256 epoch) view returns (address[])',
  'function threshold(uint256 epoch) view returns (uint256)',
  'function attestations(uint256 epoch, address verifier) view returns (bytes32)',
  'function rootVotes(uint256 epoch, bytes32 root) view returns (uint256)',
  'function sliceCommits(uint256 epoch, address verifier) view returns (uint256)',
  'function rewardClaimed(uint256 epoch, address verifier) view returns (bool)',
  'function resultApplied(uint256 epoch, bytes32 leaf) view returns (bool)',
  'function keyShareRevealed(uint256 epoch, address verifier) view returns (bool)',
  'function planAcceptances(uint256 epoch) view returns (uint256)',
  'function hasAcceptedPlan(uint256 epoch, address verifier) view returns (bool)',
  'function requiredPlanAcceptances(uint256 epoch) view returns (uint256)',
  'function takeovers(uint256 epoch, address verifier) view returns (uint256)',
  'function emissionsGate() view returns (address)',
  'function setEncryptionKey(bytes32 key)',
  'function commitBank(uint256 epoch, bytes32 bankHash, bytes32 bankKeyHash, string bankUri)',
  'function takeOverBank(uint256 epoch, bytes32 bankHash, bytes32 bankKeyHash, string bankUri)',
  'function commitKeyShares(uint256 epoch, bytes32 sharesHash, string sharesUri)',
  'function acceptPlan(uint256 epoch, bytes32 sharesHash, bytes32 planHash)',
  'function revealKeyShare(uint256 epoch, bytes share)',
  'function openEpoch(uint256 epoch)',
  'function fixSeed(uint256 epoch)',
  'function commitPlan(uint256 epoch, bytes32 planHash, string planUri)',
  'function revealBankKey(uint256 epoch, bytes32 bankKey)',
  'function commitSlices(uint256 epoch, bytes32 slicesRoot, string manifestUri)',
  'function attest(uint256 epoch, bytes32 resultsRoot, string evidenceUri)',
  'function applyResults(uint256 epoch, (uint256 agentId, bytes32 serviceHash, bytes32 modelHash, uint8 verdict)[] results, bytes32[][] proofs)',
  'function claimRewards(uint256 epoch, uint32 slices, uint32 totalSlices, bytes32[] proof) returns (uint256)',
  'function pendingReward(address verifier, uint256 epoch, uint32 slices, uint32 totalSlices, bytes32[] proof) view returns (uint256)',
  'event BankCommitted(uint256 indexed epoch, bytes32 bankHash, bytes32 bankKeyHash, string bankUri)',
  'event PlanCommitted(uint256 indexed epoch, bytes32 planHash, string planUri)',
  'event SlicesCommitted(uint256 indexed epoch, address indexed verifier, bool backup, bytes32 slicesRoot, string manifestUri)',
  'event Attested(uint256 indexed epoch, address indexed verifier, bytes32 resultsRoot, string evidenceUri)',
  'event EpochTakenOver(uint256 indexed epoch, address indexed verifier)',
  'event KeySharesCommitted(uint256 indexed epoch, bytes32 sharesHash, string sharesUri)',
  'event KeyShareRevealed(uint256 indexed epoch, address indexed verifier, bytes share)',
] as const;

const EMISSIONS_GATE_ABI = [
  'function currentEpoch() view returns (uint256)',
  'function genesis() view returns (uint256)',
  'function epochDuration() view returns (uint256)',
] as const;

export interface KbfModel {
  modelHash: string;
  service: string;
}

export interface KbfSchedule {
  collectSeconds: number;
  backupSeconds: number;
  attestSeconds: number;
  probesPerService: number;
  slicesPerService: number;
}

export interface KbfEpochInfo {
  epoch: bigint;
  startedAt: number;
  seedBlock: bigint;
  /** Zero hash until fixed. */
  seed: string;
  modelsVersion: number;
  verifierCount: number;
  schedule: KbfSchedule;
  bankHash: string;
  bankKeyHash: string;
  bankKey: string;
  planHash: string;
  finalizedRoot: string;
  voided: boolean;
  /** Whoever committed the bank: the publisher, or a verifier that took the epoch over. Zero address until then. */
  publisher: string;
  /** Time of the latest takeover; 0 if the publisher kept the epoch. */
  takenOverAt: number;
  /** Hash of the escrowed key-share file; zero hash until committed. */
  keySharesHash: string;
  /** Whether verifiers accepted the plan: collection runs, and the epoch can no longer be taken over. */
  planActive: boolean;
}

/** Absolute deadlines (unix seconds) of one epoch's round. */
export interface KbfEpochDeadlines {
  startedAt: number;
  commitDeadline: number;
  backupDeadline: number;
  attestDeadline: number;
  endsAt: number;
}

export interface KbfServiceResult {
  agentId: bigint;
  serviceHash: string;
  modelHash: string;
  verdict: VerifierVerdict;
}

export interface CommitmentEvent {
  epoch: bigint;
  hash: string;
  uri: string;
  backup: boolean;
  /** Verifier for slice commits and attestations; the publisher otherwise. */
  sender: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
}

export interface BankCommittedEvent {
  epoch: bigint;
  bankHash: string;
  bankKeyHash: string;
  bankUri: string;
  blockNumber: number;
}

export interface KeyShareRevealedEvent {
  epoch: bigint;
  verifier: string;
  /** 0x-prefixed share bytes as posted. */
  share: string;
  blockNumber: number;
  logIndex: number;
}

export const ZERO_HASH = `0x${'0'.repeat(64)}`;

export function isZeroHash(value: string): boolean {
  return BigInt(value) === 0n;
}

export function kbfEpochDeadlines(info: Pick<KbfEpochInfo, 'startedAt' | 'schedule'>, epochDuration: number): KbfEpochDeadlines {
  const commitDeadline = info.startedAt + info.schedule.collectSeconds;
  const backupDeadline = commitDeadline + info.schedule.backupSeconds;
  return {
    startedAt: info.startedAt,
    commitDeadline,
    backupDeadline,
    attestDeadline: backupDeadline + info.schedule.attestSeconds,
    endsAt: info.startedAt + epochDuration,
  };
}

function toSchedule(raw: readonly unknown[] | Record<string, unknown>): KbfSchedule {
  const value = raw as Record<string, bigint>;
  return {
    collectSeconds: Number(value['collectSeconds']),
    backupSeconds: Number(value['backupSeconds']),
    attestSeconds: Number(value['attestSeconds']),
    probesPerService: Number(value['probesPerService']),
    slicesPerService: Number(value['slicesPerService']),
  };
}

export class KbfRoundClient extends BaseEvmClient {
  private _contractInstance: Contract | null = null;
  private _gate: Contract | null = null;
  private readonly _deploymentBlock: number | undefined;
  private readonly _logQueryChunkBlocks: number | undefined;

  constructor(config: VerifierClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._deploymentBlock = config.deploymentBlock;
    this._logQueryChunkBlocks = config.logQueryChunkBlocks;
  }

  get contractAddress(): string {
    return this._contractAddress;
  }

  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, KBF_ROUND_ABI, this._provider);
    return this._contractInstance;
  }

  private async _emissionsGate(): Promise<Contract> {
    if (!this._gate) {
      const address = String(await this._contract().getFunction('emissionsGate')());
      this._gate = new Contract(address, EMISSIONS_GATE_ABI, this._provider);
    }
    return this._gate;
  }

  // ── reads ───────────────────────────────────────────────────────

  async currentEpoch(): Promise<bigint> {
    return BigInt(await (await this._emissionsGate()).getFunction('currentEpoch')());
  }

  async genesis(): Promise<number> {
    return Number(await (await this._emissionsGate()).getFunction('genesis')());
  }

  async epochDuration(): Promise<number> {
    return Number(await (await this._emissionsGate()).getFunction('epochDuration')());
  }

  /** Timestamp of the latest block, read uncached: deadlines are compared against chain time. */
  async now(): Promise<number> {
    const block = await this._rpc('eth_getBlockByNumber', ['latest', false]) as { timestamp?: string } | null;
    if (!block?.timestamp) throw new Error('latest block unavailable');
    return Number(BigInt(block.timestamp));
  }

  /** Raw JSON-RPC, bypassing ethers' block-number and block caches. */
  private async _rpc(method: string, params: unknown[]): Promise<unknown> {
    const provider = this._provider as unknown as {
      send?: (method: string, params: unknown[]) => Promise<unknown>;
      providerConfigs?: ReadonlyArray<{ provider: { send?: (method: string, params: unknown[]) => Promise<unknown> } }>;
    };
    if (typeof provider.send === 'function') return provider.send(method, params);
    let lastError: unknown = new Error('no JSON-RPC provider');
    for (const config of provider.providerConfigs ?? []) {
      if (typeof config.provider.send !== 'function') continue;
      try {
        return await config.provider.send(method, params);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async latestBlockNumber(): Promise<number> {
    return Number(BigInt(await this._rpc('eth_blockNumber', []) as string));
  }

  async isVerifier(address: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('isVerifier')(getAddress(address)));
  }

  async verifiers(): Promise<string[]> {
    return ((await this._contract().getFunction('verifiers')()) as string[]).map((value) => getAddress(value));
  }

  async encryptionKey(verifier: string): Promise<string> {
    return String(await this._contract().getFunction('encryptionKeys')(getAddress(verifier)));
  }

  async publisher(): Promise<string> {
    return getAddress(String(await this._contract().getFunction('publisher')()));
  }

  async publisherGraceSeconds(): Promise<number> {
    return Number(await this._contract().getFunction('publisherGraceSeconds')());
  }

  async keyShareRevealed(epoch: bigint, verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('keyShareRevealed')(epoch, getAddress(verifier)));
  }

  /** Acceptances of the epoch's current bank, key escrow and plan so far. */
  async planAcceptances(epoch: bigint): Promise<number> {
    return Number(await this._contract().getFunction('planAcceptances')(epoch));
  }

  /** Whether `verifier` accepted the epoch's current bank, key escrow and plan. */
  async hasAcceptedPlan(epoch: bigint, verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('hasAcceptedPlan')(epoch, getAddress(verifier)));
  }

  /** Acceptances the epoch's plan needs to take effect. */
  async requiredPlanAcceptances(epoch: bigint): Promise<number> {
    return Number(await this._contract().getFunction('requiredPlanAcceptances')(epoch));
  }

  /** Takeovers `verifier` made in the epoch. */
  async takeovers(epoch: bigint, verifier: string): Promise<number> {
    return Number(await this._contract().getFunction('takeovers')(epoch, getAddress(verifier)));
  }

  async modelsVersion(): Promise<number> {
    return Number(await this._contract().getFunction('modelsVersion')());
  }

  async models(version: number): Promise<KbfModel[]> {
    const raw = (await this._contract().getFunction('models')(version)) as Array<{ modelHash: string; service: string }>;
    return raw.map((model) => ({ modelHash: String(model.modelHash), service: String(model.service) }));
  }

  async schedule(): Promise<KbfSchedule> {
    return toSchedule(await this._contract().getFunction('schedule')());
  }

  async epochInfo(epoch: bigint): Promise<KbfEpochInfo> {
    const raw = (await this._contract().getFunction('epochInfo')(epoch)) as Record<string, unknown>;
    return {
      epoch,
      startedAt: Number(raw['startedAt']),
      seedBlock: BigInt(raw['seedBlock'] as bigint),
      seed: String(raw['seed']),
      modelsVersion: Number(raw['modelsVersion']),
      verifierCount: Number(raw['verifierCount']),
      schedule: toSchedule(raw['schedule'] as Record<string, unknown>),
      bankHash: String(raw['bankHash']),
      bankKeyHash: String(raw['bankKeyHash']),
      bankKey: String(raw['bankKey']),
      planHash: String(raw['planHash']),
      finalizedRoot: String(raw['finalizedRoot']),
      voided: Boolean(raw['voided']),
      publisher: getAddress(String(raw['publisher'])),
      takenOverAt: Number(raw['takenOverAt']),
      keySharesHash: String(raw['keySharesHash']),
      planActive: Boolean(raw['planActive']),
    };
  }

  async epochVerifiers(epoch: bigint): Promise<string[]> {
    return ((await this._contract().getFunction('epochVerifiers')(epoch)) as string[]).map((value) => getAddress(value));
  }

  async threshold(epoch: bigint): Promise<number> {
    return Number(await this._contract().getFunction('threshold')(epoch));
  }

  async attestation(epoch: bigint, verifier: string): Promise<string> {
    return String(await this._contract().getFunction('attestations')(epoch, getAddress(verifier)));
  }

  async sliceCommitCount(epoch: bigint, verifier: string): Promise<number> {
    return Number(await this._contract().getFunction('sliceCommits')(epoch, getAddress(verifier)));
  }

  async rewardClaimed(epoch: bigint, verifier: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('rewardClaimed')(epoch, getAddress(verifier)));
  }

  async resultApplied(epoch: bigint, leaf: string): Promise<boolean> {
    return Boolean(await this._contract().getFunction('resultApplied')(epoch, leaf));
  }

  async pendingReward(verifier: string, epoch: bigint, slices: number, totalSlices: number, proof: string[]): Promise<bigint> {
    return BigInt(
      await this._contract().getFunction('pendingReward')(getAddress(verifier), epoch, slices, totalSlices, proof),
    );
  }

  // ── writes ──────────────────────────────────────────────────────

  async setEncryptionKey(signer: AbstractSigner, key: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'setEncryptionKey', key);
  }

  async commitBank(signer: AbstractSigner, epoch: bigint, bankHash: string, bankKeyHash: string, bankUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'commitBank', epoch, bankHash, bankKeyHash, bankUri);
  }

  /** Stands in for a publisher that missed its plan: the caller's bank replaces the epoch's. */
  async takeOverBank(signer: AbstractSigner, epoch: bigint, bankHash: string, bankKeyHash: string, bankUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'takeOverBank', epoch, bankHash, bankKeyHash, bankUri);
  }

  async commitKeyShares(signer: AbstractSigner, epoch: bigint, sharesHash: string, sharesUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'commitKeyShares', epoch, sharesHash, sharesUri);
  }

  async acceptPlan(signer: AbstractSigner, epoch: bigint, sharesHash: string, planHash: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'acceptPlan', epoch, sharesHash, planHash);
  }

  async revealKeyShare(signer: AbstractSigner, epoch: bigint, share: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'revealKeyShare', epoch, share);
  }

  async openEpoch(signer: AbstractSigner, epoch: bigint): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'openEpoch', epoch);
  }

  async fixSeed(signer: AbstractSigner, epoch: bigint): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'fixSeed', epoch);
  }

  async commitPlan(signer: AbstractSigner, epoch: bigint, planHash: string, planUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'commitPlan', epoch, planHash, planUri);
  }

  async revealBankKey(signer: AbstractSigner, epoch: bigint, bankKey: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'revealBankKey', epoch, bankKey);
  }

  async commitSlices(signer: AbstractSigner, epoch: bigint, slicesRoot: string, manifestUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'commitSlices', epoch, slicesRoot, manifestUri);
  }

  async attest(signer: AbstractSigner, epoch: bigint, resultsRoot: string, evidenceUri: string): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'attest', epoch, resultsRoot, evidenceUri);
  }

  async applyResults(
    signer: AbstractSigner,
    epoch: bigint,
    results: readonly KbfServiceResult[],
    proofs: readonly string[][],
  ): Promise<string> {
    return this._execWrite(
      signer,
      KBF_ROUND_ABI,
      'applyResults',
      epoch,
      results.map((result) => [result.agentId, result.serviceHash, result.modelHash, result.verdict]),
      proofs,
    );
  }

  async claimRewards(
    signer: AbstractSigner,
    epoch: bigint,
    slices: number,
    totalSlices: number,
    proof: string[],
  ): Promise<string> {
    return this._execWrite(signer, KBF_ROUND_ABI, 'claimRewards', epoch, slices, totalSlices, proof);
  }

  // ── events ──────────────────────────────────────────────────────

  async bankCommits(epoch: bigint, fromBlock?: number): Promise<BankCommittedEvent[]> {
    const contract = this._contract();
    const logs = await this._queryEvents(contract, contract.filters['BankCommitted']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      bankHash: String(log.args[1]),
      bankKeyHash: String(log.args[2]),
      bankUri: String(log.args[3]),
      blockNumber: log.blockNumber,
    }));
  }

  /** Plans proposed for the epoch. `publisher` (the epoch publisher, as `sender`) saves a read when the caller has it. */
  async planCommits(epoch: bigint, fromBlock?: number, publisher?: string): Promise<CommitmentEvent[]> {
    const contract = this._contract();
    const sender = publisher ?? (await this.epochInfo(epoch)).publisher;
    const logs = await this._queryEvents(contract, contract.filters['PlanCommitted']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      hash: String(log.args[1]),
      uri: String(log.args[2]),
      backup: false,
      sender,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
    }));
  }

  async sliceCommits(epoch: bigint, fromBlock?: number): Promise<CommitmentEvent[]> {
    const contract = this._contract();
    const logs = await this._queryEvents(contract, contract.filters['SlicesCommitted']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      sender: getAddress(String(log.args[1])),
      backup: Boolean(log.args[2]),
      hash: String(log.args[3]),
      uri: String(log.args[4]),
      blockNumber: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
    }));
  }

  async attestationEvents(epoch: bigint, fromBlock?: number): Promise<CommitmentEvent[]> {
    const contract = this._contract();
    const logs = await this._queryEvents(contract, contract.filters['Attested']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      sender: getAddress(String(log.args[1])),
      backup: false,
      hash: String(log.args[2]),
      uri: String(log.args[3]),
      blockNumber: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
    }));
  }

  /** Key-share files committed for the epoch; the latest one is current. */
  async keySharesCommits(epoch: bigint, fromBlock?: number, publisher?: string): Promise<CommitmentEvent[]> {
    const contract = this._contract();
    const sender = publisher ?? (await this.epochInfo(epoch)).publisher;
    const logs = await this._queryEvents(contract, contract.filters['KeySharesCommitted']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      hash: String(log.args[1]),
      uri: String(log.args[2]),
      backup: false,
      sender,
      blockNumber: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
    }));
  }

  async keyShareReveals(epoch: bigint, fromBlock?: number): Promise<KeyShareRevealedEvent[]> {
    const contract = this._contract();
    const logs = await this._queryEvents(contract, contract.filters['KeyShareRevealed']!(epoch), fromBlock);
    return logs.filter((log): log is EventLog => log instanceof EventLog).map((log) => ({
      epoch: BigInt(log.args[0]),
      verifier: getAddress(String(log.args[1])),
      share: String(log.args[2]),
      blockNumber: log.blockNumber,
      logIndex: log.index,
    }));
  }

  private async _queryEvents(
    contract: Contract,
    event: ContractEventName,
    fromBlock: number | undefined,
  ): Promise<Awaited<ReturnType<Contract['queryFilter']>>> {
    const from = resolveScanFromBlock(fromBlock, this._deploymentBlock, 'verification contract');
    const to = await this._provider.getBlockNumber();
    return queryInBlockChunks(
      from,
      to,
      (start, end) => contract.queryFilter(event, start, end),
      { chunkBlocks: this._logQueryChunkBlocks, openEnded: true },
    );
  }
}

export { VERIFIER_VERDICT };
