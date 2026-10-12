import { Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface PointsPolicyRegistryClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }

const ABI = [
  'function policyCount() external view returns (uint256)',
  'function policyAt(uint256 index) external view returns (address)',
  'function isPolicyRegistered(address policy) external view returns (bool)',
  'function MAX_POLICIES() external view returns (uint256)',
  'function owner() external view returns (address)',
] as const;

const WASH_POLICY_ABI = ['function washTradingRegistry() external view returns (address)'] as const;

export class PointsPolicyRegistryClient extends BaseEvmClient {
  constructor(config: PointsPolicyRegistryClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }

  async policyCount(): Promise<number> { return Number(await this.contract().getFunction('policyCount')()); }
  policyAt(index: number): Promise<string> { return this.contract().getFunction('policyAt')(index); }
  isPolicyRegistered(policy: string): Promise<boolean> { return this.contract().getFunction('isPolicyRegistered')(policy); }
  async maxPolicies(): Promise<number> { return Number(await this.contract().getFunction('MAX_POLICIES')()); }
  owner(): Promise<string> { return this.contract().getFunction('owner')(); }
  /** Registered modifiers in evaluation order. */
  async policies(): Promise<string[]> {
    const count = await this.policyCount();
    return Promise.all(Array.from({ length: count }, (_, index) => this.policyAt(index)));
  }
  /** The wash-trading registry a policy pins, or null when the policy has no such pointer. */
  async washTradingRegistryOf(policy: string): Promise<string | null> {
    try {
      return await new Contract(policy, WASH_POLICY_ABI, this._provider).getFunction('washTradingRegistry')() as string;
    } catch {
      return null;
    }
  }
}
