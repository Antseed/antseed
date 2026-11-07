import { sanitizeConfig } from './config.mjs';

export const MAX_SELLERS = 8;
const SELLER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const TARGET_CAPABILITIES = {
  fork: new Set(['warpTime', 'sellerControl', 'mockControl', 'liveUpstream', 'desktop', 'buyerControl', 'buyerFaults']),
  local: new Set(['warpTime', 'sellerControl', 'mockControl', 'liveUpstream', 'desktop', 'buyerControl', 'buyerFaults', 'sourceContracts']),
  mainnet: new Set(['desktop', 'realFunds']),
};
/** How nodes run: `sdk` builds them from the SDK (the buyer inside the supervisor), `cli` runs real `antseed` CLI processes. */
export const TESTBENCH_MODES = new Set(['sdk', 'cli']);
/** Capabilities a mode cannot offer whatever the target: fault hooks reach into an in-process buyer. */
const MODE_LACKS = { sdk: new Set(), cli: new Set(['buyerFaults']) };

export function assertMode(mode, label = 'mode') {
  if (!TESTBENCH_MODES.has(mode)) throw new Error(`${label} must be one of ${[...TESTBENCH_MODES].join(', ')}`);
  return mode;
}

/** The mode a run or `up` asks for: --mode, then the scenario topology, then sdk. */
export function requestedMode(override, topology) {
  return assertMode(override ?? topology?.mode ?? 'sdk');
}

