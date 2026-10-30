import type { PeerId } from './peer-id.js';
import type { PeerOffering } from './capability.js';
import type { ServiceUnitBillingModelsV1 } from './billing.js';
import type {
  ProviderPricingMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceHealthMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
} from './peer-pricing.js';
import {
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  type ServiceApiProtocol,
} from './service-api.js';

/** Newest metadata version this build signs and understands. */
export const METADATA_VERSION = 13;
/** Oldest announced metadata version buyers still accept from sellers. */
export const MIN_SUPPORTED_METADATA_VERSION = 10;
/**
 * Version a seller serves when the buyer does not say which versions it
 * understands. Buyers released before version negotiation send no header and
 * reject anything newer than v12, so this stays at 12 until they are gone.
 */
export const LEGACY_METADATA_VERSION = 12;
/**
 * Request header a buyer sends on `GET /metadata` with the newest metadata
 * version it understands. Sellers answer with the newest version they sign
 * that is not newer than this.
 */
export const METADATA_VERSION_HEADER = "x-antseed-metadata-version";
export const SERVICE_UNIT_BILLING_METADATA_VERSION = 11;
export const SERVICE_CAPABILITIES_METADATA_VERSION = 12;
export const SERVICE_HEALTH_METADATA_VERSION = 13;
export const WELL_KNOWN_SERVICE_CATEGORIES = [
  "privacy",
  "legal",
  "uncensored",
  "coding",
  "finance",
  "tee",
] as const;
export { WELL_KNOWN_SERVICE_API_PROTOCOLS };
export type { ServiceApiProtocol };

export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

export const SERVICE_CAPABILITY_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export type ServiceCapabilityModality = (typeof SERVICE_CAPABILITY_MODALITIES)[number];
export const VIDEO_INPUT_KINDS = ["first_frame", "last_frame", "reference_image", "video", "reference_video", "audio"] as const;
export type VideoInputKind = (typeof VIDEO_INPUT_KINDS)[number];

/**
 * Values a video model accepts. Absent lists mean the seller did not announce
 * that option; buyers must not guess from absence. `inputs` is the complete
 * list of accepted media inputs (empty means text only), and `requiredInputs`
 * must be supplied on every create.
 */
export interface VideoOptions {
  durationsSeconds?: number[];
  resolutions?: string[];
  aspectRatios?: string[];
  inputs?: VideoInputKind[];
  requiredInputs?: VideoInputKind[];
  audio?: boolean;
}

/**
 * Per-service model capability hints announced by sellers. Every field is
 * optional: absent means unknown, so buyers fall back to their own defaults.
 */
export interface ServiceCapabilities {
  /** Options accepted by a native video model. */
  video?: VideoOptions;
  /** Total context window in tokens. */
  contextWindow?: number;
  /** Maximum output tokens per response. */
  maxOutputTokens?: number;
  /** Supported input modalities. */
  inputs?: ServiceCapabilityModality[];
  /** Produced output modalities (e.g. `["image"]` for image services). */
  outputs?: ServiceCapabilityModality[];
  /** Supports extended thinking / reasoning effort. */
  reasoning?: boolean;
  /** Supports tool use / function calling. */
  toolUse?: boolean;
  /** Supports structured output / JSON schema responses. */
  structuredOutput?: boolean;
  /**
   * Request-body parameter names the service accepts beyond the protocol's
   * required fields, e.g. `["background", "output_format", "seed"]` for an
   * image service. A hint for buyers, not an enforced contract.
   */
  supportedParameters?: string[];
}

/** Ceiling for announced contextWindow / maxOutputTokens (fits the u32 wire field). */
export const MAX_CAPABILITY_TOKEN_COUNT = 1_000_000_000;
export const MAX_CAPABILITY_SUPPORTED_PARAMETERS = 32;
export const MAX_CAPABILITY_PARAMETER_LENGTH = 32;
export const MAX_VIDEO_OPTION_VALUES = 64;
export const MAX_VIDEO_OPTION_LENGTH = 32;
/** Lowercase snake_case, matching OpenAI-style request body field names. */
const CAPABILITY_PARAMETER_PATTERN = /^[a-z][a-z0-9_]*$/;
const SERVICE_CAPABILITY_MODALITY_SET = new Set<string>(SERVICE_CAPABILITY_MODALITIES);
const VIDEO_INPUT_KIND_SET = new Set<string>(VIDEO_INPUT_KINDS);
const VIDEO_OPTION_PATTERN = /^[A-Za-z0-9:._-]+$/;

