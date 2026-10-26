import type {
  DomainVerificationConfig,
  DomainVerificationMethod,
  GithubVerificationConfig,
  HierarchicalPricingConfig,
  AntseedConfig,
  SellerFreeTierCLIConfig,
  SellerProviderConfig,
  TokenPricingUsdPerMillion,
} from './types.js';
import { MAX_FREE_TIER_DELEGATIONS, SellerFreeTierLimiter, validateFreeTierStakeTiers } from '@antseed/node';
import { validateServiceMetadata } from './service-metadata.js';
import { parseHostPort } from './public-address.js';
import { appendVerifierConfigErrors } from '../verifier/config-schema.js';

const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_PUBLIC_ADDRESS_LENGTH = 255;
const MAX_DOMAIN_VERIFICATION_CLAIMS = 5;
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_VERIFICATION_METHODS = new Set<DomainVerificationMethod>(['dns-txt', 'https-well-known']);
const MAX_GITHUB_VERIFICATION_CLAIMS = 5;
const MAX_GITHUB_USERNAME_LENGTH = 39;
const MAX_GITHUB_REPOSITORY_LENGTH = 100;
const GITHUB_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]+$/;
const VERIFICATION_NAMESPACES = new Set(['domains', 'github']);
const MIN_SELLER_UPLOAD_BODY_BYTES = 1024 * 1024;
const MIN_BUYER_PEER_REFRESH_INTERVAL_MS = 1_000;
export const MIN_BUYER_METADATA_FETCH_TIMEOUT_MS = 100;
export const MIN_BUYER_MAX_STREAM_DURATION_MS = 1;
const PEER_ID_PATTERN = /^(?:0x)?[0-9a-f]{40}$/i;

function validatePricingLeaf(
  path: string,
  value: TokenPricingUsdPerMillion,
  errors: string[]
): void {
  if (!Number.isFinite(value.inputUsdPerMillion) || value.inputUsdPerMillion < 0) {
    errors.push(`${path}.inputUsdPerMillion must be a non-negative finite number`);
  }
  if (!Number.isFinite(value.outputUsdPerMillion) || value.outputUsdPerMillion < 0) {
    errors.push(`${path}.outputUsdPerMillion must be a non-negative finite number`);
  }
  if (value.cachedInputUsdPerMillion != null && (!Number.isFinite(value.cachedInputUsdPerMillion) || value.cachedInputUsdPerMillion < 0)) {
    errors.push(`${path}.cachedInputUsdPerMillion must be a non-negative finite number`);
  }
}

function validateHierarchicalPricing(
  path: string,
  pricing: HierarchicalPricingConfig,
  errors: string[]
): void {
  validatePricingLeaf(`${path}.defaults`, pricing.defaults, errors);
}

function validateCategoryList(
  path: string,
  tags: string[] | undefined,
  errors: string[],
): void {
  if (!tags) return;
  if (!Array.isArray(tags) || tags.length === 0) {
    errors.push(`${path} must be a non-empty string array when provided`);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < tags.length; i += 1) {
    const rawTag = tags[i];
    if (typeof rawTag !== 'string') {
      errors.push(`${path}[${i}] must be a string`);
      continue;
    }
    const tag = rawTag.trim().toLowerCase();
    if (tag.length === 0) {
      errors.push(`${path}[${i}] must not be empty`);
      continue;
    }
    if (!SERVICE_CATEGORY_PATTERN.test(tag)) {
      errors.push(`${path}[${i}] must use lowercase letters, digits, or hyphen`);
    }
    if (seen.has(tag)) {
      errors.push(`${path}[${i}] is duplicated`);
    }
    seen.add(tag);
  }
}

