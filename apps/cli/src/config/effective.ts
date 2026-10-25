import type { BuyerCLIConfig, AntseedConfig, SellerCLIConfig, SellerFreeTierCLIConfig } from './types.js';
import { MIN_BUYER_MAX_STREAM_DURATION_MS, MIN_BUYER_METADATA_FETCH_TIMEOUT_MS } from './validation.js';

export interface SellerRuntimeOverrides {
  reserveFloor?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface BuyerRuntimeOverrides {
  proxyPort?: number;
  minPeerReputation?: number;
  maxInputUsdPerMillion?: number;
  maxOutputUsdPerMillion?: number;
  metadataFetchTimeoutMs?: number;
  disableMetadataV2Services?: boolean;
}

export interface ResolveEffectiveConfigInput {
  config: AntseedConfig;
  env?: NodeJS.ProcessEnv;
  sellerOverrides?: SellerRuntimeOverrides;
  buyerOverrides?: BuyerRuntimeOverrides;
}

/** Env vars that override buyer settings; read by `resolveEffectiveBuyerConfig`, reported by `buyerSettingOverrides`. */
const BUYER_ENV = {
  minPeerReputation: 'ANTSEED_BUYER_MIN_REPUTATION',
  maxInputUsdPerMillion: 'ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION',
  maxOutputUsdPerMillion: 'ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION',
  metadataFetchTimeoutMs: 'ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS',
  maxStreamDurationMs: 'ANTSEED_BUYER_MAX_STREAM_DURATION_MS',
  disableMetadataV2Services: 'ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES',
} as const;

function parseEnvNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEnvBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${key} must be a boolean`);
}

function assertValidMetadataFetchTimeoutMs(value: number, sourceLabel: string): void {
  if (Number.isInteger(value) && value >= MIN_BUYER_METADATA_FETCH_TIMEOUT_MS) return;
  throw new Error(`${sourceLabel} must be an integer >= ${MIN_BUYER_METADATA_FETCH_TIMEOUT_MS}`);
}

function assertValidMaxStreamDurationMs(value: number, sourceLabel: string): void {
  if (Number.isInteger(value) && value >= MIN_BUYER_MAX_STREAM_DURATION_MS) return;
  throw new Error(`${sourceLabel} must be an integer >= ${MIN_BUYER_MAX_STREAM_DURATION_MS}`);
}

/**
 * Apply a global seller-wide pricing override to every configured provider's
 * defaults. Service-specific pricing entries are left alone — the override
 * only shifts the fallback price floor.
 */
function applyProviderPricingOverride(
  seller: SellerCLIConfig,
  field: 'inputUsdPerMillion' | 'outputUsdPerMillion',
  value: number,
): void {
  const providers = Object.values(seller.providers);
  if (providers.length === 0) {
    console.warn(
      `Warning: ${field} override (${value}) has no effect — no providers configured yet. ` +
      `Add a provider first via 'antseed config seller add-provider'.`,
    );
    return;
  }
  for (const providerCfg of providers) {
    if (!providerCfg.defaults) {
      providerCfg.defaults = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    }
    providerCfg.defaults[field] = value;
  }
}

export function resolveEffectiveSellerConfig(input: ResolveEffectiveConfigInput): SellerCLIConfig {
  const env = input.env ?? process.env;
  const seller = structuredClone(input.config.seller);

  const envInputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_SELLER_INPUT_USD_PER_MILLION');
  const envOutputUsdPerMillion = parseEnvNumber(env, 'ANTSEED_SELLER_OUTPUT_USD_PER_MILLION');

  if (envInputUsdPerMillion !== undefined) {
    applyProviderPricingOverride(seller, 'inputUsdPerMillion', envInputUsdPerMillion);
  }
  if (envOutputUsdPerMillion !== undefined) {
    applyProviderPricingOverride(seller, 'outputUsdPerMillion', envOutputUsdPerMillion);
  }

  const overrides = input.sellerOverrides;
  if (overrides?.reserveFloor !== undefined) {
    seller.reserveFloor = overrides.reserveFloor;
  }
  if (overrides?.inputUsdPerMillion !== undefined) {
    applyProviderPricingOverride(seller, 'inputUsdPerMillion', overrides.inputUsdPerMillion);
  }
  if (overrides?.outputUsdPerMillion !== undefined) {
    applyProviderPricingOverride(seller, 'outputUsdPerMillion', overrides.outputUsdPerMillion);
  }

  return seller;
}

/**
 * The node's free-tier config for the given providers: the seller-wide
 * program plus every service that sets its own. Undefined when there is none.
 */
export function resolveSellerFreeTier(
  seller: SellerCLIConfig,
  providerNames: readonly string[],
): (SellerFreeTierCLIConfig & { services?: Record<string, SellerFreeTierCLIConfig> }) | undefined {
  const services: Record<string, SellerFreeTierCLIConfig> = {};
  for (const name of providerNames) {
    for (const [serviceId, service] of Object.entries(seller.providers[name]?.services ?? {})) {
      if (service.freeTier) services[serviceId] = service.freeTier;
    }
  }
  if (!seller.freeTier && Object.keys(services).length === 0) return undefined;
  return {
    ...(seller.freeTier ?? {}),
    ...(Object.keys(services).length > 0 ? { services } : {}),
  };
}

/** Services of `providerNames` that charge: tokens (their own pricing or the provider default) or any priced unit-billing model. */
export function pricedSellerServices(seller: SellerCLIConfig, providerNames: readonly string[]): string[] {
  const priced = new Set<string>();
  for (const name of providerNames) {
    const provider = seller.providers[name];
    for (const [serviceId, service] of Object.entries(provider?.services ?? {})) {
      const pricing = service.pricing ?? provider?.defaults;
      const tokenPriced = Boolean(pricing && (pricing.inputUsdPerMillion > 0 || pricing.outputUsdPerMillion > 0 || (pricing.cachedInputUsdPerMillion ?? 0) > 0));
      const unitPriced = Object.values(service.unitBillingModels ?? {})
        .some((model) => (model?.components ?? []).some((component) => !(component.priceUsd <= 0)));
      if (tokenPriced || unitPriced) priced.add(serviceId);
    }
  }
  return [...priced];
}

export function resolveEffectiveBuyerConfig(input: ResolveEffectiveConfigInput): BuyerCLIConfig {
  const env = input.env ?? process.env;
  const buyer = structuredClone(input.config.buyer);

  const envMinReputation = parseEnvNumber(env, BUYER_ENV.minPeerReputation);
  const envMaxInputUsdPerMillion = parseEnvNumber(env, BUYER_ENV.maxInputUsdPerMillion);
  const envMaxOutputUsdPerMillion = parseEnvNumber(env, BUYER_ENV.maxOutputUsdPerMillion);
  const envMetadataFetchTimeoutKey = BUYER_ENV.metadataFetchTimeoutMs;
  const envMetadataFetchTimeoutMs = parseEnvNumber(env, envMetadataFetchTimeoutKey);
  if (env[envMetadataFetchTimeoutKey] !== undefined && envMetadataFetchTimeoutMs === undefined) {
    throw new Error(`${envMetadataFetchTimeoutKey} must be a finite number`);
  }
  const envMaxStreamDurationKey = BUYER_ENV.maxStreamDurationMs;
  const envMaxStreamDurationMs = parseEnvNumber(env, envMaxStreamDurationKey);
  if (env[envMaxStreamDurationKey] !== undefined && envMaxStreamDurationMs === undefined) {
    throw new Error(`${envMaxStreamDurationKey} must be a finite number`);
  }
  const envDisableMetadataV2Services = parseEnvBoolean(env, BUYER_ENV.disableMetadataV2Services);

  if (envMinReputation !== undefined) {
    buyer.minPeerReputation = envMinReputation;
  }
  if (envMaxInputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.inputUsdPerMillion = envMaxInputUsdPerMillion;
  }
  if (envMaxOutputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.outputUsdPerMillion = envMaxOutputUsdPerMillion;
  }
  if (envMetadataFetchTimeoutMs !== undefined) {
    buyer.metadataFetchTimeoutMs = envMetadataFetchTimeoutMs;
  }
  if (envMaxStreamDurationMs !== undefined) {
    buyer.maxStreamDurationMs = envMaxStreamDurationMs;
  }
  if (envDisableMetadataV2Services !== undefined) {
    buyer.disableMetadataV2Services = envDisableMetadataV2Services;
  }

  const overrides = input.buyerOverrides;
  if (overrides?.proxyPort !== undefined) {
    buyer.proxyPort = overrides.proxyPort;
  }
  if (overrides?.minPeerReputation !== undefined) {
    buyer.minPeerReputation = overrides.minPeerReputation;
  }
  if (overrides?.maxInputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.inputUsdPerMillion = overrides.maxInputUsdPerMillion;
  }
  if (overrides?.maxOutputUsdPerMillion !== undefined) {
    buyer.maxPricing.defaults.outputUsdPerMillion = overrides.maxOutputUsdPerMillion;
  }
  if (overrides?.metadataFetchTimeoutMs !== undefined) {
    buyer.metadataFetchTimeoutMs = overrides.metadataFetchTimeoutMs;
  }
  if (overrides?.disableMetadataV2Services !== undefined) {
    buyer.disableMetadataV2Services = overrides.disableMetadataV2Services;
  }

  assertValidMetadataFetchTimeoutMs(buyer.metadataFetchTimeoutMs, 'buyer.metadataFetchTimeoutMs');
  assertValidMaxStreamDurationMs(buyer.maxStreamDurationMs, 'buyer.maxStreamDurationMs');

  return buyer;
}

/**
 * Buyer settings the running buyer took from the environment or `buyer
 * start` flags instead of the config file, as setting paths (the gateway's
 * `Settings.buyer` shape, e.g. "maxPricing.inputUsdPerMillion"). Editing
 * these in the config file has no effect until the override is removed.
 */
export function buyerSettingOverrides(input: {
  env?: NodeJS.ProcessEnv;
  buyerOverrides?: BuyerRuntimeOverrides;
  /** Any of `--no-verifier`, `--verifiers`, `--require-verifier` was given. */
  verifierFlags?: boolean;
}): string[] {
  const env = input.env ?? process.env;
  const overrides = input.buyerOverrides ?? {};
  const paths = new Set<string>();
  const set = (path: string, active: boolean): void => { if (active) paths.add(path); };
  set('proxyPort', overrides.proxyPort !== undefined);
  const fromEnv = (setting: keyof typeof BUYER_ENV): boolean => env[BUYER_ENV[setting]] !== undefined;
  set('minPeerReputation', overrides.minPeerReputation !== undefined || fromEnv('minPeerReputation'));
  set('maxPricing.inputUsdPerMillion', overrides.maxInputUsdPerMillion !== undefined || fromEnv('maxInputUsdPerMillion'));
  set('maxPricing.outputUsdPerMillion', overrides.maxOutputUsdPerMillion !== undefined || fromEnv('maxOutputUsdPerMillion'));
  set('network.metadataFetchTimeoutMs', overrides.metadataFetchTimeoutMs !== undefined || fromEnv('metadataFetchTimeoutMs'));
  set('network.maxStreamDurationMs', fromEnv('maxStreamDurationMs'));
  set('network.disableMetadataV2Services', overrides.disableMetadataV2Services !== undefined || fromEnv('disableMetadataV2Services'));
  set('payments.rpcUrl', Boolean(env['ANTSEED_BASE_RPC_URL']?.trim()));
  set('verifier', input.verifierFlags === true);
  return [...paths];
}

export function resolveEffectiveRoleConfig(input: ResolveEffectiveConfigInput): {
  seller: SellerCLIConfig;
  buyer: BuyerCLIConfig;
} {
  return {
    seller: resolveEffectiveSellerConfig(input),
    buyer: resolveEffectiveBuyerConfig(input),
  };
}
