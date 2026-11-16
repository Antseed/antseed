import type { ChainConfig } from './chain-config.js';
import { EmissionsClient } from './evm/emissions-client.js';
import { RegistryClient } from './evm/registry-client.js';
import { UsageAccountingClient } from './evm/usage-accounting-client.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type ContractStackMode = 'legacy' | 'recognized-usage';

export interface ContractStackAddresses {
  registryContractAddress: string;
  emissionsContractAddress?: string;
  stakingContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  usageAccountingAddress?: string;
  sellerRegistryAddress?: string;
  channelsContractAddress: string;
  depositsContractAddress: string;
  antsTokenAddress?: string;
}

export interface ContractStackResolution {
  mode: ContractStackMode;
  currentEpoch: number;
  firstRewardedEpoch?: number;
  addresses: ContractStackAddresses;
  registryPointers: { emissions: string; staking: string };
}

interface RegistryReader {
  emissions(): Promise<string>;
  staking(): Promise<string>;
}

interface EpochReader { currentEpoch(): Promise<number>; }
interface UsageEpochReader extends EpochReader { firstRewardedEpoch(): Promise<number>; }

export interface ContractStackRpcOptions {
  registryClient?: RegistryReader;
  legacyEmissionsClient?: { getEpochInfo(): Promise<{ epoch: number }> };
  usageAccountingClient?: UsageEpochReader;
}

export class ContractStackMismatchError extends Error {
  constructor(message: string) {
    super(`Contract stack mismatch: ${message}. Upgrade @antseed/cli or check payments.crypto overrides.`);
    this.name = 'ContractStackMismatchError';
  }
}

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function isZero(address: string | undefined): boolean {
  return !address || sameAddress(address, ZERO_ADDRESS);
}

export function resolveLegacyContractAddresses(config: Pick<ChainConfig,
  'emissionsContractAddress' | 'stakingContractAddress' | 'usageAccountingAddress' | 'sellerRegistryAddress' |
  'legacyEmissionsContractAddress' | 'legacyStakingContractAddress' | 'legacyEmissionsV1ContractAddress'
>): Pick<ContractStackAddresses, 'legacyEmissionsContractAddress' | 'legacyStakingContractAddress' | 'legacyEmissionsV1ContractAddress'> {
  const emissionsIsLegacy = !!config.emissionsContractAddress && !sameAddress(config.emissionsContractAddress, config.usageAccountingAddress);
  const stakingIsLegacy = !!config.stakingContractAddress && !sameAddress(config.stakingContractAddress, config.sellerRegistryAddress);
  return {
    legacyEmissionsContractAddress: emissionsIsLegacy ? config.emissionsContractAddress : config.legacyEmissionsContractAddress,
    legacyStakingContractAddress: stakingIsLegacy ? config.stakingContractAddress : config.legacyStakingContractAddress,
    legacyEmissionsV1ContractAddress: emissionsIsLegacy ? config.legacyEmissionsContractAddress : config.legacyEmissionsV1ContractAddress,
  };
}

export function legacyEpochs(currentEpoch: number, firstRewardedEpoch: number): number[] {
  return Array.from({ length: Math.max(0, Math.min(currentEpoch, firstRewardedEpoch)) }, (_, epoch) => epoch);
}

export function newEpochs(currentEpoch: number, firstRewardedEpoch: number): number[] {
  const start = Math.max(0, firstRewardedEpoch);
  return Array.from({ length: Math.max(0, currentEpoch - start) }, (_, index) => start + index);
}

