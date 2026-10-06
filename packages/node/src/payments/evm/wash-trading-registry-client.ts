import { Contract, keccak256, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface WashTradingRegistryClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }

export interface WashTradingSellerStatus {
  seller: string;
  provenWashVolume: bigint;
  totalSellerVolume: bigint;
  provenWashShareBps: number;
  evidenceDigest: string;
  isProvenWashTrader: boolean;
  thresholdBps: number;
}

export interface WashTradingProofStatus {
  proofId: string;
  staged: boolean;
  finalized: boolean;
  authenticatedBlockReferenceCount: number;
  authenticatedBlockChunkCount: number;
}

export interface WashTradingRegistryConfig {
  verifierHash: string;
  sellerProgramVKey: string;
  periodStartBlock: number;
  periodEndBlock: number;
  thresholdBps: number;
  blockhashStore: string;
  verifier: string;
}

export interface BlockReference { number: number; blockHash: string; }

/** Chunk from a loop-proof `antseed-wash-trading-seller-proof` artifact. */
export interface BlockAuthenticationChunk { index: number; references: BlockReference[]; proof: string[]; }

/**
 * Seller proof artifact produced by the loop-proof host
 * (`kind: antseed-wash-trading-seller-proof`, `proofArchitecture: direct-seller-v1`).
 */
export interface SellerProofArtifact {
  version: number;
  kind: string;
  proofArchitecture?: string;
  chainId?: number;
  seller: string;
  publicValues: string;
  proofBytes: string;
  evidenceDigest?: string;
  blockReferenceCount: number;
  blockAuthenticationRoot?: string;
  blockAuthenticationChunkSize: number;
  blockAuthenticationChunkCount: number;
  blockAuthenticationChunks: BlockAuthenticationChunk[];
}

export type SellerProofSubmissionStep =
  | { kind: 'stage'; proofId: string; hash?: string; skipped: boolean }
  | { kind: 'authenticate'; proofId: string; chunkIndex: number; chunkCount: number; hash?: string; skipped: boolean }
  | { kind: 'finalize'; proofId: string; hash?: string; skipped: boolean };

const ABI = [
  'function stageSellerProof(bytes publicValues, bytes proofBytes) external returns (bytes32 proofId)',
  'function authenticateBlockReferences(bytes32 proofId, uint32 chunkIndex, tuple(uint64 number, bytes32 blockHash)[] references, bytes32[] proof) external',
  'function finalizeSellerProof(bytes32 proofId) external',
  'function verifier() external view returns (address)',
  'function verifierHash() external view returns (bytes32)',
  'function blockhashStore() external view returns (address)',
  'function sellerProgramVKey() external view returns (bytes32)',
  'function periodStartBlock() external view returns (uint64)',
  'function periodEndBlock() external view returns (uint64)',
  'function WASH_TRADING_THRESHOLD_BPS() external view returns (uint256)',
  'function proofStaged(bytes32 proofId) external view returns (bool)',
  'function proofFinalized(bytes32 proofId) external view returns (bool)',
  'function proofAuthenticatedBlockReferenceCount(bytes32 proofId) external view returns (uint32)',
  'function proofAuthenticatedBlockChunkCount(bytes32 proofId) external view returns (uint32)',
  'function proofBlockChunkAuthenticated(bytes32 proofId, uint32 chunkIndex) external view returns (bool)',
  'function provenWashVolume(address seller) external view returns (uint128)',
  'function totalSellerVolume(address seller) external view returns (uint128)',
  'function provenWashShareBps(address seller) external view returns (uint256)',
  'function sellerEvidenceDigest(address seller) external view returns (bytes32)',
  'function isProvenWashTrader(address seller) external view returns (bool)',
] as const;

const BYTES32 = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;

export function sellerProofId(publicValues: string): string {
  return keccak256(publicValues);
}