function validateFallbackUpstreams(
  path: string,
  providerCfg: SellerProviderConfig,
  errors: string[],
): void {
  for (const [index, fallback] of (providerCfg.fallbackUpstreams ?? []).entries()) {
    const fallbackPath = `${path}[${index}]`;
    if (!/^https?:\/\//i.test(fallback.baseUrl) || !URL.canParse(fallback.baseUrl)) {
      errors.push(`${fallbackPath}.baseUrl must be an http(s) URL`);
    }
    if (fallback.apiKeyEnv !== undefined && fallback.apiKeyEnv.length === 0) {
      errors.push(`${fallbackPath}.apiKeyEnv must be a non-empty string when provided`);
    }
    if (fallback.services === undefined) continue;
    if (Object.keys(fallback.services).length === 0) {
      errors.push(`${fallbackPath}.services must list at least one service when provided`);
    }
    for (const [serviceId, serviceCfg] of Object.entries(fallback.services)) {
      if (!(serviceId in providerCfg.services)) {
        errors.push(`${fallbackPath}.services.${serviceId} is not a service of this provider`);
      }
      if (serviceCfg.upstreamModel !== undefined && serviceCfg.upstreamModel.length === 0) {
        errors.push(`${fallbackPath}.services.${serviceId}.upstreamModel must be a non-empty string when provided`);
      }
    }
  }
}

function validateSellerProviders(
  path: string,
  providers: Record<string, SellerProviderConfig>,
  errors: string[],
): void {
  for (const [providerName, providerCfg] of Object.entries(providers)) {
    const providerPath = `${path}.${providerName}`;
    if (typeof providerCfg.plugin !== 'string' || providerCfg.plugin.trim().length === 0) {
      errors.push(`${providerPath}.plugin must be a non-empty string`);
    }
    if (providerCfg.defaults) {
      validatePricingLeaf(`${providerPath}.defaults`, providerCfg.defaults, errors);
    }
    if (providerCfg.baseUrl !== undefined) {
      try {
        // eslint-disable-next-line no-new
        new URL(providerCfg.baseUrl);
      } catch {
        errors.push(`${providerPath}.baseUrl must be a valid URL`);
      }
    }
    validateFallbackUpstreams(`${providerPath}.fallbackUpstreams`, providerCfg, errors);
    for (const [serviceId, serviceCfg] of Object.entries(providerCfg.services)) {
      const servicePath = `${providerPath}.services.${serviceId}`;
      if (serviceCfg.upstreamModel !== undefined && serviceCfg.upstreamModel.trim().length === 0) {
        errors.push(`${servicePath}.upstreamModel must be a non-empty string when provided`);
      }
      if (serviceCfg.pricing) {
        validatePricingLeaf(`${servicePath}.pricing`, serviceCfg.pricing, errors);
      }
      validateCategoryList(`${servicePath}.categories`, serviceCfg.categories, errors);
      errors.push(...validateServiceMetadata(servicePath, serviceCfg));
    }
  }
}

function parsePublicAddress(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PUBLIC_ADDRESS_LENGTH) {
    return null;
  }
  return parseHostPort(trimmed);
}

function isValidDomainName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false;
  if (value.includes('..') || value.endsWith('.')) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => DOMAIN_LABEL_PATTERN.test(label));
}

function validateDomainVerification(
  path: string,
  claims: DomainVerificationConfig[] | undefined,
  errors: string[],
): void {
  if (claims === undefined) return;
  if (!Array.isArray(claims)) {
    errors.push(`${path} must be an array when provided`);
    return;
  }
  if (claims.length === 0) {
    errors.push(`${path} must be a non-empty array when provided`);
    return;
  }
  if (claims.length > MAX_DOMAIN_VERIFICATION_CLAIMS) {
    errors.push(`${path} must contain at most ${MAX_DOMAIN_VERIFICATION_CLAIMS} claims`);
  }
  const domains = new Set<string>();
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    const claimPath = `${path}[${i}]`;
    const domain = typeof claim?.domain === 'string' ? claim.domain.trim().toLowerCase() : '';
    if (!isValidDomainName(domain)) {
      errors.push(`${claimPath}.domain must be a lower-case hostname with at least two labels`);
    } else if (domains.has(domain)) {
      errors.push(`${claimPath}.domain is duplicated`);
    }
    domains.add(domain);

    if (claim?.methods !== undefined) {
      if (!Array.isArray(claim.methods) || claim.methods.length === 0) {
        errors.push(`${claimPath}.methods must be a non-empty array when provided`);
      } else {
        const methods = new Set<string>();
        for (let j = 0; j < claim.methods.length; j += 1) {
          const method = claim.methods[j];
          if (typeof method !== 'string' || !DOMAIN_VERIFICATION_METHODS.has(method as DomainVerificationMethod)) {
            errors.push(`${claimPath}.methods[${j}] must be "dns-txt" or "https-well-known"`);
            continue;
          }
          if (methods.has(method)) {
            errors.push(`${claimPath}.methods[${j}] is duplicated`);
          }
          methods.add(method);
        }
      }
    }
  }
}

