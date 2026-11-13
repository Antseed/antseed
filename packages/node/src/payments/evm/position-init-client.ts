import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
export interface PositionInitClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }
const ABI = [
  'function initPosition() external returns (uint256 positionId)',
  'function remainingInits() external view returns (uint256)',
  'function agentInitialized(uint256 agentId) external view returns (bool)',
  'function initAmount() external view returns (uint256)',
  'function initEndEpoch() external view returns (uint256)',
] as const;
export class PositionInitClient extends BaseEvmClient {
  constructor(config: PositionInitClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }
  initPosition(signer: AbstractSigner): Promise<string> { return this._execWrite(signer, ABI, 'initPosition'); }
  remainingInits(): Promise<bigint> { return this.contract().getFunction('remainingInits')(); }
  agentInitialized(agentId: number): Promise<boolean> { return this.contract().getFunction('agentInitialized')(agentId); }
  initAmount(): Promise<bigint> { return this.contract().getFunction('initAmount')(); }
  async initEndEpoch(): Promise<number> { return Number(await this.contract().getFunction('initEndEpoch')()); }
}
