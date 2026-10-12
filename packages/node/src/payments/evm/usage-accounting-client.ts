import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface UsageAccountingClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface UsagePoints { points: bigint; weightedPoints: bigint; }
export interface UsageTotals { buyers: UsagePoints; sellers: UsagePoints; }

const USAGE_ACCOUNTING_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function firstRewardedEpoch() external view returns (uint256)',
  'function pendingEmissions(address account, uint256[] epochs) external view returns (uint256 seller, uint256 buyer)',
  'function claimSellerEmissions(uint256[] epochs) external',
  'function sellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256)',
  'function buyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256)',
  'function sellerAgentIdByEpoch(uint256 epoch, address seller) external view returns (uint256)',
  'function totalUsage() external view returns (tuple(tuple(uint256 points, uint256 weightedPoints) buyers, tuple(uint256 points, uint256 weightedPoints) sellers))',
  'function epochUsage(uint256 epoch) external view returns (tuple(tuple(uint256 points, uint256 weightedPoints) buyers, tuple(uint256 points, uint256 weightedPoints) sellers))',
  'function buyerUsageTotal(address buyer) external view returns (tuple(uint256 points, uint256 weightedPoints))',
  'function buyerEpochUsage(uint256 epoch, address buyer) external view returns (tuple(uint256 points, uint256 weightedPoints))',
  'function agentEpochUsage(uint256 epoch, uint256 agentId) external view returns (tuple(uint256 points, uint256 weightedPoints))',
  'function totalBuyerPointsByEpoch(uint256 epoch) external view returns (uint256)',
  'function totalSellerPointsByEpoch(uint256 epoch) external view returns (uint256)',
  'function totalPoolPointsByEpoch(uint256 epoch) external view returns (uint256)',
  'function totalWeightedPoolPointsByEpoch(uint256 epoch) external view returns (uint256)',
  'function totalWeightedBuyerPointsByEpoch(uint256 epoch) external view returns (uint256)',
  'function agentPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256)',
  'function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256)',
  'function weightedBuyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256)',
  'function pointsPolicy() external view returns (address)',
  'function poolWeightPolicy() external view returns (address)',
  'function minimumAccountedPoolPower() external view returns (uint256)',
  'function sellerPools() external view returns (address)',
  'function usageRewards() external view returns (address)',
] as const;

function toPoints(result: { points?: bigint; 0?: bigint; 1?: bigint }): UsagePoints {
  const tuple = result as unknown as [bigint, bigint];
  return { points: tuple[0], weightedPoints: tuple[1] };
}

export class UsageAccountingClient extends BaseEvmClient {
  constructor(config: UsageAccountingClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }
  private contract(): Contract { return new Contract(this._contractAddress, USAGE_ACCOUNTING_ABI, this._provider); }

  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async firstRewardedEpoch(): Promise<number> { return Number(await this.contract().getFunction('firstRewardedEpoch')()); }
  async pendingEmissions(account: string, epochs: number[]): Promise<{ seller: bigint; buyer: bigint }> {
    const [seller, buyer] = await this.contract().getFunction('pendingEmissions')(account, epochs) as [bigint, bigint];
    return { seller, buyer };
  }
  claimSellerEmissions(signer: AbstractSigner, epochs: number[]): Promise<string> {
    return this._execWrite(signer, USAGE_ACCOUNTING_ABI, 'claimSellerEmissions', epochs);
  }
  sellerPointsByEpoch(epoch: number, seller: string): Promise<bigint> {
    return this.contract().getFunction('sellerPointsByEpoch')(epoch, seller);
  }
  buyerPointsByEpoch(epoch: number, buyer: string): Promise<bigint> {
    return this.contract().getFunction('buyerPointsByEpoch')(epoch, buyer);
  }
  async sellerAgentIdByEpoch(epoch: number, seller: string): Promise<number> {
    return Number(await this.contract().getFunction('sellerAgentIdByEpoch')(epoch, seller));
  }
  async totalUsage(): Promise<UsageTotals> {
    const result = await this.contract().getFunction('totalUsage')();
    return { buyers: toPoints(result[0]), sellers: toPoints(result[1]) };
  }
  async epochUsage(epoch: number): Promise<UsageTotals> {
    const result = await this.contract().getFunction('epochUsage')(epoch);
    return { buyers: toPoints(result[0]), sellers: toPoints(result[1]) };
  }
  async buyerUsageTotal(buyer: string): Promise<UsagePoints> { return toPoints(await this.contract().getFunction('buyerUsageTotal')(buyer)); }
  async buyerEpochUsage(epoch: number, buyer: string): Promise<UsagePoints> { return toPoints(await this.contract().getFunction('buyerEpochUsage')(epoch, buyer)); }
  async agentEpochUsage(epoch: number, agentId: number): Promise<UsagePoints> { return toPoints(await this.contract().getFunction('agentEpochUsage')(epoch, agentId)); }
  totalBuyerPointsByEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalBuyerPointsByEpoch')(epoch); }
  totalSellerPointsByEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalSellerPointsByEpoch')(epoch); }
  totalPoolPointsByEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalPoolPointsByEpoch')(epoch); }
  totalWeightedPoolPointsByEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalWeightedPoolPointsByEpoch')(epoch); }
  totalWeightedBuyerPointsByEpoch(epoch: number): Promise<bigint> { return this.contract().getFunction('totalWeightedBuyerPointsByEpoch')(epoch); }
  agentPoolPointsByEpoch(epoch: number, agentId: number): Promise<bigint> { return this.contract().getFunction('agentPoolPointsByEpoch')(epoch, agentId); }
  weightedPoolPointsByEpoch(epoch: number, agentId: number): Promise<bigint> { return this.contract().getFunction('weightedPoolPointsByEpoch(uint256,uint256)')(epoch, agentId); }
  weightedBuyerPointsByEpoch(epoch: number, buyer: string): Promise<bigint> { return this.contract().getFunction('weightedBuyerPointsByEpoch')(epoch, buyer); }
  pointsPolicy(): Promise<string> { return this.contract().getFunction('pointsPolicy')(); }
  poolWeightPolicy(): Promise<string> { return this.contract().getFunction('poolWeightPolicy')(); }
  minimumAccountedPoolPower(): Promise<bigint> { return this.contract().getFunction('minimumAccountedPoolPower')(); }
  sellerPools(): Promise<string> { return this.contract().getFunction('sellerPools')(); }
  usageRewards(): Promise<string> { return this.contract().getFunction('usageRewards')(); }
}
