import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient, ERC20_ABI } from './base-evm-client.js';

export interface DepositsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  usdcAddress: string;
  evmChainId?: number;
}

export interface BuyerBalanceInfo {
  available: bigint;
  reserved: bigint;
  lastActivityAt: bigint;
}

const DEPOSITS_ABI = [
  'function deposit(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function MIN_BUYER_DEPOSIT() external view returns (uint256)',
  'function uniqueSellersCharged(address buyer) external view returns (uint256)',
  'function getOperator(address buyer) external view returns (address)',
  'function getOperatorNonce(address buyer) external view returns (uint256)',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
  'function domainSeparator() external view returns (bytes32)',
] as const;

export class DepositsClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: DepositsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._usdcAddress = config.usdcAddress;
  }

  get usdcAddress(): string { return this._usdcAddress; }

  // ─── Buyer Operations ──────────────────────────────────────────────

  async deposit(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._approveAndExec(signer, this._usdcAddress, amount, DEPOSITS_ABI, 'deposit', buyer, amount);
  }

  async withdraw(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'withdraw', buyer, amount);
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getBuyerBalance(buyerAddr: string): Promise<BuyerBalanceInfo> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    const result = await contract.getFunction('getBuyerBalance')(buyerAddr);
    return {
      available: result[0] as bigint,
      reserved: result[1] as bigint,
      lastActivityAt: result[2] as bigint,
    };
  }

  async getBuyerCreditLimit(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getBuyerCreditLimit')(buyerAddr) as Promise<bigint>;
  }

  /** Smallest first deposit the contract accepts for a buyer with no balance (base units). */
  async getMinBuyerDeposit(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('MIN_BUYER_DEPOSIT')() as Promise<bigint>;
  }

  // ─── Operator Management ─────────────────────────────────────────

  async getOperator(buyerAddr: string): Promise<string> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getOperator')(buyerAddr) as Promise<string>;
  }

  /** Distinct sellers that have charged this buyer; nonzero once it has paid for usage. */
  async getUniqueSellersCharged(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('uniqueSellersCharged')(buyerAddr) as Promise<bigint>;
  }

  async getOperatorNonce(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getOperatorNonce')(buyerAddr) as Promise<bigint>;
  }

  async setOperator(signer: AbstractSigner, buyer: string, operator: string, nonce: bigint, buyerSig: string): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'setOperator', buyer, operator, nonce, buyerSig);
  }

  async transferOperator(signer: AbstractSigner, buyer: string, newOperator: string): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'transferOperator', buyer, newOperator);
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  // ─── USDC Balance ───────────────────────────────────────────────

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}