export async function resolveContractStack(
  chainConfig: ChainConfig,
  rpcOptions: ContractStackRpcOptions = {},
): Promise<ContractStackResolution> {
  const registryAddress = chainConfig.registryContractAddress;
  if (!registryAddress) {
    throw new ContractStackMismatchError(`registry address not configured for chain '${chainConfig.chainId}'`);
  }

  const addresses: ContractStackAddresses = {
    registryContractAddress: registryAddress,
    emissionsContractAddress: chainConfig.emissionsContractAddress,
    stakingContractAddress: chainConfig.stakingContractAddress,
    legacyEmissionsContractAddress: chainConfig.legacyEmissionsContractAddress,
    legacyStakingContractAddress: chainConfig.legacyStakingContractAddress,
    usageAccountingAddress: chainConfig.usageAccountingAddress,
    sellerRegistryAddress: chainConfig.sellerRegistryAddress,
    channelsContractAddress: chainConfig.channelsContractAddress,
    depositsContractAddress: chainConfig.depositsContractAddress,
    antsTokenAddress: chainConfig.antsTokenAddress,
  };

  try {
    const registry = rpcOptions.registryClient ?? new RegistryClient({
      rpcUrl: chainConfig.rpcUrl,
      fallbackRpcUrls: chainConfig.fallbackRpcUrls,
      contractAddress: registryAddress,
      evmChainId: chainConfig.evmChainId,
    });
    const [registryEmissions, registryStaking] = await Promise.all([registry.emissions(), registry.staking()]);
    const registryPointers = { emissions: registryEmissions, staking: registryStaking };
    if (isZero(registryEmissions) || isZero(registryStaking)) {
      throw new ContractStackMismatchError(`registry returned zero pointer(s): emissions=${registryEmissions}, staking=${registryStaking}`);
    }

    const recognizedConfigured = !!chainConfig.usageAccountingAddress || !!chainConfig.sellerRegistryAddress;
    const recognizedMatch = sameAddress(registryEmissions, chainConfig.usageAccountingAddress)
      && sameAddress(registryStaking, chainConfig.sellerRegistryAddress);
    if (recognizedConfigured && recognizedMatch) {
      const usage = rpcOptions.usageAccountingClient ?? new UsageAccountingClient({
        rpcUrl: chainConfig.rpcUrl,
        fallbackRpcUrls: chainConfig.fallbackRpcUrls,
        contractAddress: chainConfig.usageAccountingAddress!,
        evmChainId: chainConfig.evmChainId,
      });
      const [currentEpoch, firstRewardedEpoch] = await Promise.all([usage.currentEpoch(), usage.firstRewardedEpoch()]);
      return { mode: 'recognized-usage', currentEpoch, firstRewardedEpoch, addresses: { ...addresses, ...resolveLegacyContractAddresses(chainConfig) }, registryPointers };
    }

    const legacyMatch = sameAddress(registryEmissions, chainConfig.emissionsContractAddress)
      && sameAddress(registryStaking, chainConfig.stakingContractAddress)
      && !sameAddress(registryEmissions, chainConfig.usageAccountingAddress)
      && !sameAddress(registryStaking, chainConfig.sellerRegistryAddress);
    if (legacyMatch) {
      const emissions = rpcOptions.legacyEmissionsClient ?? new EmissionsClient({
        rpcUrl: chainConfig.rpcUrl,
        fallbackRpcUrls: chainConfig.fallbackRpcUrls,
        contractAddress: chainConfig.emissionsContractAddress!,
        evmChainId: chainConfig.evmChainId,
      });
      const { epoch: currentEpoch } = await emissions.getEpochInfo();
      return { mode: 'legacy', currentEpoch, addresses, registryPointers };
    }

    throw new ContractStackMismatchError(
      `registry emissions=${registryEmissions}, staking=${registryStaking}; configured legacy emissions=${chainConfig.emissionsContractAddress ?? 'missing'}, staking=${chainConfig.stakingContractAddress ?? 'missing'}; configured recognized emissions=${chainConfig.usageAccountingAddress ?? 'missing'}, staking=${chainConfig.sellerRegistryAddress ?? 'missing'}`,
    );
  } catch (error) {
    if (error instanceof ContractStackMismatchError) throw error;
    throw new ContractStackMismatchError(`failed to verify registry ${registryAddress}: ${(error as Error).message}`);
  }
}