function validateVideoOptions(video: VideoOptions): string[] {
  const errors: string[] = [];
  if (!video || typeof video !== "object" || Array.isArray(video)) return ["video must be an object"];
  const unique = (field: string, values: unknown, valid: (value: unknown) => boolean, allowEmpty = false) => {
    if (values === undefined) return;
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > MAX_VIDEO_OPTION_VALUES) {
      errors.push(`video.${field} must contain ${allowEmpty ? 0 : 1}-${MAX_VIDEO_OPTION_VALUES} values`);
      return;
    }
    const seen = new Set<unknown>();
    for (const value of values) {
      if (!valid(value)) errors.push(`Invalid video.${field} value ${JSON.stringify(value)}`);
      else if (seen.has(value)) errors.push(`Duplicate video.${field} value ${JSON.stringify(value)}`);
      seen.add(value);
    }
  };
  unique("durationsSeconds", video.durationsSeconds, value => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 3600);
  for (const field of ["resolutions", "aspectRatios"] as const) {
    unique(field, video[field], value => typeof value === "string" && value.length <= MAX_VIDEO_OPTION_LENGTH && VIDEO_OPTION_PATTERN.test(value));
  }
  for (const field of ["inputs", "requiredInputs"] as const) {
    unique(field, video[field], value => typeof value === "string" && VIDEO_INPUT_KIND_SET.has(value), field === "inputs");
  }
  if (video.inputs && video.requiredInputs?.some(input => !video.inputs!.includes(input))) errors.push("video.requiredInputs must also be listed in video.inputs");
  if (video.audio !== undefined && typeof video.audio !== "boolean") errors.push("video.audio must be a boolean");
  const known = new Set(["durationsSeconds", "resolutions", "aspectRatios", "inputs", "requiredInputs", "audio"]);
  for (const key of Object.keys(video)) if (!known.has(key)) errors.push(`Unsupported video option ${key}`);
  if (Object.keys(video).length === 0) errors.push("video must announce at least one option");
  return errors;
}

/**
 * Field-level validation for one service's capability entry. Shared by the
 * announce-time metadata validator and provider config parsing so the two
 * can never drift: anything config parsing accepts must also announce.
 */
