import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_MODEL_ROUTING_PREFERENCES,
  type ModelRoutingPreferences,
} from '@antseed/node/model-routing';
import type {
  HierarchicalPricingConfig,
  AntseedConfig,
  DomainVerificationConfig,
  DomainVerificationMethod,
  GithubVerificationConfig,
  SellerProviderConfig,
  SellerServiceConfig,
  TokenPricingUsdPerMillion,
} from './types.js';
import { createDefaultConfig } from './defaults.js';
import { assertValidConfig } from './validation.js';

/**
 * Resolve a config path, expanding ~ to the user's home directory.
 */
function resolveConfigPath(configPath: string): string {
  if (configPath.startsWith('~')) {
    return resolve(homedir(), configPath.slice(2));
  }
  return resolve(configPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteOrNaN(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function clonePricing(pricing: TokenPricingUsdPerMillion): TokenPricingUsdPerMillion {
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    ...(pricing.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion } : {}),
  };
}

function normalizeTokenPricing(value: unknown): TokenPricingUsdPerMillion | null {
  if (!isRecord(value)) return null;
  return {
    inputUsdPerMillion: toFiniteOrNaN(value['inputUsdPerMillion']),
    outputUsdPerMillion: toFiniteOrNaN(value['outputUsdPerMillion']),
    ...(value['cachedInputUsdPerMillion'] != null ? { cachedInputUsdPerMillion: toFiniteOrNaN(value['cachedInputUsdPerMillion']) } : {}),
  };
}

function mergeTokenPricing(
  defaults: TokenPricingUsdPerMillion,
  value: unknown
): TokenPricingUsdPerMillion {
  if (!isRecord(value)) {
    return clonePricing(defaults);
  }
  return {
    inputUsdPerMillion: typeof value['inputUsdPerMillion'] === 'number'
      ? value['inputUsdPerMillion']
      : defaults.inputUsdPerMillion,
    outputUsdPerMillion: typeof value['outputUsdPerMillion'] === 'number'
      ? value['outputUsdPerMillion']
      : defaults.outputUsdPerMillion,
    ...(typeof value['cachedInputUsdPerMillion'] === 'number'
      ? { cachedInputUsdPerMillion: value['cachedInputUsdPerMillion'] }
      : defaults.cachedInputUsdPerMillion != null
        ? { cachedInputUsdPerMillion: defaults.cachedInputUsdPerMillion }
        : {}),
  };
}

function mergeHierarchicalPricing(
  defaults: HierarchicalPricingConfig,
  value: unknown
): HierarchicalPricingConfig {
  if (!isRecord(value)) {
    return { defaults: clonePricing(defaults.defaults) };
  }
  return { defaults: mergeTokenPricing(defaults.defaults, value['defaults']) };
}

/* ── Seller provider + services merge ──────────────────────────────────── */

function normalizeCategories(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? Array.from(new Set(out)) : undefined;
}

function normalizeSellerService(value: unknown): SellerServiceConfig | null {
  if (!isRecord(value)) return null;
  const out: SellerServiceConfig = {};
  if (typeof value['upstreamModel'] === 'string' && value['upstreamModel'].trim().length > 0) {
    out.upstreamModel = value['upstreamModel'].trim();
  }
  const categories = normalizeCategories(value['categories']);
  if (categories) {
    out.categories = categories;
  }
  const pricing = normalizeTokenPricing(value['pricing']);
  if (pricing) {
    out.pricing = pricing;
  }
  if (value['capabilities'] !== undefined) {
    out.capabilities = value['capabilities'] as SellerServiceConfig['capabilities'];
  }
  if (value['unitBillingModels'] !== undefined) {
    out.unitBillingModels = value['unitBillingModels'] as SellerServiceConfig['unitBillingModels'];
  }
  return out;
}

function normalizeSellerProvider(value: unknown): SellerProviderConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value['plugin'] !== 'string' || value['plugin'].trim().length === 0) return null;
  const out: SellerProviderConfig = { plugin: value['plugin'].trim(), services: {} };
  if (typeof value['baseUrl'] === 'string' && value['baseUrl'].trim().length > 0) {
    out.baseUrl = value['baseUrl'].trim();
  }
  if (typeof value['apiKeyEnv'] === 'string' && value['apiKeyEnv'].trim().length > 0) {
    out.apiKeyEnv = value['apiKeyEnv'].trim();
  }
  if (isRecord(value['pathRewrite'])) {
    const pr: Record<string, string> = {};
    for (const [k, v] of Object.entries(value['pathRewrite'])) {
      if (typeof v === 'string') pr[k] = v;
    }
    if (Object.keys(pr).length > 0) out.pathRewrite = pr;
  }
  const defaults = normalizeTokenPricing(value['defaults']);
  if (defaults) {
    out.defaults = defaults;
  }
  const rawServices = value['services'];
  if (isRecord(rawServices)) {
    for (const [serviceId, rawService] of Object.entries(rawServices)) {
      const parsed = normalizeSellerService(rawService);
      if (parsed) {
        out.services[serviceId] = parsed;
      }
    }
  }
  return out;
}

