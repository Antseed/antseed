import { sanitizeConfig } from './config.mjs';

export const MAX_SELLERS = 8;
const SELLER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const TARGET_CAPABILITIES = {
  fork: new Set(['warpTime', 'sellerControl', 'mockControl']),
};

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
  if (sellersIn.length > MAX_SELLERS) throw new Error(`At most ${MAX_SELLERS} sellers per sandbox`);
  const ids = new Set();
  const sellers = sellersIn.map((seller, index) => {
    const id = seller.id ?? `seller-${index + 1}`;
    if (!SELLER_ID.test(id)) throw new Error(`Invalid seller id "${id}"`);
    if (ids.has(id)) throw new Error(`Duplicate seller id "${id}"`);
    ids.add(id);
    const providers = seller.providers
      ? sanitizeConfig({ seller: { providers: seller.providers } }).cleaned.seller.providers
      : structuredClone(source.seller.providers);
    const latencyMs = seller.mock?.latencyMs ?? 0;
    if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) throw new Error(`seller ${id} mock.latencyMs must be 0-60000`);
    return { id, providers, mock: { latencyMs } };
  });
  const buyerIn = topology.buyer ?? {};
  const depositUsdc = overrides.depositUsdc ?? buyerIn.depositUsdc ?? '10';
  const block = overrides.block ?? topology.chain?.block;
  if (block !== undefined && !(/^\d+$/.test(String(block)) && Number.isSafeInteger(Number(block)))) throw new Error('block must be a block number');
  return {
    sellers,
    buyer: {
      depositMicros: String(microsFromUsdc(depositUsdc, 'depositUsdc')),
      routingPreferences: { ...(source.buyer.routingPreferences ?? {}), ...(buyerIn.routingPreferences ?? {}) },
      ...(buyerIn.maxPricing ?? source.buyer.maxPricing ? { maxPricing: structuredClone(buyerIn.maxPricing ?? source.buyer.maxPricing) } : {}),
    },
    chain: { ...(block !== undefined ? { block: Number(block) } : {}) },
  };
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
  if (typeof mod.run !== 'function') throw new Error(`Scenario ${name} must export async function run(sb)`);
  const targets = meta.targets ?? ['fork'];
  const requires = meta.requires ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error(`Scenario ${name} meta.targets must be a non-empty array`);
  if (!Array.isArray(requires)) throw new Error(`Scenario ${name} meta.requires must be an array`);
  return { name, description: meta.description ?? '', targets, requires, topology: mod.topology, run: mod.run };
}

export function assertScenarioSupported(scenario, target) {
  if (!scenario.targets.includes(target)) throw new Error(`Scenario ${scenario.name} does not support target ${target} (supports ${scenario.targets.join(', ')})`);
  const capabilities = TARGET_CAPABILITIES[target];
  if (!capabilities) throw new Error(`Unknown target ${target}`);
  const missing = scenario.requires.filter((capability) => !capabilities.has(capability));
  if (missing.length) throw new Error(`Target ${target} lacks ${missing.join(', ')} required by ${scenario.name}`);
}

/** Two topologies are compatible when they produce the same sellers/models; used before reusing a running sandbox. */
export function topologyFingerprint(normalized) {
  return normalized.sellers.map((seller) => `${seller.id}:${Object.entries(seller.providers).map(([name, p]) => `${name}=${Object.keys(p.services).sort().join('+')}`).sort().join(',')}`).join('|');
}