export function validateServiceCapabilityFields(caps: ServiceCapabilities): string[] {
  const errors: string[] = [];
  if (caps.video !== undefined) errors.push(...validateVideoOptions(caps.video));
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const value = caps[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_CAPABILITY_TOKEN_COUNT) {
      errors.push(`${key} must be a positive integer <= ${MAX_CAPABILITY_TOKEN_COUNT}`);
    }
  }
  for (const key of ["inputs", "outputs"] as const) {
    const modalities = caps[key];
    if (modalities === undefined) continue;
    const label = key === "inputs" ? "input" : "output";
    if (!Array.isArray(modalities)) {
      errors.push(`${key} must be an array`);
      continue;
    }
    const seen = new Set<string>();
    for (const modality of modalities) {
      if (!SERVICE_CAPABILITY_MODALITY_SET.has(modality)) {
        errors.push(`Unsupported ${label} modality "${modality}"`);
      } else if (seen.has(modality)) {
        errors.push(`Duplicate ${label} modality "${modality}"`);
      }
      seen.add(modality);
    }
  }
  for (const key of ["reasoning", "toolUse", "structuredOutput"] as const) {
    const value = caps[key];
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${key} must be a boolean`);
    }
  }
  if (caps.supportedParameters !== undefined) {
    if (!Array.isArray(caps.supportedParameters)) {
      errors.push("supportedParameters must be an array");
    } else {
      if (caps.supportedParameters.length > MAX_CAPABILITY_SUPPORTED_PARAMETERS) {
        errors.push(`supportedParameters count ${caps.supportedParameters.length} exceeds max ${MAX_CAPABILITY_SUPPORTED_PARAMETERS}`);
      }
      const seen = new Set<string>();
      for (const parameter of caps.supportedParameters) {
        if (typeof parameter !== "string" || !CAPABILITY_PARAMETER_PATTERN.test(parameter)) {
          errors.push(`Supported parameter ${JSON.stringify(parameter)} must be lowercase snake_case`);
        } else if (parameter.length > MAX_CAPABILITY_PARAMETER_LENGTH) {
          errors.push(`Supported parameter "${parameter}" exceeds ${MAX_CAPABILITY_PARAMETER_LENGTH} characters`);
        } else if (seen.has(parameter)) {
          errors.push(`Duplicate supported parameter "${parameter}"`);
        }
        seen.add(parameter);
      }
    }
  }
  return errors;
}

/*
 * Health enums go on the wire as ids, and buyers verify a signature by
 * re-encoding what they received, so a buyer rejects a value it does not
 * know. Never reorder these. A new value needs a new metadata version whose
 * `fromLatest` maps it to an existing value for the older documents.
 */
export const SERVICE_HEALTH_STATUSES = ["unknown", "healthy", "failing"] as const;
export type ServiceHealthState = (typeof SERVICE_HEALTH_STATUSES)[number];
export const SERVICE_HEALTH_REASONS = [
  "timeout",
  "rate_limited",
  "out_of_credit",
  "auth",
  "model_unavailable",
  "upstream_error",
  "unreachable",
  "init_failed",
] as const;
export type ServiceHealthReason = (typeof SERVICE_HEALTH_REASONS)[number];
export const SERVICE_HEALTH_SOURCES = ["probe", "traffic"] as const;
export type ServiceHealthSource = (typeof SERVICE_HEALTH_SOURCES)[number];

/**
 * The seller's own health check result for one service. Sellers keep failing
 * services announced and report them here instead, so buyers can hide them
 * from catalogs and routing while still explaining why a pinned request
 * failed. Reasons are fixed codes; upstream error text is never announced.
 */
export interface ServiceHealth {
  status: ServiceHealthState;
  /** Unix ms of the evidence behind `status`: the last probe or live response. */
  checkedAt?: number;
  /** Where that evidence came from. */
  source?: ServiceHealthSource;
  /** Unix ms of the first failure in the current failing streak. */
  failingSince?: number;
  /** Failed checks in a row. */
  consecutiveFailures?: number;
  /** Why the last check failed. */
  reason?: ServiceHealthReason;
  /** Upstream HTTP status of the last failed check, when there was one. */
  httpStatus?: number;
}

/** Latest Unix ms a JS Date can hold; health timestamps above it are rejected. */
export const MAX_SERVICE_HEALTH_TIME_MS = 8_640_000_000_000_000;

export function isServiceHealthTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SERVICE_HEALTH_TIME_MS;
}

/** True when a seller's self health check marks the service failing. */
export function isServiceHealthFailing(health: ServiceHealth | null | undefined): health is ServiceHealth {
  return health?.status === "failing";
}

/** Looks up one service's health in a per-provider map such as PeerInfo.providerServiceHealth. */
export function providerServiceHealthFor(
  providerServiceHealth: Record<string, { services?: Record<string, ServiceHealth> }> | undefined,
  provider: string,
  service: string,
): ServiceHealth | undefined {
  return own(own(providerServiceHealth, provider)?.services, service);
}

/** Error code a seller answers with when a service its own health check marks failing also fails a request. */
export const SELLER_SELF_HEALTH_FAILING_CODE = "seller_self_health_failing";

const SERVICE_HEALTH_REASON_TEXT: Record<ServiceHealthReason, string> = {
  timeout: "the upstream timed out",
  rate_limited: "the upstream is rate or usage limited",
  out_of_credit: "the upstream account is out of credit",
  auth: "the upstream rejected the seller's credentials",
  model_unavailable: "the upstream no longer offers this model",
  upstream_error: "the upstream returned errors",
  unreachable: "the upstream could not be reached",
  init_failed: "the provider failed to initialize",
};

/**
 * Reads a ServiceHealth from untrusted JSON (a seller error body), keeping
 * only well-formed known fields. Returns null when the status is missing.
 */
export function parseServiceHealth(value: unknown): ServiceHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== "string" || !(SERVICE_HEALTH_STATUSES as readonly string[]).includes(raw.status)) return null;
  const health: ServiceHealth = { status: raw.status as ServiceHealthState };
  const time = (field: unknown) => isServiceHealthTime(field) ? field : undefined;
  const checkedAt = time(raw.checkedAt);
  if (checkedAt !== undefined) health.checkedAt = checkedAt;
  const failingSince = time(raw.failingSince);
  if (failingSince !== undefined) health.failingSince = failingSince;
  if (typeof raw.source === "string" && (SERVICE_HEALTH_SOURCES as readonly string[]).includes(raw.source)) health.source = raw.source as ServiceHealthSource;
  if (typeof raw.reason === "string" && (SERVICE_HEALTH_REASONS as readonly string[]).includes(raw.reason)) health.reason = raw.reason as ServiceHealthReason;
  if (typeof raw.consecutiveFailures === "number" && Number.isInteger(raw.consecutiveFailures) && raw.consecutiveFailures >= 0 && raw.consecutiveFailures <= 0xffff) {
    health.consecutiveFailures = raw.consecutiveFailures;
  }
  if (typeof raw.httpStatus === "number" && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599) health.httpStatus = raw.httpStatus;
  return health;
}

const SERVICE_NAME_PATTERN = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/**
 * One sentence a person can act on, e.g. in a chat error. Built from fields
 * only, never seller prose; a service name that does not look like a model
 * id is left out.
 */
export function describeServiceHealth(service: string, health: ServiceHealth): string {
  const parts: string[] = [];
  if (health.reason) parts.push(SERVICE_HEALTH_REASON_TEXT[health.reason] ?? health.reason);
  if (health.httpStatus !== undefined) parts.push(`HTTP ${health.httpStatus}`);
  if (health.consecutiveFailures !== undefined && health.consecutiveFailures > 0) {
    parts.push(`${health.consecutiveFailures} failed check${health.consecutiveFailures === 1 ? "" : "s"} in a row`);
  }
  const since = isServiceHealthTime(health.failingSince)
    ? ` since ${new Date(health.failingSince).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "";
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const verb = health.status === "failing" ? "has been failing" : `reports "${health.status}"`;
  const subject = SERVICE_NAME_PATTERN.test(service) ? `"${service}"` : "this service";
  return `The seller's self health check for ${subject} ${verb}${since}${detail}.`;
}

export interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceUnitBillingModels?: ServiceUnitBillingModelsV1;
  serviceCapabilities?: Record<string, ServiceCapabilities>;
  /** Seller self health check results per service (v13+). */
  serviceHealth?: Record<string, ServiceHealth>;
  maxConcurrency: number;
  currentLoad: number;
}

