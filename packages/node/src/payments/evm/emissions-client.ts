import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface EmissionsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const EMISSIONS_ABI = [
  // Writes
  'function claimSellerEmissions(uint256[] epochs) external',
  'function claimBuyerEmissions(address buyer, uint256[] epochs) external',
  'function flushReserve() external',
  'function setChannelsContract(address _sessions) external',
  'function setReserveDestination(address _dest) external',
  'function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external',
  'function transferOwnership(address newOwner) external',
  // Reads — scalars
  'function pendingEmissions(address account, uint256[] epochs) external view returns (uint256 seller, uint256 buyer)',
  'function currentEpoch() external view returns (uint256)',
  'function currentEmissionRate() external view returns (uint256)',
  'function getEpochEmission(uint256 epoch) external view returns (uint256)',
  'function genesis() external view returns (uint256)',
  'function EPOCH_DURATION() external view returns (uint256)',
  'function INITIAL_EMISSION() external view returns (uint256)',
  'function HALVING_INTERVAL() external view returns (uint256)',
  'function MIGRATION_EPOCH() external view returns (uint256)',
  'function SELLER_SHARE_PCT() external view returns (uint256)',
  'function BUYER_SHARE_PCT() external view returns (uint256)',
  'function RESERVE_SHARE_PCT() external view returns (uint256)',
  'function TEAM_SHARE_PCT() external view returns (uint256)',
  'function MAX_SELLER_SHARE_PCT() external view returns (uint256)',
  'function MAX_BUYER_SHARE_PCT() external view returns (uint256)',
  'function reserveAccumulated() external view returns (uint256)',
  'function sellerRewardsPool() external view returns (address)',
  'function sellerUnlockPolicy() external view returns (address)',
  'function teamAccumulated() external view returns (uint256)',
  'function paused() external view returns (bool)',
  // Reads — mappings exposed as auto-generated getters
  'function epochParams(uint256 epoch) external view returns (uint256 sellerSharePct, uint256 buyerSharePct, uint256 reserveSharePct, uint256 teamSharePct, uint256 maxSellerSharePct, uint256 maxBuyerSharePct, bool initialized)',
  'function epochTotalSellerPoints(uint256 epoch) external view returns (uint256)',
  'function epochTotalBuyerPoints(uint256 epoch) external view returns (uint256)',
  'function userSellerPoints(address account, uint256 epoch) external view returns (uint256)',
  'function userBuyerPoints(address account, uint256 epoch) external view returns (uint256)',
  'function sellerEpochClaimed(address account, uint256 epoch) external view returns (bool)',
  'function buyerEpochClaimed(address account, uint256 epoch) external view returns (bool)',
] as const;

const LEGACY_EPOCH_PARAMS_ABI = [
  'function epochParams(uint256 epoch) external view returns (uint256 sellerSharePct, uint256 buyerSharePct, uint256 reserveSharePct, uint256 teamSharePct, uint256 maxSellerSharePct, bool initialized)',
] as const;

export interface EmissionsEpochParams {
  sellerSharePct: number;
  buyerSharePct: number;
  reserveSharePct: number;
  teamSharePct: number;
  maxSellerSharePct: number;
  maxBuyerSharePct: number;
  initialized: boolean;
}

export class EmissionsClient extends BaseEvmClient {
  constructor(config: EmissionsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  async claimSellerEmissions(signer: AbstractSigner, epochs: number[]): Promise<string> {
    return this._execWrite(signer, EMISSIONS_ABI, 'claimSellerEmissions', epochs);
  }

  async claimBuyerEmissions(signer: AbstractSigner, buyer: string, epochs: number[]): Promise<string> {
    return this._execWrite(signer, EMISSIONS_ABI, 'claimBuyerEmissions', buyer, epochs);
  }

  async pendingEmissions(address: string, epochs: number[]): Promise<{ seller: bigint; buyer: bigint }> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const [seller, buyer] = await contract.getFunction('pendingEmissions')(address, epochs);
    return { seller, buyer };
  }

