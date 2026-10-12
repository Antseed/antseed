import {
  resolveChainConfig,
  type NodePaymentsConfig,
} from '@antseed/node';

/**
 * The subset of the CLI's `payments.crypto` user overrides that chain-aware
 * network commands actually consume. Matches the shape of
 * `AntseedConfig.payments.crypto` from the CLI's config/types.ts.
 */
export interface ChainCryptoOverrides {
  chainId?: 'base-local' | 'base-sepolia' | 'base-mainnet';
  rpcUrl?: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  registryContractAddress?: string;
  freeUsageContractAddress?: string;
  usdcContractAddress?: string;
  stakingContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
  washTradingRegistryAddress?: string;
  pointsPolicyRegistryAddress?: string;
  /** Explorer REST base for seller profiles in `antseed ants`; empty string disables the lookup. */
  explorerApiUrl?: string;
}

/**
 * Build the `NodePaymentsConfig` an ad-hoc `AntseedNode` needs to enrich peers
 * with on-chain stats (channel count, ghost count, total volume, last-settled).
 * Used by short-lived buyer nodes spun up by `antseed network browse` and
 * `antseed network peer` when a buyer daemon isn't already running.
 *
 * Returns `undefined` when the chain can't be resolved (missing `chainId`,
 * RPC, or contract addresses) so callers can gracefully skip on-chain
 * enrichment instead of erroring out. The caller is responsible for deciding
 * what to do with `undefined` — typically: skip the enrichment loop and show
 * on-chain columns as "—".
 *
 * The `stakingAddress` + `identityRegistryAddress` wiring is critical: without
 * them `AntseedNode._initializePayments` never creates a `StakingClient` /
 * `IdentityClient`, which gates the on-chain verification loop in
 * `discoverPeers()`. The seller-pools, usage-accounting and wash-trading
 * registry addresses feed the `TrustSignalsClient` behind the buyer trust
 * score; without them the usage, stake and wash parts of `peer.trust` stay null.
 */
export function buildPaymentsConfig(
  cryptoOverrides: ChainCryptoOverrides | undefined,
): NodePaymentsConfig | undefined {
  try {
    const resolved = resolveChainConfig({
      chainId: cryptoOverrides?.chainId,
      rpcUrl: cryptoOverrides?.rpcUrl,
      depositsContractAddress: cryptoOverrides?.depositsContractAddress,
      channelsContractAddress: cryptoOverrides?.channelsContractAddress,
      freeUsageContractAddress: cryptoOverrides?.freeUsageContractAddress,
      usdcContractAddress: cryptoOverrides?.usdcContractAddress,
    });
    const paymentsConfig: NodePaymentsConfig = {
      enabled: true,
      rpcUrl: resolved.rpcUrl,
      ...(resolved.fallbackRpcUrls ? { fallbackRpcUrls: resolved.fallbackRpcUrls } : {}),
      depositsAddress: resolved.depositsContractAddress,
      channelsAddress: resolved.channelsContractAddress,
      ...(resolved.freeUsageContractAddress ? { freeUsageAddress: resolved.freeUsageContractAddress } : {}),
      usdcAddress: resolved.usdcContractAddress,
      chainId: resolved.evmChainId,
      ...(resolved.stakingContractAddress ? { stakingAddress: resolved.stakingContractAddress } : {}),
      ...(resolved.identityRegistryAddress ? { identityRegistryAddress: resolved.identityRegistryAddress } : {}),
      ...(resolved.sellerPoolsAddress ? { sellerPoolsAddress: resolved.sellerPoolsAddress } : {}),
      ...(resolved.usageAccountingAddress ? { usageAccountingAddress: resolved.usageAccountingAddress } : {}),
      ...(resolved.washTradingRegistryAddress ? { washTradingRegistryAddress: resolved.washTradingRegistryAddress } : {}),
    };
    return paymentsConfig;
  } catch {
    return undefined;
  }
}