/**
 * Per-provider service health from a peer's announcements, as buyers read it.
 * Several upstreams can share a provider name (with the same terms), and the
 * seller serves a service through any of them, so it counts as failing only
 * when every one of them reports failing. Otherwise the best report stands,
 * and none when a working upstream has not been checked yet.
 */
export function providerServiceHealthMatrix(
  providers: readonly ProviderAnnouncement[],
): Record<string, ProviderServiceHealthMatrixEntry> {
  const matrix: Record<string, ProviderServiceHealthMatrixEntry> = dict();
  for (const [provider, upstreams] of upstreamsByProvider(providers)) {
    const services: Record<string, ServiceHealth> = dict();
    for (const service of new Set(upstreams.flatMap((upstream) => [...upstream.services, ...Object.keys(upstream.serviceHealth ?? {})]))) {
      const serving = upstreams.filter((upstream) => upstream.services.includes(service) || own(upstream.serviceHealth, service));
      const health = mergeUpstreamHealth(serving.map((upstream) => own(upstream.serviceHealth, service)));
      if (health) services[service] = { ...health };
    }
    if (Object.keys(services).length > 0) matrix[provider] = { services };
  }
  return matrix;
}

/** Reads a health matrix from untrusted JSON (a cache file), keeping only well-formed entries. */
export function parseProviderServiceHealthMatrix(value: unknown): Record<string, ProviderServiceHealthMatrixEntry> | undefined {
  if (!isPlainObject(value)) return undefined;
  const matrix: Record<string, ProviderServiceHealthMatrixEntry> = dict();
  for (const [provider, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const services: Record<string, ServiceHealth> = dict();
    for (const [service, health] of Object.entries(isPlainObject(entry.services) ? entry.services : {})) {
      const parsed = parseServiceHealth(health);
      if (parsed) services[service] = parsed;
    }
    if (Object.keys(services).length > 0) matrix[provider] = { services };
  }
  return Object.keys(matrix).length > 0 ? matrix : undefined;
}

/**
 * A service-keyed entry of a map, never one inherited from Object.prototype:
 * a seller can list a service named "constructor".
 */
function own<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** A map keyed by provider or service names, with no inherited keys. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A peer's announcements grouped by provider name, in announcement order. */
function upstreamsByProvider(providers: readonly ProviderAnnouncement[]): Map<string, ProviderAnnouncement[]> {
  const groups = new Map<string, ProviderAnnouncement[]>();
  for (const announcement of providers) {
    const upstreams = groups.get(announcement.provider) ?? [];
    upstreams.push(announcement);
    groups.set(announcement.provider, upstreams);
  }
  return groups;
}

function mergeUpstreamHealth(reports: Array<ServiceHealth | undefined>): ServiceHealth | undefined {
  if (reports.every(isServiceHealthFailing)) {
    // The newest failure explains it best.
    return reports.reduce((latest, entry) => ((entry.checkedAt ?? 0) > (latest.checkedAt ?? 0) ? entry : latest));
  }
  const healthy = reports.find((entry) => entry?.status === "healthy");
  if (healthy) return healthy;
  // A working upstream that has not been checked yet: nothing to report.
  if (reports.includes(undefined)) return undefined;
  return reports.find((entry) => !isServiceHealthFailing(entry));
}

/**
 * Of the upstreams serving a service, the one a seller routes it to: the first
 * whose self health check is not failing it, else the first.
 */
export function preferHealthyUpstream<T extends { serviceHealth?: Record<string, ServiceHealth> }>(
  candidates: readonly T[],
  service: string,
): T | undefined {
  return candidates.find((candidate) => !isServiceHealthFailing(own(candidate.serviceHealth, service))) ?? candidates[0];
}

/** A peer's announcements merged per provider name, as buyers route and bill by them. */
export interface ProviderServiceMatrices {
  providerPricing: Record<string, ProviderPricingMatrixEntry>;
  providerServiceCategories: Record<string, ProviderServiceCategoryMatrixEntry>;
  providerServiceApiProtocols: Record<string, ProviderServiceApiProtocolMatrixEntry>;
  providerServiceUnitBillingModels: Record<string, ProviderServiceUnitBillingModelMatrixEntry>;
  providerServiceCapabilities: Record<string, ProviderServiceCapabilityMatrixEntry>;
  providerServiceHealth: Record<string, ProviderServiceHealthMatrixEntry>;
}

function setServiceEntry<T>(matrix: Record<string, { services: Record<string, T> }>, provider: string, service: string, value: T | undefined): void {
  if (value === undefined) return;
  (matrix[provider] ??= { services: dict() }).services[service] = value;
}

/** Every service the upstreams describe; a wildcard upstream (no services listed) can still describe some in its maps. */
function describedServices(upstreams: readonly ProviderAnnouncement[]): Set<string> {
  return new Set(upstreams.flatMap((upstream) => [
    ...upstream.services,
    ...Object.keys(upstream.serviceCategories ?? {}),
    ...Object.keys(upstream.serviceApiProtocols ?? {}),
    ...Object.keys(upstream.serviceUnitBillingModels ?? {}),
    ...Object.keys(upstream.serviceCapabilities ?? {}),
  ]));
}

/**
 * Merges a peer's announcements per provider name. Several upstreams can
 * share a name; a seller refuses to start unless they announce a service with
 * the same terms, so a service's terms are read from the upstream the seller
 * would serve it through (`preferHealthyUpstream`), and its health is merged
 * as in `providerServiceHealthMatrix`.
 */
export function mergeProviderAnnouncements(providers: readonly ProviderAnnouncement[]): ProviderServiceMatrices {
  const matrices: ProviderServiceMatrices = {
    providerPricing: dict(),
    providerServiceCategories: dict(),
    providerServiceApiProtocols: dict(),
    providerServiceUnitBillingModels: dict(),
    providerServiceCapabilities: dict(),
    providerServiceHealth: providerServiceHealthMatrix(providers),
  };
  for (const [name, upstreams] of upstreamsByProvider(providers)) {
    const { defaultPricing } = upstreams[0]!;
    const pricing: ProviderPricingMatrixEntry = {
      defaults: {
        inputUsdPerMillion: defaultPricing.inputUsdPerMillion,
        outputUsdPerMillion: defaultPricing.outputUsdPerMillion,
        ...(defaultPricing.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: defaultPricing.cachedInputUsdPerMillion } : {}),
      },
    };
    matrices.providerPricing[name] = pricing;

    for (const service of describedServices(upstreams)) {
      const listing = upstreams.filter((upstream) => upstream.services.includes(service));
      const serving = listing.length > 0 ? listing : upstreams;
      const owner = preferHealthyUpstream(serving, service)!;
      if (owner.services.includes(service)) {
        (pricing.services ??= dict())[service] = own(owner.servicePricing, service) ?? owner.defaultPricing;
      }
      setServiceEntry(matrices.providerServiceCategories, name, service, own(owner.serviceCategories, service)?.slice());
      setServiceEntry(matrices.providerServiceCapabilities, name, service, own(owner.serviceCapabilities, service));

      setServiceEntry(matrices.providerServiceApiProtocols, name, service, own(owner.serviceApiProtocols, service)?.slice());
      setServiceEntry(matrices.providerServiceUnitBillingModels, name, service, own(owner.serviceUnitBillingModels, service));
    }
  }
  return matrices;
}