  async getEpochInfo(): Promise<{ epoch: number; emission: bigint; epochDuration: number }> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const [epoch, emission, duration] = await Promise.all([
      contract.getFunction('currentEpoch')(),
      contract.getFunction('currentEmissionRate')(),
      contract.getFunction('EPOCH_DURATION')(),
    ]);
    return {
      epoch: Number(epoch),
      emission: BigInt(emission),
      epochDuration: Number(duration),
    };
  }

  async getEpochEmission(epoch: number): Promise<bigint> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('getEpochEmission')(epoch);
  }

  async getGenesis(): Promise<number> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const v = await contract.getFunction('genesis')();
    return Number(v);
  }

  async getHalvingInterval(): Promise<number> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const v = await contract.getFunction('HALVING_INTERVAL')();
    return Number(v);
  }

  async getMigrationEpoch(): Promise<number> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const v = await contract.getFunction('MIGRATION_EPOCH')();
    return Number(v);
  }

  async getShares(): Promise<EmissionsEpochParams> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const [seller, buyer, reserve, team, maxSeller, maxBuyer] = await Promise.all([
      contract.getFunction('SELLER_SHARE_PCT')(),
      contract.getFunction('BUYER_SHARE_PCT')(),
      contract.getFunction('RESERVE_SHARE_PCT')(),
      contract.getFunction('TEAM_SHARE_PCT')(),
      contract.getFunction('MAX_SELLER_SHARE_PCT')(),
      contract.getFunction('MAX_BUYER_SHARE_PCT')().catch(() => 100n),
    ]);
    return {
      sellerSharePct: Number(seller),
      buyerSharePct: Number(buyer),
      reserveSharePct: Number(reserve),
      teamSharePct: Number(team),
      maxSellerSharePct: Number(maxSeller),
      maxBuyerSharePct: Number(maxBuyer),
      initialized: true,
    };
  }

  async getEpochParams(epoch: number): Promise<EmissionsEpochParams> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    try {
      const [seller, buyer, reserve, team, maxSeller, maxBuyer, initialized] = await contract.getFunction('epochParams')(epoch);
      return {
        sellerSharePct: Number(seller),
        buyerSharePct: Number(buyer),
        reserveSharePct: Number(reserve),
        teamSharePct: Number(team),
        maxSellerSharePct: Number(maxSeller),
        maxBuyerSharePct: Number(maxBuyer),
        initialized,
      };
    } catch {
      const legacyContract = new Contract(this._contractAddress, LEGACY_EPOCH_PARAMS_ABI, this._provider);
      const [seller, buyer, reserve, team, maxSeller, initialized] = await legacyContract.getFunction('epochParams')(epoch);
      return {
        sellerSharePct: Number(seller),
        buyerSharePct: Number(buyer),
        reserveSharePct: Number(reserve),
        teamSharePct: Number(team),
        maxSellerSharePct: Number(maxSeller),
        maxBuyerSharePct: 100,
        initialized,
      };
    }
  }

  async epochTotalSellerPoints(epoch: number): Promise<bigint> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('epochTotalSellerPoints')(epoch);
  }

  async epochTotalBuyerPoints(epoch: number): Promise<bigint> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('epochTotalBuyerPoints')(epoch);
  }

  async userSellerPoints(account: string, epoch: number): Promise<bigint> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('userSellerPoints')(account, epoch);
  }

  async userBuyerPoints(account: string, epoch: number): Promise<bigint> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('userBuyerPoints')(account, epoch);
  }

  async sellerEpochClaimed(account: string, epoch: number): Promise<boolean> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('sellerEpochClaimed')(account, epoch);
  }

  async buyerEpochClaimed(account: string, epoch: number): Promise<boolean> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('buyerEpochClaimed')(account, epoch);
  }

  async flushReserve(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('flushReserve')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  /** Legacy locked-rewards pool address (zero when the V2 contract has none configured). */
  async sellerRewardsPool(): Promise<string> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('sellerRewardsPool')();
  }

  async sellerUnlockPolicy(): Promise<string> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    return contract.getFunction('sellerUnlockPolicy')();
  }
}