/** Structural validation of a loop-proof seller artifact before any transaction is sent. */
export function validateSellerProofArtifact(artifact: unknown): SellerProofArtifact {
  const value = artifact as Partial<SellerProofArtifact> | null;
  if (!value || typeof value !== 'object') throw new Error('Seller proof artifact must be a JSON object.');
  if (value.kind !== 'antseed-wash-trading-seller-proof') throw new Error(`Unexpected artifact kind '${String(value.kind)}'; expected antseed-wash-trading-seller-proof.`);
  if (value.proofArchitecture !== undefined && value.proofArchitecture !== 'direct-seller-v1') {
    throw new Error(`Unsupported proof architecture '${String(value.proofArchitecture)}'; the registry accepts direct-seller-v1.`);
  }
  if (typeof value.publicValues !== 'string' || !HEX.test(value.publicValues) || value.publicValues.length <= 2) throw new Error('Artifact publicValues must be hex bytes.');
  if (typeof value.proofBytes !== 'string' || !HEX.test(value.proofBytes) || value.proofBytes.length <= 2) throw new Error('Artifact proofBytes must be hex bytes.');
  if (typeof value.seller !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value.seller)) throw new Error('Artifact seller must be an address.');
  const chunkSize = Number(value.blockAuthenticationChunkSize);
  const chunkCount = Number(value.blockAuthenticationChunkCount);
  const referenceCount = Number(value.blockReferenceCount);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('Artifact blockAuthenticationChunkSize must be positive.');
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) throw new Error('Artifact blockAuthenticationChunkCount must be positive.');
  const chunks = value.blockAuthenticationChunks;
  if (!Array.isArray(chunks) || chunks.length !== chunkCount) throw new Error(`Artifact has ${Array.isArray(chunks) ? chunks.length : 0} chunks but declares ${chunkCount}.`);
  let previous = 0;
  let total = 0;
  const normalized: BlockAuthenticationChunk[] = chunks.map((chunk, index) => {
    if (!chunk || chunk.index !== index) throw new Error(`Chunk ${index} is missing or out of order.`);
    if (!Array.isArray(chunk.references) || chunk.references.length === 0 || chunk.references.length > chunkSize) throw new Error(`Chunk ${index} has an invalid reference count.`);
    if (index < chunkCount - 1 && chunk.references.length !== chunkSize) throw new Error(`Chunk ${index} must hold exactly ${chunkSize} references.`);
    if (!Array.isArray(chunk.proof) || chunk.proof.some((node) => typeof node !== 'string' || !BYTES32.test(node))) throw new Error(`Chunk ${index} has an invalid Merkle proof.`);
    const references = chunk.references.map((reference) => {
      const number = Number(reference.number);
      if (!Number.isSafeInteger(number) || number <= previous) throw new Error(`Chunk ${index} block references must be strictly increasing.`);
      if (typeof reference.blockHash !== 'string' || !BYTES32.test(reference.blockHash)) throw new Error(`Chunk ${index} has an invalid block hash.`);
      previous = number;
      return { number, blockHash: reference.blockHash.toLowerCase() };
    });
    total += references.length;
    return { index, references, proof: chunk.proof.map((node) => node.toLowerCase()) };
  });
  if (total !== referenceCount) throw new Error(`Artifact chunks hold ${total} references but declare ${referenceCount}.`);
  return {
    version: Number(value.version), kind: value.kind, proofArchitecture: value.proofArchitecture, chainId: value.chainId,
    seller: value.seller, publicValues: value.publicValues, proofBytes: value.proofBytes, evidenceDigest: value.evidenceDigest,
    blockReferenceCount: referenceCount, blockAuthenticationRoot: value.blockAuthenticationRoot,
    blockAuthenticationChunkSize: chunkSize, blockAuthenticationChunkCount: chunkCount, blockAuthenticationChunks: normalized,
  };
}

export class WashTradingRegistryClient extends BaseEvmClient {
  constructor(config: WashTradingRegistryClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }

  async registryConfig(): Promise<WashTradingRegistryConfig> {
    const contract = this.contract();
    const [verifier, verifierHash, blockhashStore, sellerProgramVKey, periodStartBlock, periodEndBlock, thresholdBps] = await Promise.all([
      contract.getFunction('verifier')(), contract.getFunction('verifierHash')(), contract.getFunction('blockhashStore')(),
      contract.getFunction('sellerProgramVKey')(), contract.getFunction('periodStartBlock')(), contract.getFunction('periodEndBlock')(),
      contract.getFunction('WASH_TRADING_THRESHOLD_BPS')(),
    ]);
    return {
      verifier, verifierHash, blockhashStore, sellerProgramVKey,
      periodStartBlock: Number(periodStartBlock), periodEndBlock: Number(periodEndBlock), thresholdBps: Number(thresholdBps),
    };
  }