function validateGithubVerification(
  path: string,
  claims: GithubVerificationConfig[] | undefined,
  errors: string[],
): void {
  if (claims === undefined) return;
  if (!Array.isArray(claims)) {
    errors.push(`${path} must be an array when provided`);
    return;
  }
  if (claims.length === 0) {
    errors.push(`${path} must be a non-empty array when provided`);
    return;
  }
  if (claims.length > MAX_GITHUB_VERIFICATION_CLAIMS) {
    errors.push(`${path} must contain at most ${MAX_GITHUB_VERIFICATION_CLAIMS} claims`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    const claimPath = `${path}[${i}]`;
    const username = typeof claim?.username === 'string' ? claim.username.trim().toLowerCase() : '';
    if (
      username.length === 0
      || username.length > MAX_GITHUB_USERNAME_LENGTH
      || username.includes('--')
      || !GITHUB_USERNAME_PATTERN.test(username)
    ) {
      errors.push(`${claimPath}.username must be a valid GitHub username`);
    }
    const rawRepository = claim?.repository;
    let repository = '';
    if (rawRepository !== undefined) {
      repository = typeof rawRepository === 'string' ? rawRepository.trim().toLowerCase() : '';
      if (
        repository.length === 0
        || repository.length > MAX_GITHUB_REPOSITORY_LENGTH
        || repository === '.'
        || repository === '..'
        || !GITHUB_REPOSITORY_PATTERN.test(repository)
      ) {
        errors.push(`${claimPath}.repository must be a valid GitHub repository name`);
      }
    }
    const key = `${username}/${repository}`;
    if (seen.has(key)) {
      errors.push(`${claimPath} is duplicated`);
    }
    seen.add(key);
  }
}

function validateVerifications(
  path: string,
  verifications: AntseedConfig['seller']['verifications'],
  errors: string[],
): void {
  if (verifications === undefined) return;
  if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  validateDomainVerification(`${path}.domains`, verifications.domains, errors);
  validateGithubVerification(`${path}.github`, verifications.github, errors);
  const unknownKeys = Object.keys(verifications).filter((key) => !VERIFICATION_NAMESPACES.has(key));
  for (const key of unknownKeys) {
    errors.push(`${path}.${key} is not a supported verification namespace`);
  }
  if (verifications.domains === undefined && verifications.github === undefined && unknownKeys.length === 0) {
    errors.push(`${path} must include at least one verification namespace when provided`);
  }
}

function validateBuyerVerifier(
  path: string,
  verifier: AntseedConfig['buyer']['verifier'],
  errors: string[],
): void {
  if (verifier === undefined) return;
  if (!verifier || typeof verifier !== 'object' || Array.isArray(verifier)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  for (const key of ['enabled', 'require'] as const) {
    if (verifier[key] !== undefined && typeof verifier[key] !== 'boolean') errors.push(`${path}.${key} must be a boolean`);
  }
  if (verifier.prefer !== undefined && (!Array.isArray(verifier.prefer) || verifier.prefer.some((id) => typeof id !== 'string' || id.trim() === ''))) {
    errors.push(`${path}.prefer must be a list of verifier ids`);
  }
  if (verifier.enabled === false && (verifier.require || (verifier.prefer?.length ?? 0) > 0)) {
    errors.push(`${path}.enabled cannot be false while require or prefer is set`);
  }
}

function validateBuyerVerification(
  path: string,
  verification: AntseedConfig['buyer']['verification'],
  errors: string[],
): void {
  if (verification === undefined) return;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  if (
    verification.sampleRate !== undefined &&
    (!Number.isFinite(verification.sampleRate) || verification.sampleRate < 0 || verification.sampleRate > 1)
  ) {
    errors.push(`${path}.sampleRate must be a number in range 0-1`);
  }
  if (
    verification.maxSampleBytes !== undefined &&
    (!Number.isInteger(verification.maxSampleBytes) || verification.maxSampleBytes < 1)
  ) {
    errors.push(`${path}.maxSampleBytes must be an integer >= 1`);
  }
}

/**
 * Validate the full config and return all issues.
 */
export function validateConfig(config: AntseedConfig): string[] {
  const errors: string[] = [];

  validateSellerProviders('seller.providers', config.seller.providers, errors);
  validateHierarchicalPricing('buyer.maxPricing', config.buyer.maxPricing, errors);

  if (!Number.isFinite(config.buyer.minPeerReputation) || config.buyer.minPeerReputation < 0 || config.buyer.minPeerReputation > 100) {
    errors.push('buyer.minPeerReputation must be in range 0-100');
  }

  const routingPreferences = config.buyer.routingPreferences;
  if (typeof routingPreferences.preferFreePeers !== 'boolean') {
    errors.push('buyer.routingPreferences.preferFreePeers must be a boolean');
  }
  if (!Number.isFinite(routingPreferences.maxInputUsdPerMillion) || routingPreferences.maxInputUsdPerMillion < 0) {
    errors.push('buyer.routingPreferences.maxInputUsdPerMillion must be a non-negative finite number');
  }
  if (!Number.isFinite(routingPreferences.minTrustScore) || routingPreferences.minTrustScore < 0 || routingPreferences.minTrustScore > 100) {
    errors.push('buyer.routingPreferences.minTrustScore must be in range 0-100');
  }
  for (const key of ['allowedPeerIds', 'blockedPeerIds'] as const) {
    const peerIds = routingPreferences[key];
    if (!Array.isArray(peerIds) || peerIds.some((peerId) => typeof peerId !== 'string' || !PEER_ID_PATTERN.test(peerId.trim()))) {
      errors.push(`buyer.routingPreferences.${key} must contain only 40-character hex peer IDs`);
    }
  }

  if (!Number.isInteger(config.buyer.proxyPort) || config.buyer.proxyPort < 1 || config.buyer.proxyPort > 65535) {
    errors.push('buyer.proxyPort must be an integer in range 1-65535');
  }

  if (!Number.isInteger(config.buyer.peerRefreshIntervalMs) || config.buyer.peerRefreshIntervalMs < MIN_BUYER_PEER_REFRESH_INTERVAL_MS) {
    errors.push('buyer.peerRefreshIntervalMs must be an integer >= 1000');
  }

  if (!Number.isInteger(config.buyer.metadataFetchTimeoutMs) || config.buyer.metadataFetchTimeoutMs < MIN_BUYER_METADATA_FETCH_TIMEOUT_MS) {
    errors.push('buyer.metadataFetchTimeoutMs must be an integer >= 100');
  }

  if (!Number.isInteger(config.buyer.requestTimeoutMs) || config.buyer.requestTimeoutMs < 1) {
    errors.push('buyer.requestTimeoutMs must be an integer >= 1');
  }

  if (!Number.isInteger(config.buyer.maxStreamDurationMs) || config.buyer.maxStreamDurationMs < MIN_BUYER_MAX_STREAM_DURATION_MS) {
    errors.push('buyer.maxStreamDurationMs must be an integer >= 1');
  }

  if (typeof config.buyer.disableMetadataV2Services !== 'boolean') {
    errors.push('buyer.disableMetadataV2Services must be a boolean');
  }

  validateBuyerVerification('buyer.verification', config.buyer.verification, errors);
  validateBuyerVerifier('buyer.verifier', config.buyer.verifier, errors);
  validateFreeTierDelegations(config.buyer.freeTierDelegations, errors);

  if (!Number.isInteger(config.seller.maxConcurrentBuyers) || config.seller.maxConcurrentBuyers < 1) {
    errors.push('seller.maxConcurrentBuyers must be an integer >= 1');
  }

  if (!Number.isFinite(config.seller.reserveFloor) || config.seller.reserveFloor < 0) {
    errors.push('seller.reserveFloor must be a non-negative finite number');
  }

  if (
    config.seller.maxUploadBodyBytes !== undefined &&
    (!Number.isInteger(config.seller.maxUploadBodyBytes) || config.seller.maxUploadBodyBytes < MIN_SELLER_UPLOAD_BODY_BYTES)
  ) {
    errors.push('seller.maxUploadBodyBytes must be an integer >= 1048576');
  }

  if (config.seller.agentDir !== undefined) {
    if (typeof config.seller.agentDir === 'string') {
      if (config.seller.agentDir.trim().length === 0) {
        errors.push('seller.agentDir must be a non-empty string when provided');
      }
    } else {
      const map = config.seller.agentDir as Record<string, string>;
      if (Object.keys(map).length === 0) {
        errors.push('seller.agentDir map must have at least one entry when provided');
      }
      for (const [svc, dir] of Object.entries(map)) {
        if (typeof dir !== 'string' || dir.trim().length === 0) {
          errors.push(`seller.agentDir["${svc}"] must be a non-empty string`);
        }
      }
    }
  }

  if (config.seller.publicAddress) {
    const raw = config.seller.publicAddress.trim();
    if (parsePublicAddress(raw) === null) {
      errors.push('seller.publicAddress must be in the form "host:port" with a valid port');
    }
  }

  if (config.seller.healthCheck !== undefined) {
    const healthCheck = config.seller.healthCheck;
    if (healthCheck.enabled !== undefined && typeof healthCheck.enabled !== 'boolean') {
      errors.push('seller.healthCheck.enabled must be a boolean');
    }
    if (
      healthCheck.intervalMs !== undefined &&
      (!Number.isInteger(healthCheck.intervalMs) || healthCheck.intervalMs < 60_000)
    ) {
      errors.push('seller.healthCheck.intervalMs must be an integer >= 60000 (1 minute)');
    }
    if (
      healthCheck.failureThreshold !== undefined &&
      (!Number.isInteger(healthCheck.failureThreshold) || healthCheck.failureThreshold < 1)
    ) {
      errors.push('seller.healthCheck.failureThreshold must be an integer >= 1');
    }
  }

  if (config.seller.gasCheck !== undefined) {
    const gasCheck = config.seller.gasCheck;
    if (gasCheck.enabled !== undefined && typeof gasCheck.enabled !== 'boolean') {
      errors.push('seller.gasCheck.enabled must be a boolean');
    }
    if (
      gasCheck.intervalMs !== undefined &&
      (!Number.isInteger(gasCheck.intervalMs) || gasCheck.intervalMs < 10_000)
    ) {
      errors.push('seller.gasCheck.intervalMs must be an integer >= 10000 (10 seconds)');
    }
    if (
      gasCheck.minBalanceEth !== undefined &&
      (typeof gasCheck.minBalanceEth !== 'number' || !Number.isFinite(gasCheck.minBalanceEth) || gasCheck.minBalanceEth < 0)
    ) {
      errors.push('seller.gasCheck.minBalanceEth must be a finite number >= 0');
    }
  }

  if (config.seller.freeTier !== undefined) {
    validateFreeTierProgram('seller.freeTier', config.seller.freeTier, errors);
  }
  // Free-tier programs are keyed by announced service id, so one id needs one program.
  const serviceFreeTiers = new Map<string, string>();
  for (const [providerName, providerCfg] of Object.entries(config.seller.providers)) {
    for (const [serviceId, serviceCfg] of Object.entries(providerCfg.services)) {
      if (serviceCfg.freeTier === undefined) continue;
      const path = `seller.providers.${providerName}.services.${serviceId}.freeTier`;
      validateFreeTierProgram(path, serviceCfg.freeTier, errors, serviceId);
      const program = JSON.stringify(serviceCfg.freeTier);
      const previous = serviceFreeTiers.get(serviceId);
      if (previous !== undefined && previous !== program) {
        errors.push(`${path} differs from another provider's freeTier for service "${serviceId}"`);
      }
      serviceFreeTiers.set(serviceId, program);
    }
  }

  const restrictedCountries = config.seller.restrictedCountries;
  if (
    restrictedCountries !== undefined &&
    (!Array.isArray(restrictedCountries) || !restrictedCountries.every((code) => /^[A-Z]{2}$/.test(String(code))))
  ) {
    errors.push('seller.restrictedCountries must be an array of 2-letter uppercase ISO country codes');
  }

  if (config.seller.freeUsage !== undefined) {
    const { recordBatchSize, recordFlushIntervalMs } = config.seller.freeUsage;
    if (recordBatchSize !== undefined && (!Number.isSafeInteger(recordBatchSize) || recordBatchSize < 1)) {
      errors.push('seller.freeUsage.recordBatchSize must be a positive safe integer');
    }
    if (recordFlushIntervalMs !== undefined && (!Number.isSafeInteger(recordFlushIntervalMs) || recordFlushIntervalMs < 1_000)) {
      errors.push('seller.freeUsage.recordFlushIntervalMs must be a safe integer >= 1000');
    }
  }

  validateVerifications('seller.verifications', config.seller.verifications, errors);

  appendVerifierConfigErrors('verifier', config.verifier, errors);

  if (config.relayer !== undefined) {
    if (config.relayer.enabled !== undefined && typeof config.relayer.enabled !== 'boolean') {
      errors.push('relayer.enabled must be a boolean');
    }
    if (config.relayer.minProfitBaseUnits !== undefined && !/^-?[0-9]+$/.test(config.relayer.minProfitBaseUnits)) {
      errors.push('relayer.minProfitBaseUnits must be an integer string (USDC base units, may be negative)');
    }
    if (config.relayer.maxInFlight !== undefined && (!Number.isInteger(config.relayer.maxInFlight) || config.relayer.maxInFlight < 1)) {
      errors.push('relayer.maxInFlight must be an integer >= 1');
    }
    if (config.relayer.maxPerPeerPerMinute !== undefined && (!Number.isInteger(config.relayer.maxPerPeerPerMinute) || config.relayer.maxPerPeerPerMinute < 1)) {
      errors.push('relayer.maxPerPeerPerMinute must be an integer >= 1');
    }
  }

  return errors;
}

/**
 * Assert that config is valid. Throws with all discovered violations.
 */
export function assertValidConfig(config: AntseedConfig): void {
  const errors = validateConfig(config);
  if (errors.length === 0) return;

  throw new Error(`Invalid config:\n- ${errors.join('\n- ')}`);
}

function validateFreeTierDelegations(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  const path = 'buyer.freeTierDelegations';
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  const perBuyer = new Map<string, number>();
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { staker, buyer, expiresAt, signature } = entry as Record<string, unknown>;
    for (const [key, address] of [['staker', staker], ['buyer', buyer]] as const) {
      if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) errors.push(`${at}.${key} must be an address`);
    }
    if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 1) errors.push(`${at}.expiresAt must be a Unix time in seconds`);
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) errors.push(`${at}.signature must be a 65-byte hex signature`);
    if (typeof buyer === 'string') perBuyer.set(buyer.toLowerCase(), (perBuyer.get(buyer.toLowerCase()) ?? 0) + 1);
  });
  for (const [buyer, count] of perBuyer) {
    if (count > MAX_FREE_TIER_DELEGATIONS) errors.push(`${path} has ${count} delegations for ${buyer}; at most ${MAX_FREE_TIER_DELEGATIONS} count`);
  }
}