function mergeSellerProviders(
  defaults: Record<string, SellerProviderConfig>,
  value: unknown,
): Record<string, SellerProviderConfig> {
  const out: Record<string, SellerProviderConfig> = {};
  for (const [name, cfg] of Object.entries(defaults)) {
    out[name] = {
      plugin: cfg.plugin,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.apiKeyEnv ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
      ...(cfg.pathRewrite ? { pathRewrite: { ...cfg.pathRewrite } } : {}),
      ...(cfg.defaults ? { defaults: clonePricing(cfg.defaults) } : {}),
      services: { ...cfg.services },
    };
  }
  if (!isRecord(value)) return out;
  for (const [name, rawProvider] of Object.entries(value)) {
    const parsed = normalizeSellerProvider(rawProvider);
    if (parsed) {
      out[name] = parsed;
    }
  }
  return out;
}

function normalizeAgentDir(
  value: unknown,
  fallback?: string | Record<string, string>,
): { agentDir: string | Record<string, string> } | Record<string, never> {
  if (typeof value === 'string') return { agentDir: value };
  if (isRecord(value)) {
    // Per-service map: { "service-id": "./path", ... }
    const map: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string') map[key] = val;
    }
    if (Object.keys(map).length > 0) return { agentDir: map };
  }
  return fallback ? { agentDir: fallback } : {};
}

// Normalizes shape only (trim + lowercase domains). Invalid domains, unknown
// methods, duplicates, and empty arrays are preserved so validateConfig can
// reject them loudly instead of the loader silently dropping them — dropping
// a typo'd methods entry would widen the claim to "all methods".
function normalizeDomainVerification(
  value: unknown,
): DomainVerificationConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: DomainVerificationConfig[] = [];
  for (const rawClaim of value) {
    if (!isRecord(rawClaim)) continue;
    const rawDomain = rawClaim['domain'];
    const domain = typeof rawDomain === 'string' ? rawDomain.trim().toLowerCase() : '';
    const claim: DomainVerificationConfig = { domain };
    if (Array.isArray(rawClaim['methods'])) {
      claim.methods = [...rawClaim['methods']] as DomainVerificationMethod[];
    }
    out.push(claim);
  }
  return out;
}

// Same shape-only normalization contract as normalizeDomainVerification.
function normalizeGithubVerification(
  value: unknown,
): GithubVerificationConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: GithubVerificationConfig[] = [];
  for (const rawClaim of value) {
    if (!isRecord(rawClaim)) continue;
    const rawUsername = rawClaim['username'];
    const username = typeof rawUsername === 'string' ? rawUsername.trim().toLowerCase() : '';
    const claim: GithubVerificationConfig = { username };
    if (rawClaim['repository'] !== undefined) {
      claim.repository = typeof rawClaim['repository'] === 'string'
        ? rawClaim['repository'].trim().toLowerCase()
        : '';
    }
    out.push(claim);
  }
  return out;
}

function cloneVerifications(
  value: AntseedConfig['seller']['verifications'],
): AntseedConfig['seller']['verifications'] {
  if (!value) return undefined;
  const domains = value.domains
    ? value.domains.map((claim) => ({
      domain: claim.domain,
      ...(claim.methods ? { methods: [...claim.methods] } : {}),
    }))
    : undefined;
  const github = value.github
    ? value.github.map((claim) => ({
      username: claim.username,
      ...(claim.repository !== undefined ? { repository: claim.repository } : {}),
    }))
    : undefined;
  const cloned = {
    ...(domains && domains.length > 0 ? { domains } : {}),
    ...(github && github.length > 0 ? { github } : {}),
  };
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function normalizeVerifications(
  value: unknown,
  fallback?: AntseedConfig['seller']['verifications'],
): { verifications: NonNullable<AntseedConfig['seller']['verifications']> } | Record<string, never> {
  if (!isRecord(value)) {
    const cloned = cloneVerifications(fallback);
    return cloned ? { verifications: cloned } : {};
  }
  // Keep the user-supplied object (even when empty or malformed) so
  // validateConfig reports the problem instead of silently ignoring it.
  const domains = normalizeDomainVerification(value['domains']);
  const github = normalizeGithubVerification(value['github']);
  return {
    verifications: {
      ...(domains !== undefined ? { domains } : {}),
      ...(github !== undefined ? { github } : {}),
    },
  };
}

function cloneSellerHealthCheck(
  value: AntseedConfig['seller']['healthCheck'],
): AntseedConfig['seller']['healthCheck'] {
  if (!value) return undefined;
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs } : {}),
    ...(value.failureThreshold !== undefined ? { failureThreshold: value.failureThreshold } : {}),
  };
}

