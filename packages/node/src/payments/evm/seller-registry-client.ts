import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerRegistryClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'event SellerRegistered(address indexed seller, uint256 indexed agentId)',
  'function owner() external view returns (address)',
  'function sellerPools() external view returns (address)',
  'function legacyStaking() external view returns (address)',
  'function agentSeller(uint256 agentId) external view returns (address)',
  'function registerSeller(uint256 agentId) external',
  'function getAgentId(address seller) external view returns (uint256)',
  'function getStake(address seller) external view returns (uint256)',
  'function isStakedAboveMin(address seller) external view returns (bool)',
  'function minSellerPoolStake() external view returns (uint256)',
  'function legacyStakeEligibilityEnabled() external view returns (bool)',
] as const;
export class SellerRegistryClient extends BaseEvmClient {
  constructor(config: SellerRegistryClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }
  registerSeller(signer: AbstractSigner, agentId: number): Promise<string> { return this._execWrite(signer, ABI, 'registerSeller', agentId); }
  async getAgentId(seller: string): Promise<number> { return Number(await this.contract().getFunction('getAgentId')(seller)); }
  getStake(seller: string): Promise<bigint> { return this.contract().getFunction('getStake')(seller); }
  isStakedAboveMin(seller: string): Promise<boolean> { return this.contract().getFunction('isStakedAboveMin')(seller); }
  minSellerPoolStake(): Promise<bigint> { return this.contract().getFunction('minSellerPoolStake')(); }
  legacyStakeEligibilityEnabled(): Promise<boolean> { return this.contract().getFunction('legacyStakeEligibilityEnabled')(); }
  async isRegisteredSeller(seller: string, agentId: number): Promise<boolean> {
    if (!agentId) return false;
    const registry = this.contract();
    const [resolvedId, boundSeller] = await Promise.all([this.getAgentId(seller), registry.getFunction('agentSeller')(agentId)]);
    return resolvedId === agentId && boundSeller.toLowerCase() === seller.toLowerCase();
  }

  async getRegisteredAgentId(seller: string): Promise<number> {
    const agentId = await this.getAgentId(seller);
    return await this.isRegisteredSeller(seller, agentId) ? agentId : 0;
  }

  async registerSellerBinding(signer: AbstractSigner, agentId: number, confirmed: (hash: string) => void | Promise<void> = () => {}): Promise<boolean> {
    const address = await signer.getAddress();
    const boundAgentId = await this.getAgentId(address);
    if (boundAgentId !== 0 && boundAgentId !== agentId) {
      throw new Error(`Seller is already bound to agent ${boundAgentId}, not ${agentId}.`);
    }
    if (await this.isRegisteredSeller(address, agentId)) return false;
    await confirmed(await this.registerSeller(signer, agentId));
    if (!await this.isRegisteredSeller(address, agentId)) {
      throw new SellerRegistrationVerificationError();
    }
    return true;
  }
  agentSeller(agentId: number): Promise<string> { return this.contract().getFunction('agentSeller')(agentId); }
  sellerPools(): Promise<string> { return this.contract().getFunction('sellerPools')(); }
  legacyStaking(): Promise<string> { return this.contract().getFunction('legacyStaking')(); }
}

export class SellerRegistrationVerificationError extends Error {
  constructor() {
    super('Registration could not be verified.');
    this.name = 'SellerRegistrationVerificationError';
  }
}