function microsFromUsdc(value, label) {
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text) || Number(text) <= 0 || Number(text) > 1000) throw new Error(`${label} must be a USDC amount between 0 and 1000`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export { microsFromUsdc };

/**
 * Normalizes a topology (plain data) against the sanitized source config.
 * Each seller gets the source providers unless it brings its own (sanitized the same way).
 */
export function normalizeTopology(topology = {}, source, overrides = {}) {
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) throw new Error('topology must be an object');
  const sellersIn = topology.sellers ?? [{ id: 'seller' }];
  if (!Array.isArray(sellersIn) || sellersIn.length === 0) throw new Error('topology.sellers must list at least one seller');
  if (sellersIn.length > MAX_SELLERS) throw new Error(`At most ${MAX_SELLERS} sellers per testbench`);
  const ids = new Set();
  const sellers = sellersIn.map((seller, index) => {
    const id = seller.id ?? `seller-${index + 1}`;
    if (!SELLER_ID.test(id)) throw new Error(`Invalid seller id "${id}"`);
    if (ids.has(id)) throw new Error(`Duplicate seller id "${id}"`);
    ids.add(id);
    const providers = seller.providers
      ? sanitizeConfig({ seller: { providers: seller.providers } }).cleaned.seller.providers
      : structuredClone(source.seller.providers);
    for (const [providerName, provider] of Object.entries(providers)) {
      for (const [serviceId, service] of Object.entries(provider.services ?? {})) {
        if (service.freeTier !== undefined) service.freeTier = normalizeFreeTier(service.freeTier, `seller ${id} ${providerName}.${serviceId}.freeTier`);
      }
    }
    return {
      id, providers, mock: normalizeMock(seller.mock ?? {}, id),
      ...(seller.freeTier !== undefined ? { freeTier: normalizeFreeTier(seller.freeTier, `seller ${id} freeTier`) } : {}),
      ...(seller.env ? { env: normalizeEnv(seller.env, `seller ${id}`) } : {}),
    };
  });
  const buyerIn = topology.buyer ?? {};
  const freeTierSellers = sellers.filter((seller) => seller.freeTier || Object.values(seller.providers).some((provider) => Object.values(provider.services ?? {}).some((service) => service.freeTier)));
  if (freeTierSellers.length && requestedMode(overrides.mode, topology) !== 'cli') {
    throw new Error(`Free-tier programs (seller ${freeTierSellers.map((seller) => seller.id).join(', ')}) need mode cli: \`antseed seller start\` reads them from the seller config`);
  }
  const depositUsdc = overrides.depositUsdc ?? buyerIn.depositUsdc ?? '10';
  const chainIn = topology.chain ?? {};
  const block = overrides.block ?? chainIn.block;
  const mode = requestedMode(overrides.mode, topology);
  const settlementIdleMs = topology.payments?.settlementIdleMs;
  // Sellers built on the SDK default to a 0.5 USDC minimum budget per request; `antseed seller start` uses 0.01.
  const minBudgetPerRequestUsdc = topology.payments?.minBudgetPerRequestUsdc;
  if (settlementIdleMs !== undefined && !(Number.isInteger(settlementIdleMs) && settlementIdleMs >= 1000 && settlementIdleMs <= 600_000)) throw new Error('payments.settlementIdleMs must be 1000-600000');
  if (block !== undefined && !(/^\d+$/.test(String(block)) && Number.isSafeInteger(Number(block)))) throw new Error('block must be a block number');
  const rpc = chainIn.rpc ?? 'direct';
  if (!RPC_PROFILES.has(rpc)) throw new Error(`chain.rpc must be one of ${[...RPC_PROFILES].join(', ')}`);
  // Base-like RPCs come with Base's 2 s blocks unless the topology says otherwise; direct RPCs keep Anvil's automine.
  const blockTimeSec = chainIn.blockTimeSec ?? (rpc === 'base' ? 2 : undefined);
  if (blockTimeSec !== undefined && !(Number.isInteger(blockTimeSec) && blockTimeSec >= 1 && blockTimeSec <= 30)) throw new Error('chain.blockTimeSec must be 1-30');
  const contracts = overrides.contracts ?? chainIn.contracts ?? DEFAULT_CONTRACT_LAYOUT;
  if (!CONTRACT_LAYOUTS.includes(contracts)) throw new Error(`chain.contracts must be one of ${CONTRACT_LAYOUTS.join(', ')}`);
  const topUpThresholdBps = chainIn.topUpThresholdBps;
  if (topUpThresholdBps !== undefined && !(Number.isInteger(topUpThresholdBps) && topUpThresholdBps >= 1 && topUpThresholdBps <= 10_000)) throw new Error('chain.topUpThresholdBps must be 1-10000');
  const caps = {};
  for (const key of ['maxReserveUsdc', 'maxPerRequestUsdc']) {
    if (buyerIn[key] !== undefined) caps[key.replace('Usdc', 'Micros')] = String(microsFromUsdc(buyerIn[key], `buyer.${key}`));
  }
  return {
    mode,
    sellers,
    buyer: {
      depositMicros: String(microsFromUsdc(depositUsdc, 'depositUsdc')),
      routingPreferences: { ...(source.buyer.routingPreferences ?? {}), ...(buyerIn.routingPreferences ?? {}) },
      ...(buyerIn.maxPricing ?? source.buyer.maxPricing ? { maxPricing: structuredClone(buyerIn.maxPricing ?? source.buyer.maxPricing) } : {}),
      ...caps,
      ...(buyerIn.env ? { env: normalizeEnv(buyerIn.env, 'buyer') } : {}),
    },
    chain: {
      ...(block !== undefined ? { block: Number(block) } : {}),
      rpc,
      // The default layout is left out, so topologies (and their fingerprints) from before the knob read the same.
      ...(contracts !== DEFAULT_CONTRACT_LAYOUT ? { contracts } : {}),
      ...(blockTimeSec !== undefined ? { blockTimeSec } : {}),
      ...(topUpThresholdBps !== undefined ? { topUpThresholdBps } : {}),
    },
    payments: {
      ...(settlementIdleMs !== undefined ? { settlementIdleMs } : {}),
      ...(minBudgetPerRequestUsdc !== undefined ? { minBudgetPerRequestMicros: String(microsFromUsdc(minBudgetPerRequestUsdc, 'payments.minBudgetPerRequestUsdc')) } : {}),
    },
  };
}

/**
 * Chain links between each testbench node and Anvil. `direct` talks to Anvil; `base` puts a proxy in front of
 * it per node that behaves like a public Base RPC (latency with a slow tail, 429s above a rate limit, reads a
 * block behind and missing receipts right after a transaction; see e2e/stress/rpc-proxy.mjs).
 */
export const RPC_PROFILES = new Set(['direct', 'base']);

const FREE_TIER_KEYS = new Set(['maxRequestsPerAddress', 'maxRequestsPerIp', 'windowMs', 'stakeTiers', 'stakersOnly']);

/**
 * A seller free-tier program, as `seller.freeTier` or a service's `freeTier` in the CLI config
 * (packages/node/src/payments/seller-free-tier-limiter.ts): request limits per buyer address and per IP over a
 * window, staked tiers `{ minPower (ANTS x epochs), multiplier (number or 'unlimited') }` and stakersOnly.
 */