  async sellerStatus(seller: string): Promise<WashTradingSellerStatus> {
    const contract = this.contract();
    const [provenWashVolume, totalSellerVolume, provenWashShareBps, evidenceDigest, isProvenWashTrader, thresholdBps] = await Promise.all([
      contract.getFunction('provenWashVolume')(seller), contract.getFunction('totalSellerVolume')(seller),
      contract.getFunction('provenWashShareBps')(seller), contract.getFunction('sellerEvidenceDigest')(seller),
      contract.getFunction('isProvenWashTrader')(seller), contract.getFunction('WASH_TRADING_THRESHOLD_BPS')(),
    ]);
    return {
      seller, provenWashVolume, totalSellerVolume, provenWashShareBps: Number(provenWashShareBps), evidenceDigest,
      isProvenWashTrader, thresholdBps: Number(thresholdBps),
    };
  }

  isProvenWashTrader(seller: string): Promise<boolean> { return this.contract().getFunction('isProvenWashTrader')(seller); }

  async proofStatus(proofId: string): Promise<WashTradingProofStatus> {
    const contract = this.contract();
    const [staged, finalized, references, chunks] = await Promise.all([
      contract.getFunction('proofStaged')(proofId), contract.getFunction('proofFinalized')(proofId),
      contract.getFunction('proofAuthenticatedBlockReferenceCount')(proofId), contract.getFunction('proofAuthenticatedBlockChunkCount')(proofId),
    ]);
    return { proofId, staged, finalized, authenticatedBlockReferenceCount: Number(references), authenticatedBlockChunkCount: Number(chunks) };
  }
  proofBlockChunkAuthenticated(proofId: string, chunkIndex: number): Promise<boolean> {
    return this.contract().getFunction('proofBlockChunkAuthenticated')(proofId, chunkIndex);
  }

  stageSellerProof(signer: AbstractSigner, publicValues: string, proofBytes: string): Promise<string> {
    return this._execWrite(signer, ABI, 'stageSellerProof', publicValues, proofBytes);
  }
  authenticateBlockReferences(signer: AbstractSigner, proofId: string, chunk: BlockAuthenticationChunk): Promise<string> {
    const references = chunk.references.map((reference) => ({ number: reference.number, blockHash: reference.blockHash }));
    return this._execWrite(signer, ABI, 'authenticateBlockReferences', proofId, chunk.index, references, chunk.proof);
  }
  finalizeSellerProof(signer: AbstractSigner, proofId: string): Promise<string> {
    return this._execWrite(signer, ABI, 'finalizeSellerProof', proofId);
  }

  /**
   * Stage, authenticate every committed chunk, and finalize a seller proof.
   * Resumable: steps already recorded on chain are skipped, so an interrupted
   * submission can be re-run with the same artifact.
   */
  async submitSellerProof(
    signer: AbstractSigner,
    artifact: SellerProofArtifact,
    onStep: (step: SellerProofSubmissionStep) => void | Promise<void> = () => {},
  ): Promise<{ proofId: string; finalized: boolean }> {
    const proofId = sellerProofId(artifact.publicValues);
    const status = await this.proofStatus(proofId);
    if (status.finalized) {
      await onStep({ kind: 'finalize', proofId, skipped: true });
      return { proofId, finalized: true };
    }
    if (status.staged) {
      await onStep({ kind: 'stage', proofId, skipped: true });
    } else {
      const hash = await this.stageSellerProof(signer, artifact.publicValues, artifact.proofBytes);
      await onStep({ kind: 'stage', proofId, hash, skipped: false });
    }
    const chunkCount = artifact.blockAuthenticationChunkCount;
    for (const chunk of artifact.blockAuthenticationChunks) {
      if (await this.proofBlockChunkAuthenticated(proofId, chunk.index)) {
        await onStep({ kind: 'authenticate', proofId, chunkIndex: chunk.index, chunkCount, skipped: true });
        continue;
      }
      const hash = await this.authenticateBlockReferences(signer, proofId, chunk);
      await onStep({ kind: 'authenticate', proofId, chunkIndex: chunk.index, chunkCount, hash, skipped: false });
    }
    const hash = await this.finalizeSellerProof(signer, proofId);
    await onStep({ kind: 'finalize', proofId, hash, skipped: false });
    return { proofId, finalized: true };
  }
}