function normalizeSellerHealthCheck(
  value: unknown,
  fallback?: AntseedConfig['seller']['healthCheck'],
): { healthCheck: NonNullable<AntseedConfig['seller']['healthCheck']> } | Record<string, never> {
  if (!isRecord(value)) {
    const cloned = cloneSellerHealthCheck(fallback);
    return cloned ? { healthCheck: cloned } : {};
  }
  // Keep user-supplied values (even malformed) so validateConfig reports them.
  return {
    healthCheck: {
      ...(value['enabled'] !== undefined ? { enabled: value['enabled'] as boolean } : {}),
      ...(value['intervalMs'] !== undefined ? { intervalMs: toFiniteOrNaN(value['intervalMs']) } : {}),
      ...(value['failureThreshold'] !== undefined ? { failureThreshold: toFiniteOrNaN(value['failureThreshold']) } : {}),
    },
  };
}

function cloneSellerGasCheck(
  value: AntseedConfig['seller']['gasCheck'],
): AntseedConfig['seller']['gasCheck'] {
  if (!value) return undefined;
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.intervalMs !== undefined ? { intervalMs: value.intervalMs } : {}),
    ...(value.minBalanceEth !== undefined ? { minBalanceEth: value.minBalanceEth } : {}),
  };
}

function normalizeSellerGasCheck(
  value: unknown,
  fallback?: AntseedConfig['seller']['gasCheck'],
): { gasCheck: NonNullable<AntseedConfig['seller']['gasCheck']> } | Record<string, never> {
  if (!isRecord(value)) {
    const cloned = cloneSellerGasCheck(fallback);
    return cloned ? { gasCheck: cloned } : {};
  }
  // Keep user-supplied values (even malformed) so validateConfig reports them.
  return {
    gasCheck: {
      ...(value['enabled'] !== undefined ? { enabled: value['enabled'] as boolean } : {}),
      ...(value['intervalMs'] !== undefined ? { intervalMs: toFiniteOrNaN(value['intervalMs']) } : {}),
      ...(value['minBalanceEth'] !== undefined ? { minBalanceEth: toFiniteOrNaN(value['minBalanceEth']) } : {}),
    },
  };
}

function cloneSellerFreeTier(
  value: AntseedConfig['seller']['freeTier'],
): AntseedConfig['seller']['freeTier'] {
  if (!value) return undefined;
  return {
    ...(value.maxRequestsPerAddress !== undefined ? { maxRequestsPerAddress: value.maxRequestsPerAddress } : {}),
    ...(value.maxRequestsPerIp !== undefined ? { maxRequestsPerIp: value.maxRequestsPerIp } : {}),
    ...(value.windowMs !== undefined ? { windowMs: value.windowMs } : {}),
  };
}

function normalizeSellerFreeTier(
  value: unknown,
  fallback?: AntseedConfig['seller']['freeTier'],
): { freeTier: NonNullable<AntseedConfig['seller']['freeTier']> } | Record<string, never> {
  if (!isRecord(value)) {
    const cloned = cloneSellerFreeTier(fallback);
    return cloned ? { freeTier: cloned } : {};
  }
  return {
    freeTier: {
      ...(value['maxRequestsPerAddress'] !== undefined
        ? { maxRequestsPerAddress: toFiniteOrNaN(value['maxRequestsPerAddress']) }
        : {}),
      ...(value['maxRequestsPerIp'] !== undefined
        ? { maxRequestsPerIp: toFiniteOrNaN(value['maxRequestsPerIp']) }
        : {}),
      ...(value['windowMs'] !== undefined ? { windowMs: toFiniteOrNaN(value['windowMs']) } : {}),
    },
  };
}

