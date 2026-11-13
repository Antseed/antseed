import { Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface RegistryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

const REGISTRY_ABI = [
  'function emissions() external view returns (address)',
  'function staking() external view returns (address)',
  'function channels() external view returns (address)',
  'function deposits() external view returns (address)',
  'function antsToken() external view returns (address)',
] as const;

export class RegistryClient extends BaseEvmClient {
  constructor(config: RegistryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private async _address(method: string): Promise<string> {
    const contract = new Contract(this._contractAddress, REGISTRY_ABI, this._provider);
    return contract.getFunction(method)() as Promise<string>;
  }

  emissions(): Promise<string> { return this._address('emissions'); }
  staking(): Promise<string> { return this._address('staking'); }
  channels(): Promise<string> { return this._address('channels'); }
  deposits(): Promise<string> { return this._address('deposits'); }
  antsToken(): Promise<string> { return this._address('antsToken'); }
}
