import { Contract, id as keccak256, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface IdentityClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

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
  constructor(config: IdentityClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  // ── Write methods ──────────────────────────────────────────────────

  /**
   * Register a new agent identity via ERC-8004 IdentityRegistry.
   * Returns the new agentId. The peerId is the signer's EVM address
   * (ownerOf(agentId)), so no separate metadata storage is needed.
   */
  async register(signer: AbstractSigner, metadataURI?: string): Promise<number> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_REGISTRY_ABI, connected);

    let tx: { wait(): Promise<{ hash: string; logs: Array<{ topics: string[]; data: string }> } | null> };
    if (metadataURI) {
      tx = await this._sendWithNonce(signerAddress, (nonce) => contract.getFunction('register(string)')(metadataURI, { nonce }));
    } else {
      tx = await this._sendWithNonce(signerAddress, (nonce) => contract.getFunction('register()')({ nonce }));
    }
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');

    // Extract agentId from Transfer event (ERC-721 Transfer(address,address,uint256))
    const transferLog = receipt.logs.find((l) => l.topics?.[0] === keccak256('Transfer(address,address,uint256)'));
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