function mergeSellerConfig(
  defaults: AntseedConfig['seller'],
  value: unknown
): AntseedConfig['seller'] {
  if (!isRecord(value)) {
    return {
      reserveFloor: defaults.reserveFloor,
      maxConcurrentBuyers: defaults.maxConcurrentBuyers,
      providers: mergeSellerProviders(defaults.providers, undefined),
      publicAddress: defaults.publicAddress,
      ...(typeof defaults.maxUploadBodyBytes === 'number' ? { maxUploadBodyBytes: defaults.maxUploadBodyBytes } : {}),
      ...(defaults.agentDir ? { agentDir: defaults.agentDir } : {}),
      ...(normalizeVerifications(undefined, defaults.verifications)),
      ...(normalizeSellerHealthCheck(undefined, defaults.healthCheck)),
      ...(normalizeSellerGasCheck(undefined, defaults.gasCheck)),
      ...(normalizeSellerFreeTier(undefined, defaults.freeTier)),
    };
  }

  return {
    reserveFloor: typeof value['reserveFloor'] === 'number'
      ? value['reserveFloor']
      : defaults.reserveFloor,
    maxConcurrentBuyers: typeof value['maxConcurrentBuyers'] === 'number'
      ? value['maxConcurrentBuyers']
      : defaults.maxConcurrentBuyers,
    providers: mergeSellerProviders(defaults.providers, value['providers']),
    publicAddress: typeof value['publicAddress'] === 'string'
      ? value['publicAddress']
      : defaults.publicAddress,
    ...(normalizeVerifications(value['verifications'], defaults.verifications)),
    ...(typeof value['maxUploadBodyBytes'] === 'number'
      ? { maxUploadBodyBytes: value['maxUploadBodyBytes'] }
      : typeof defaults.maxUploadBodyBytes === 'number'
        ? { maxUploadBodyBytes: defaults.maxUploadBodyBytes }
        : {}),
    ...(normalizeAgentDir(value['agentDir'], defaults.agentDir)),
    ...(normalizeSellerHealthCheck(value['healthCheck'], defaults.healthCheck)),
    ...(normalizeSellerGasCheck(value['gasCheck'], defaults.gasCheck)),
    ...(normalizeSellerFreeTier(value['freeTier'], defaults.freeTier)),
  };
}

function normalizeMinPeerReputation(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value === 50 ? fallback : value;
}

function normalizeRoutingPeerIds(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) return [String(value)];
  return value.map((entry) => String(entry));
}

function cloneRoutingPreferences(value: ModelRoutingPreferences): ModelRoutingPreferences {
  return {
    ...value,
    allowedPeerIds: [...value.allowedPeerIds],
    blockedPeerIds: [...value.blockedPeerIds],
  };
}

function mergeBuyerRoutingPreferences(
  fallback: ModelRoutingPreferences,
  value: unknown,
): ModelRoutingPreferences {
  if (!isRecord(value)) {
    return cloneRoutingPreferences(fallback);
  }

  const preferFreePeers = value['preferFreePeers'];
  const maxInputUsdPerMillion = value['maxInputUsdPerMillion'];
  const minTrustScore = value['minTrustScore'];
  return {
    preferFreePeers: preferFreePeers === undefined
      ? fallback.preferFreePeers
      : preferFreePeers as boolean,
    maxInputUsdPerMillion: maxInputUsdPerMillion === undefined
      ? fallback.maxInputUsdPerMillion
      : toFiniteOrNaN(maxInputUsdPerMillion),
    minTrustScore: minTrustScore === undefined
      ? fallback.minTrustScore
      : toFiniteOrNaN(minTrustScore),
    allowedPeerIds: normalizeRoutingPeerIds(value['allowedPeerIds'], fallback.allowedPeerIds),
    blockedPeerIds: normalizeRoutingPeerIds(value['blockedPeerIds'], fallback.blockedPeerIds),
  };
}

function cloneBuyerVerification(
  value: AntseedConfig['buyer']['verification'],
): AntseedConfig['buyer']['verification'] {
  if (!value) return undefined;
  return {
    ...(value.sampleRate !== undefined ? { sampleRate: value.sampleRate } : {}),
    ...(value.maxSampleBytes !== undefined ? { maxSampleBytes: value.maxSampleBytes } : {}),
  };
}

function normalizeBuyerVerification(
  value: unknown,
  fallback?: AntseedConfig['buyer']['verification'],
): { verification: NonNullable<AntseedConfig['buyer']['verification']> } | Record<string, never> {
  if (!isRecord(value)) {
    const cloned = cloneBuyerVerification(fallback);
    return cloned ? { verification: cloned } : {};
  }
  return {
    verification: {
      ...(value['sampleRate'] !== undefined ? { sampleRate: toFiniteOrNaN(value['sampleRate']) } : {}),
      ...(value['maxSampleBytes'] !== undefined ? { maxSampleBytes: toFiniteOrNaN(value['maxSampleBytes']) } : {}),
    },
  };
}

