import { assertNetworkOptions } from './env.mjs';

/** Payment wiring for the fork, pointing at production contract addresses on the local Anvil RPC. */
export function paymentsConfig(chain, rpcUrl, { chainTimestamp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const skew = chainTimestamp ? Math.max(0, chainTimestamp - now) : 0;
  return {
    enabled: true,
    rpcUrl,
    fallbackRpcUrls: [],
    chainId: 8453,
    depositsAddress: chain.depositsContractAddress,
    channelsAddress: chain.channelsContractAddress,
    stakingAddress: chain.stakingContractAddress,
    usdcAddress: chain.usdcContractAddress,
    identityRegistryAddress: chain.identityRegistryAddress,
    sellerPoolsAddress: chain.sellerPoolsAddress,
    usageAccountingAddress: chain.usageAccountingAddress,
    washTradingRegistryAddress: chain.washTradingRegistryAddress,
    maxPerRequestUsdc: '5000000',
    maxReserveAmountUsdc: '1000000',
    // The fork clock runs ahead of wall time after the stake-activation warp; auth deadlines must cover it.
    defaultAuthDurationSecs: skew + 90_000,
    settlementIdleMs: 600_000,
  };
}

/** Network options shared by every sandbox node. Checked by assertNetworkOptions before use. */
export function sandboxNodeOptions({ role, dataDir, bootstrapNodes, payments }) {
  const options = {
    role,
    dataDir,
    dhtPort: 0,
    ...(role === 'seller' ? { signalingPort: 0 } : {}),
    bindHost: '127.0.0.1',
    natTraversal: false,
    noOfficialBootstrap: true,
    allowPrivateIPs: true,
    bootstrapNodes,
    dhtOperationTimeoutMs: 5000,
    relayer: { enabled: false },
    payments,
  };
  return assertNetworkOptions(options);
}