export type DomainVerificationMethod = "dns-txt" | "https-well-known";

export interface DomainVerificationClaim {
  /** ASCII hostname only, lower-case, with no scheme, path, or port. */
  domain: string;
  /** Accepted proof transports. When omitted, clients may try every known method. */
  methods?: DomainVerificationMethod[];
}

export interface GithubVerificationClaim {
  /** GitHub username, lower-case. */
  username: string;
  /**
   * Public repository holding the proof file, lower-case. Defaults to the
   * profile repository `<username>/<username>` when omitted.
   */
  repository?: string;
}

export interface PeerVerifications {
  /**
   * Domain ownership claims. Clients verify by checking a matching DNS TXT
   * record at `_antseed.<domain>` or a well-known proof at
   * `https://<domain>/.well-known/antseed.json`.
   */
  domains?: DomainVerificationClaim[];
  /**
   * GitHub account ownership claims. Clients verify by fetching
   * `https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json`
   * — the username in the URL path binds the proof to the account.
   */
  github?: GithubVerificationClaim[];
}

export interface PeerMetadata {
  peerId: PeerId;
  version: number;
  displayName?: string;
  publicAddress?: string;
  providers: ProviderAnnouncement[];
  offerings?: PeerOffering[];
  region: string;
  timestamp: number;
  stakeAmountUSDC?: number;
  onChainChannelCount?: number;
  onChainGhostCount?: number;
  /** Protocol capabilities supported by this peer. */
  capabilities?: string[];
  /**
   * On-chain seller contract that fronts this peer (e.g. a DiemStakingProxy).
   * Buyers resolve `seller = sellerContract` for channel flows and verify the
   * binding by calling `sellerContract.isOperator(peerAddress)` on-chain.
   * Stored as 40 lowercase hex chars (no `0x` prefix) matching `peerId` format.
   */
  sellerContract?: string;
  /** Optional external ownership claims announced by this peer. */
  verifications?: PeerVerifications;
  /**
   * Buyer-local observation time for this metadata fetch. Not signed and not
   * encoded in metadata; used only for diagnostics/freshness decisions.
   */
  resolvedAtMs?: number;
  /**
   * Seller HTTP Date header observed during metadata fetch, in Unix ms. Not
   * signed and not encoded in metadata. When present, buyers can judge the
   * signed timestamp using the seller's wall clock instead of their own, which
   * keeps discovery working for users whose local desktop clock is wrong.
   */
  serverDateMs?: number;
  signature: string;
}