function mergeBuyerConfig(
  defaults: AntseedConfig['buyer'],
  value: unknown
): AntseedConfig['buyer'] {
  const defaultRoutingPreferences = defaults.routingPreferences ?? DEFAULT_MODEL_ROUTING_PREFERENCES;
  if (!isRecord(value)) {
    return {
      maxPricing: mergeHierarchicalPricing(defaults.maxPricing, undefined),
      minPeerReputation: defaults.minPeerReputation,
      routingPreferences: cloneRoutingPreferences(defaultRoutingPreferences),
      proxyPort: defaults.proxyPort,
      peerRefreshIntervalMs: defaults.peerRefreshIntervalMs,
      metadataFetchTimeoutMs: defaults.metadataFetchTimeoutMs,
      requestTimeoutMs: defaults.requestTimeoutMs,
      maxStreamDurationMs: defaults.maxStreamDurationMs,
      disableMetadataV2Services: defaults.disableMetadataV2Services,
      autoSweep: defaults.autoSweep,
      ...(normalizeBuyerVerification(undefined, defaults.verification)),
    };
  }
  return {
    maxPricing: mergeHierarchicalPricing(defaults.maxPricing, value['maxPricing']),
    minPeerReputation: normalizeMinPeerReputation(value['minPeerReputation'], defaults.minPeerReputation),
    routingPreferences: mergeBuyerRoutingPreferences(
      defaultRoutingPreferences,
      value['routingPreferences'],
    ),
    proxyPort: typeof value['proxyPort'] === 'number'
      ? value['proxyPort']
      : defaults.proxyPort,
    peerRefreshIntervalMs: typeof value['peerRefreshIntervalMs'] === 'number'
      ? value['peerRefreshIntervalMs']
      : defaults.peerRefreshIntervalMs,
    metadataFetchTimeoutMs: typeof value['metadataFetchTimeoutMs'] === 'number'
      ? value['metadataFetchTimeoutMs']
      : defaults.metadataFetchTimeoutMs,
    requestTimeoutMs: typeof value['requestTimeoutMs'] === 'number'
      ? value['requestTimeoutMs']
      : defaults.requestTimeoutMs,
    maxStreamDurationMs: typeof value['maxStreamDurationMs'] === 'number'
      ? value['maxStreamDurationMs']
      : defaults.maxStreamDurationMs,
    disableMetadataV2Services: normalizeBooleanConfigValue(
      value['disableMetadataV2Services'],
      defaults.disableMetadataV2Services,
      'buyer.disableMetadataV2Services',
    ),
    autoSweep: normalizeBooleanConfigValue(
      value['autoSweep'],
      defaults.autoSweep ?? true,
      'buyer.autoSweep',
    ),
    ...(normalizeBuyerVerification(value['verification'], defaults.verification)),
  };
}

function normalizeBooleanConfigValue(value: unknown, defaultValue: boolean, path: string): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  throw new Error(`${path} must be a boolean`);
}

/**
 * Load configuration from a JSON file.
 * Returns default configuration if the file does not exist.
 */
export async function loadConfig(configPath: string): Promise<AntseedConfig> {
  const resolved = resolveConfigPath(configPath);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return createDefaultConfig();
    }
    throw err;
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch {
    console.warn(`Warning: Could not parse config at ${resolved}. Using defaults.`);
    return createDefaultConfig();
  }

  const defaults = createDefaultConfig();
  const parsed = isRecord(parsedRaw) ? parsedRaw : {};

  const merged: AntseedConfig = {
    ...defaults,
    ...(parsed as Partial<AntseedConfig>),
    identity: {
      ...defaults.identity,
      ...(isRecord(parsed['identity']) ? parsed['identity'] : {}),
    },
    seller: mergeSellerConfig(defaults.seller, parsed['seller']),
    buyer: mergeBuyerConfig(defaults.buyer, parsed['buyer']),
    payments: {
      ...defaults.payments,
      ...(isRecord(parsed['payments']) ? parsed['payments'] : {}),
    },
    network: {
      ...defaults.network,
      ...(isRecord(parsed['network']) ? parsed['network'] : {}),
    },
  };

  assertValidConfig(merged);
  return merged;
}

/**
 * Save configuration to a JSON file.
 * Creates the directory if it doesn't exist.
 */
export async function saveConfig(configPath: string, config: AntseedConfig): Promise<void> {
  const resolved = resolveConfigPath(configPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(config, null, 2), 'utf-8');
}
