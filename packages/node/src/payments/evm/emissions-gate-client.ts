import { Contract, keccak256, toUtf8Bytes } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface EmissionsGateClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }

export interface GateMinter { controller: string; shareBps: number; editable: boolean; }

/** Gate minter ids are `keccak256(id string)`. These are the M001 buckets. */
export const GATE_MINTERS = [
  { name: 'seller-pools', id: 'antseed.emissions.seller-pools.v1' },
  { name: 'usage', id: 'antseed.emissions.usage.v1' },
  { name: 'team', id: 'antseed.emissions.team.v1' },
  { name: 'reserve', id: 'antseed.emissions.reserve.v1' },
  { name: 'verification', id: 'antseed.emissions.verification.v1' },
] as const;

export function gateMinterId(id: string): string {
  return keccak256(toUtf8Bytes(id));
}

const ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function effectiveEpoch() external view returns (uint256)',
  'function currentEmissionRate() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
  'function genesis() external view returns (uint256)',
  'function HALVING_INTERVAL() external view returns (uint256)',
  'function INITIAL_EMISSION() external view returns (uint256)',
  'function SHARE_DENOMINATOR() external view returns (uint256)',
  'function getEpochEmission(uint256 epoch) external view returns (uint256)',
  'function cumulativeEmissionThrough(uint256 epochExclusive) external view returns (uint256)',
  'function minters(bytes32 minterId) external view returns (address controller, uint32 shareBps, bool editable)',
  'function minterEpochBudget(bytes32 minterId, uint256 epoch) external view returns (uint256)',
  'function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256)',
  'function emissionsReserve() external view returns (address)',
  'function legacyEscrow() external view returns (address)',
  'function owner() external view returns (address)',
] as const;

export class EmissionsGateClient extends BaseEvmClient {
  constructor(config: EmissionsGateClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }

  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async effectiveEpoch(): Promise<number> { return Number(await this.contract().getFunction('effectiveEpoch')()); }
  currentEmissionRate(): Promise<bigint> { return this.contract().getFunction('currentEmissionRate')(); }
  async epochDuration(): Promise<number> { return Number(await this.contract().getFunction('epochDuration')()); }
  async genesis(): Promise<number> { return Number(await this.contract().getFunction('genesis')()); }
  async halvingInterval(): Promise<number> { return Number(await this.contract().getFunction('HALVING_INTERVAL')()); }
  initialEmission(): Promise<bigint> { return this.contract().getFunction('INITIAL_EMISSION')(); }
  async shareDenominator(): Promise<number> { return Number(await this.contract().getFunction('SHARE_DENOMINATOR')()); }
  getEpochEmission(epoch: number): Promise<bigint> { return this.contract().getFunction('getEpochEmission')(epoch); }
  cumulativeEmissionThrough(epochExclusive: number): Promise<bigint> { return this.contract().getFunction('cumulativeEmissionThrough')(epochExclusive); }
  async minter(minterId: string): Promise<GateMinter> {
    const [controller, shareBps, editable] = await this.contract().getFunction('minters')(minterId) as [string, bigint, boolean];
    return { controller, shareBps: Number(shareBps), editable };
  }
  minterEpochBudget(minterId: string, epoch: number): Promise<bigint> { return this.contract().getFunction('minterEpochBudget')(minterId, epoch); }
  controllerEpochBudget(controller: string, epoch: number): Promise<bigint> { return this.contract().getFunction('controllerEpochBudget')(controller, epoch); }
  emissionsReserve(): Promise<string> { return this.contract().getFunction('emissionsReserve')(); }
  legacyEscrow(): Promise<string> { return this.contract().getFunction('legacyEscrow')(); }
  owner(): Promise<string> { return this.contract().getFunction('owner')(); }
}