export function normalizeFreeTier(freeTier, label = 'freeTier') {
  if (!freeTier || typeof freeTier !== 'object' || Array.isArray(freeTier)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(freeTier)) if (!FREE_TIER_KEYS.has(key)) throw new Error(`${label}.${key} is not a free-tier setting (${[...FREE_TIER_KEYS].join(', ')})`);
  for (const key of ['maxRequestsPerAddress', 'maxRequestsPerIp']) {
    if (freeTier[key] !== undefined && !(Number.isInteger(freeTier[key]) && freeTier[key] >= 0)) throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  if (freeTier.windowMs !== undefined && !(Number.isInteger(freeTier.windowMs) && freeTier.windowMs >= 1000)) throw new Error(`${label}.windowMs must be at least 1000`);
  if (freeTier.stakersOnly !== undefined && typeof freeTier.stakersOnly !== 'boolean') throw new Error(`${label}.stakersOnly must be a boolean`);
  if (freeTier.stakeTiers !== undefined) {
    if (!Array.isArray(freeTier.stakeTiers)) throw new Error(`${label}.stakeTiers must be a list`);
    for (const tier of freeTier.stakeTiers) {
      if (!(Number.isInteger(tier?.minPower) && tier.minPower > 0) || !(tier.multiplier === 'unlimited' || (typeof tier.multiplier === 'number' && tier.multiplier > 1))) {
        throw new Error(`${label}.stakeTiers entries need minPower (a positive integer) and multiplier (above 1, or 'unlimited')`);
      }
    }
  }
  return structuredClone(freeTier);
}

/**
 * Contract layouts of the local chain (`chain.contracts`; a fork always has Base's). 'full' deploys the production
 * stack (payments, recognized-usage emissions and seller pools, free usage, verification); 'payments' only
 * script/Deploy.s.sol (registry, legacy staking and emissions, deposits, channels, stats, deposit relay).
 * See lib/local-deploy.mjs.
 */
export const CONTRACT_LAYOUTS = ['full', 'payments'];
export const DEFAULT_CONTRACT_LAYOUT = 'full';

/** Mock upstream usage: `fixed` answers 10 in + 8 out tokens instantly (exact costs); `load` sizes usage like real traffic. */
export const MOCK_USAGE_MODES = new Set(['fixed', 'load']);

const LOAD_MOCK_DEFAULTS = { latencyRangeMs: [50, 3000], outTokens: [100, 4000] };

function range(value, label, max) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isInteger(n) && n >= 0 && n <= max) || value[0] > value[1]) {
    throw new Error(`${label} must be [min, max] integers within 0-${max}`);
  }
  return [value[0], value[1]];
}

function rate(value, label) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new Error(`${label} must be a rate between 0 and 1`);
  return value;
}

/** A seller's mock upstream: latency, usage mode and the fault rates it starts with (all but usage can change at run time). */
export function normalizeMock(mock, id) {
  const latencyMs = mock.latencyMs ?? 0;
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) throw new Error(`seller ${id} mock.latencyMs must be 0-60000`);
  const usage = mock.usage ?? 'fixed';
  if (!MOCK_USAGE_MODES.has(usage)) throw new Error(`seller ${id} mock.usage must be one of ${[...MOCK_USAGE_MODES].join(', ')}`);
  const normalized = { latencyMs, usage, fault500Rate: rate(mock.fault500Rate, `seller ${id} mock.fault500Rate`), disconnectRate: rate(mock.disconnectRate, `seller ${id} mock.disconnectRate`) };
  if (usage === 'load') {
    normalized.latencyRangeMs = range(mock.latencyRangeMs ?? LOAD_MOCK_DEFAULTS.latencyRangeMs, `seller ${id} mock.latencyRangeMs`, 60_000);
    normalized.outTokens = range(mock.outTokens ?? LOAD_MOCK_DEFAULTS.outTokens, `seller ${id} mock.outTokens`, 100_000);
  } else if (mock.latencyRangeMs !== undefined || mock.outTokens !== undefined) {
    throw new Error(`seller ${id} mock.latencyRangeMs and mock.outTokens need mock.usage 'load'`);
  }
  return normalized;
}

