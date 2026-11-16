import { Contract, id as keccak256, isError, zeroPadValue, type AbstractSigner, type ContractTransactionResponse, type Log } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface IdentityClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
  /** First block of the registry; floor for {@link IdentityClient.findOwnedAgentIds}. */
  deployBlock?: number;
}

/** How far back {@link IdentityClient.findOwnedAgentIds} scans when the registry's deploy block is unknown (~46 days on Base). */
export const DEFAULT_AGENT_LOOKBACK_BLOCKS = 2_000_000;

export interface FindOwnedAgentIdsOptions {
  /** Lowest block to scan. Defaults to the deploy block, else head minus `maxLookbackBlocks`. */
  fromBlock?: number;
  /**
   * Blocks per `eth_getLogs` window (inclusive) to start with. Public Base RPCs
   * cap the range (some at 1,000 blocks or fewer), so a failed window is
   * retried ten times smaller, down to {@link MIN_AGENT_LOG_CHUNK_BLOCKS}.
   */
  chunkBlocks?: number;
  /** Lookback used only when neither `fromBlock` nor the deploy block is known. */
  maxLookbackBlocks?: number;
  /** Called after each window with the lowest block scanned so far and the floor. */
  onProgress?: (scannedDownTo: number, floor: number) => void;
}

/**
 * First window of {@link IdentityClient.findOwnedAgentIds}. The default Base
 * RPCs answer filtered `eth_getLogs` over 1,000 blocks; some cap lower.
 */
export const DEFAULT_AGENT_LOG_CHUNK_BLOCKS = 1_000;

/** Smallest window {@link IdentityClient.findOwnedAgentIds} shrinks to before giving up. */
export const MIN_AGENT_LOG_CHUNK_BLOCKS = 10;

const TRANSFER_TOPIC = keccak256('Transfer(address,address,uint256)');

const IDENTITY_REGISTRY_ABI = [
  // Registration
  'function register() external returns (uint256)',
  'function register(string uri) external returns (uint256)',

  // View — identity lookups
  'function ownerOf(uint256 agentId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',

  // Metadata
  'function setMetadata(uint256 agentId, string key, bytes value) external',
  'function getMetadata(uint256 agentId, string key) external view returns (bytes)',
  'function setAgentURI(uint256 agentId, string uri) external',
] as const;


export class IdentityClient extends BaseEvmClient {
  private readonly _deployBlock?: number;

  constructor(config: IdentityClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._deployBlock = config.deployBlock;
  }

  // ── Write methods ──────────────────────────────────────────────────

  /**
   * Register a new agent identity via ERC-8004 IdentityRegistry.
   * Returns the new agentId. The peerId is the signer's EVM address
   * (ownerOf(agentId)), so no separate metadata storage is needed.
   */
  async register(
    signer: AbstractSigner,
    metadataURI?: string,
    onTransaction?: (hash: string) => void,
  ): Promise<number> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, connected);

    let tx: ContractTransactionResponse;
    if (metadataURI) {
      tx = await this._sendWithNonce(signerAddress, (nonce) => contract.getFunction('register(string)')(metadataURI, { nonce }));
    } else {
      tx = await this._sendWithNonce(signerAddress, (nonce) => contract.getFunction('register()')({ nonce }));
    }
    onTransaction?.(tx.hash);
    const receipt = await this._waitForReceipt(tx);

    // Extract agentId from Transfer event (ERC-721 Transfer(address,address,uint256))
    const transferLog = receipt.logs.find((l) => l.topics?.[0] === TRANSFER_TOPIC);
    const rawAgentId = transferLog?.topics?.[3];
    return rawAgentId ? Number(BigInt(rawAgentId)) : 0;
  }

  async setMetadata(signer: AbstractSigner, agentId: number, key: string, value: Uint8Array): Promise<string> {
    return this._execWrite(signer, IDENTITY_REGISTRY_ABI, 'setMetadata', agentId, key, value);
  }

  async setAgentURI(signer: AbstractSigner, agentId: number, uri: string): Promise<string> {
    return this._execWrite(signer, IDENTITY_REGISTRY_ABI, 'setAgentURI', agentId, uri);
  }

  // ── View methods ───────────────────────────────────────────────────

  async isRegistered(address: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, this._provider);
    const balance = await contract.getFunction('balanceOf')(address);
    return Number(balance) > 0;
  }

  /**
   * The agent IDs `owner` currently holds. The registry is not enumerable, so
   * this scans `Transfer(*, owner, agentId)` logs (mints and transfers in)
   * newest first, in bounded windows (shrunk when the RPC rejects one), down
   * to the deploy block (else a bounded lookback), and
   * keeps the IDs `ownerOf` still assigns to `owner`. It stops once it has
   * found as many as `balanceOf(owner)`. Returned in ascending order.
   */
  async findOwnedAgentIds(owner: string, options: FindOwnedAgentIdsOptions = {}): Promise<number[]> {
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, this._provider);
    const expected = Number(await contract.getFunction('balanceOf')(owner));
    if (expected === 0) return [];

    const head = await this._provider.getBlockNumber();
    const floor = options.fromBlock ?? this._deployBlock
      ?? Math.max(0, head - (options.maxLookbackBlocks ?? DEFAULT_AGENT_LOOKBACK_BLOCKS));
    let chunkBlocks = options.chunkBlocks ?? DEFAULT_AGENT_LOG_CHUNK_BLOCKS;
    if (!Number.isSafeInteger(chunkBlocks) || chunkBlocks < 1) {
      throw new Error(`chunkBlocks must be a positive integer, got ${chunkBlocks}`);
    }
    const ownerTopic = zeroPadValue(owner, 32);
    const seen = new Set<bigint>();
    const owned: number[] = [];

    let end = head;
    while (end >= floor && owned.length < expected) {
      const start = Math.max(floor, end - chunkBlocks + 1);
      let logs: Log[];
      try {
        logs = await this._provider.getLogs({
          address: this._contractAddress,
          topics: [TRANSFER_TOPIC, null, ownerTopic],
          fromBlock: start,
          toBlock: end,
        });
      } catch (err) {
        // Most likely the RPC's block-range cap: retry this window smaller.
        if (chunkBlocks <= MIN_AGENT_LOG_CHUNK_BLOCKS) throw err;
        chunkBlocks = Math.max(MIN_AGENT_LOG_CHUNK_BLOCKS, Math.floor(chunkBlocks / 10));
        continue;
      }
      for (const log of [...logs].reverse()) {
        const rawId = log.topics[3];
        if (!rawId) continue;
        const agentId = BigInt(rawId);
        if (seen.has(agentId)) continue;
        seen.add(agentId);
        if (await this._isOwnedBy(contract, agentId, owner)) owned.push(Number(agentId));
      }
      options.onProgress?.(start, floor);
      end = start - 1;
    }
    return owned.sort((a, b) => a - b);
  }

  private async _isOwnedBy(contract: Contract, agentId: bigint, owner: string): Promise<boolean> {
    try {
      const current = await contract.getFunction('ownerOf')(agentId) as string;
      return current.toLowerCase() === owner.toLowerCase();
    } catch (err) {
      if (isError(err, 'CALL_EXCEPTION')) return false; // burned
      throw err;
    }
  }

  async getAgentWallet(agentId: number): Promise<string> {
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, this._provider);
    return contract.getFunction('ownerOf')(agentId) as Promise<string>;
  }

  async getMetadata(agentId: number, key: string): Promise<Uint8Array> {
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, this._provider);
    const result = await contract.getFunction('getMetadata')(agentId, key);
    return new Uint8Array(Buffer.from(result.slice(2), 'hex'));
  }

}
