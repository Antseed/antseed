import { assertLocalUrl, assertNetworkOptions, FORBIDDEN_PORTS } from './env.mjs';

/** Payment wiring for the testbench chain (fork: production addresses; local: base-local addresses), always on the local Anvil RPC. */
export function paymentsConfig(chain, rpcUrl, { chainTimestamp, settlementIdleMs = 600_000 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const skew = chainTimestamp ? Math.max(0, chainTimestamp - now) : 0;
  return {
    enabled: true,
    rpcUrl,
    fallbackRpcUrls: [],
    chainId: chain.evmChainId ?? 8453,
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
    settlementIdleMs,
  };
}

/** Network options shared by every testbench node. Checked by assertNetworkOptions before use. */
export function testbenchNodeOptions({ role, dataDir, bootstrapNodes, payments }) {
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

/** The `network` config section that gives a CLI node what testbenchNodeOptions gives an SDK node. */
function cliNetwork({ role, bootstrapNodes, payments }) {
  const { bindHost, natTraversal, noOfficialBootstrap, allowPrivateIPs, dhtOperationTimeoutMs, dhtPort, signalingPort } = testbenchNodeOptions({ role, bootstrapNodes, payments });
  return {
    bootstrapNodes: bootstrapNodes.map((node) => `${node.host}:${node.port}`),
    dhtPort,
    ...(signalingPort !== undefined ? { signalingPort } : {}),
    bindHost, natTraversal, noOfficialBootstrap, allowPrivateIPs, dhtOperationTimeoutMs,
  };
}

function cliCrypto(chain, payments) {
  return { ...chain, rpcUrl: payments.rpcUrl, networkStatsUrl: '', explorerApiUrl: '' };
}

/**
 * config.json of `antseed seller start`. Self-probing and gas checks stay off, as in the stress harness: they would
 * add requests to the mock's ledger and no testbench scenario needs them. `minBudgetPerRequest` is written only when
 * the topology sets it; otherwise the CLI's own default applies, which is what a real seller runs.
 */
export function cliSellerConfig({ id, providers, chain, bootstrapNodes, payments, freeTier }) {
  return {
    identity: { displayName: `testbench-${id}` },
    seller: {
      maxConcurrentBuyers: 256, reserveFloor: 0, providers,
      ...(freeTier ? { freeTier } : {}),
      healthCheck: { enabled: false }, gasCheck: { enabled: false }, gasRefuel: { enabled: false },
      restrictedCountries: [],
    },
    payments: {
      preferredMethod: 'crypto',
      crypto: cliCrypto(chain, payments),
      defaultAuthDurationSecs: payments.defaultAuthDurationSecs,
      ...(payments.minBudgetPerRequest ? { minBudgetPerRequest: payments.minBudgetPerRequest } : {}),
    },
    relayer: { enabled: false },
    network: cliNetwork({ role: 'seller', bootstrapNodes, payments }),
  };
}

/** config.json of `antseed buyer start`: the settings the in-process buyer gets, spelled as CLI config. */
export function cliBuyerConfig({ proxyPort, routingPreferences, maxPricing, chain, bootstrapNodes, payments }) {
  return {
    identity: { displayName: 'testbench-buyer' },
    buyer: {
      proxyPort, minPeerReputation: 0, routingPreferences, peerRefreshIntervalMs: 60_000, autoSweep: false,
      ...(maxPricing ? { maxPricing } : {}),
    },
    payments: {
      preferredMethod: 'crypto',
      crypto: cliCrypto(chain, payments),
      maxPerRequestUsdc: payments.maxPerRequestUsdc,
      maxReserveAmountUsdc: payments.maxReserveAmountUsdc,
      defaultAuthDurationSecs: payments.defaultAuthDurationSecs,
    },
    relayer: { enabled: false },
    network: cliNetwork({ role: 'buyer', bootstrapNodes, payments }),
  };
}

function parseBootstrapEntry(entry) {
  const separator = String(entry).lastIndexOf(':');
  return { host: String(entry).slice(0, separator), port: Number(String(entry).slice(separator + 1)) };
}

/** assertNetworkOptions for a written CLI config, plus what only a CLI node has: the chain RPC and the proxy port from the file. */
export function assertCliConfig(config, role) {
  const network = config.network ?? {};
  assertNetworkOptions({ ...network, role, bootstrapNodes: Array.isArray(network.bootstrapNodes) ? network.bootstrapNodes.map(parseBootstrapEntry) : network.bootstrapNodes });
  assertLocalUrl(config.payments?.crypto?.rpcUrl, 'payments.crypto.rpcUrl');
  if (role === 'buyer') {
    const port = config.buyer?.proxyPort;
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || FORBIDDEN_PORTS.has(port)) throw new Error(`buyer.proxyPort=${port} collides with a default AntSeed port or is unset`);
  }
  return config;
}