/** Extra environment for a node. AntSeed switches only: HOME and the identity stay the testbench's. */
function normalizeEnv(env, label) {
  for (const [key, value] of Object.entries(env)) {
    if (!/^ANTSEED_[A-Z0-9_]+$/.test(key) || key === 'ANTSEED_IDENTITY_HEX' || typeof value !== 'string') throw new Error(`${label} env must map ANTSEED_* switches to strings (got ${key})`);
  }
  return { ...env };
}

/** Buyer routing preferences: config/topology values, but only our sellers and no trust floor. */
export function buyerRoutingPreferences(normalized, sellerPeerIds) {
  return {
    ...normalized.buyer.routingPreferences,
    minTrustScore: 0,
    allowedPeerIds: [...sellerPeerIds],
    blockedPeerIds: [],
  };
}

export function validateScenarioModule(mod, name) {
  const meta = mod.meta ?? {};
  if (typeof mod.run !== 'function') throw new Error(`Scenario ${name} must export async function run(tb)`);
  const targets = meta.targets ?? ['fork'];
  const requires = meta.requires ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error(`Scenario ${name} meta.targets must be a non-empty array`);
  if (!Array.isArray(requires)) throw new Error(`Scenario ${name} meta.requires must be an array`);
  const budgets = mod.topology?.budgets ?? {};
  for (const [key, max] of Object.entries(budgets)) if (!(Number.isFinite(max) && max > 0)) throw new Error(`Scenario ${name} topology.budgets.${key} must be a positive number`);
  return { name, description: meta.description ?? '', targets, requires, topology: mod.topology, budgets, run: mod.run };
}

export function assertScenarioSupported(scenario, target, mode = 'sdk') {
  if (!scenario.targets.includes(target)) throw new Error(`Scenario ${scenario.name} does not support target ${target} (supports ${scenario.targets.join(', ')})`);
  const capabilities = TARGET_CAPABILITIES[target];
  if (!capabilities) throw new Error(`Unknown target ${target}`);
  const missing = scenario.requires.filter((capability) => !capabilities.has(capability));
  if (missing.length) throw new Error(`Target ${target} lacks ${missing.join(', ')} required by ${scenario.name}`);
  const unavailable = scenario.requires.filter((capability) => MODE_LACKS[assertMode(mode)].has(capability));
  if (unavailable.length) throw new Error(`Mode ${mode} lacks ${unavailable.join(', ')} required by ${scenario.name}; run it with --mode sdk`);
}

/**
 * Chain target for a run: an explicit --chain wins (and must match a running testbench), then the running
 * testbench's chain, then the scenario's first listed target.
 */
export function chooseTarget(scenario, { requested, running } = {}) {
  if (requested && running && requested !== running) throw new Error(`Testbench is running on chain ${running}, not ${requested}; run pnpm testbench down first or use --slot`);
  return requested ?? running ?? scenario.targets[0];
}

/**
 * Mode for a run, like chooseTarget: an explicit --mode wins (and must match a running testbench), then the running
 * testbench's mode, then the scenario topology's, then sdk.
 */
export function chooseMode(scenario, { requested, running } = {}) {
  if (requested && running && requested !== running) throw new Error(`Testbench is running in ${running} mode, not ${requested}; run pnpm testbench down first or use --slot`);
  return requestedMode(requested ?? running, scenario.topology);
}

/** Two topologies are compatible when they produce the same sellers/models; used before reusing a running testbench. */
export function topologyFingerprint(normalized) {
  const sellers = normalized.sellers.map((seller) => `${seller.id}:${Object.entries(seller.providers).map(([name, p]) => `${name}=${Object.keys(p.services).sort().join('+')}`).sort().join(',')}${seller.mock?.usage === 'load' ? '~load' : ''}`).join('|');
  // The chain link is fixed at `up`; a scenario that needs Base-like RPCs cannot reuse a direct testbench.
  const layout = normalized.chain?.contracts ?? DEFAULT_CONTRACT_LAYOUT;
  const linked = `${normalized.chain?.rpc === 'base' ? `${sellers}#rpc=base` : sellers}${layout === DEFAULT_CONTRACT_LAYOUT ? '' : `#contracts=${layout}`}`;
  // So is the mode: real CLI processes and SDK nodes do not stand in for each other.
  return normalized.mode === 'cli' ? `${linked}#mode=cli` : linked;
}