function validateFreeTierProgram(path: string, freeTier: SellerFreeTierCLIConfig, errors: string[], serviceId?: string): void {
  const errorsBefore = errors.length;
  if (freeTier.maxRequestsPerAddress === undefined && freeTier.maxRequestsPerIp === undefined) {
    errors.push(`${path} requires maxRequestsPerAddress and/or maxRequestsPerIp`);
  }
  for (const key of ['maxRequestsPerAddress', 'maxRequestsPerIp'] as const) {
    const limit = freeTier[key];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      errors.push(`${path}.${key} must be a positive safe integer`);
    }
  }
  if (
    freeTier.windowMs !== undefined &&
    (!Number.isSafeInteger(freeTier.windowMs) || freeTier.windowMs < 1_000)
  ) {
    errors.push(`${path}.windowMs must be a safe integer >= 1000`);
  }
  if (freeTier.stakeTiers !== undefined) {
    try {
      validateFreeTierStakeTiers(freeTier.stakeTiers, `${path}.stakeTiers`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (freeTier.stakersOnly !== undefined && typeof freeTier.stakersOnly !== 'boolean') {
    errors.push(`${path}.stakersOnly must be a boolean`);
  } else if (freeTier.stakersOnly && freeTier.stakeTiers?.length === 0) {
    errors.push(`${path}.stakersOnly requires at least one stake tier`);
  }
  if (errors.length > errorsBefore) return;
  // Otherwise valid limits can still be too long to advertise in peer metadata.
  try {
    new SellerFreeTierLimiter(serviceId === undefined ? freeTier : { services: { [serviceId]: freeTier } });
  } catch {
    errors.push(`${path} is too large to advertise in peer metadata: lower its limits or window`);
  }
}
