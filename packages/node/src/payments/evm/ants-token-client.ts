import { Contract, Interface, zeroPadValue, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ANTSTokenClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const ANTS_TOKEN_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function transfersEnabled() external view returns (bool)',
  'function transferWhitelist(address account) external view returns (bool)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function MAX_SUPPLY() external view returns (uint256)',
  'function owner() external view returns (address)',
  'function setRegistry(address _registry) external',
  'function enableTransfers() external',
  'function transferOwnership(address newOwner) external',
] as const;

export class ANTSTokenClient extends BaseEvmClient {
  constructor(config: ANTSTokenClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  async balanceOf(address: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('balanceOf')(address);
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('allowance')(owner, spender);
  }

  async totalSupply(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('totalSupply')();
  }

  async transfersEnabled(): Promise<boolean> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('transfersEnabled')();
  }

  async setRegistry(signer: AbstractSigner, registryAddress: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('setRegistry')(registryAddress, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async enableTransfers(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('enableTransfers')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async transferOwnership(signer: AbstractSigner, newOwner: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('transferOwnership')(newOwner, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }
  async receivedInTransaction(transactionHash: string, recipient: string): Promise<bigint> {
    const receipt = await this.provider.getTransactionReceipt(transactionHash);
    if (!receipt || receipt.status !== 1) throw new Error(`Confirmed receipt unavailable: ${transactionHash}`);
    const tokenInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    const topics = tokenInterface.encodeFilterTopics('Transfer', [null, recipient]);
    return receipt.logs.reduce((received, log) => {
      if (log.address.toLowerCase() !== this.contractAddress.toLowerCase() || log.topics[0] !== topics[0] || log.topics[2]?.toLowerCase() !== zeroPadValue(recipient, 32).toLowerCase()) return received;
      return received + (tokenInterface.parseLog(log)!.args.value as bigint);
    }, 0n);
  }

  async transferWhitelist(account: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('transferWhitelist')(account);
  }

  async maxSupply(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('MAX_SUPPLY')();
  }

  /** Whether `account` can move ANTS right now (transfers enabled globally or the account is whitelisted). */
  async canTransfer(account: string): Promise<boolean> {
    const [enabled, whitelisted] = await Promise.all([this.transfersEnabled(), this.transferWhitelist(account)]);
    return enabled || whitelisted;
  }

  approve(signer: AbstractSigner, spender: string, amount: bigint): Promise<string> {
    return this._execWrite(signer, ANTS_TOKEN_ABI, 'approve', spender, amount);
  }
}
