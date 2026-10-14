import type { PeerId } from './peer-id.js';
import type { PeerOffering } from './capability.js';
import type { ServiceUnitBillingModelsV1 } from './billing.js';
import {
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  type ServiceApiProtocol,
} from './service-api.js';

export const METADATA_VERSION = 12;
/** Oldest announced metadata version buyers still accept from sellers. */
export const MIN_SUPPORTED_METADATA_VERSION = 10;
export const SERVICE_UNIT_BILLING_METADATA_VERSION = 11;
export const SERVICE_CAPABILITIES_METADATA_VERSION = 12;
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

export interface ProviderAnnouncement {
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
  serviceCategories?: Record<string, string[]>;
  serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  serviceUnitBillingModels?: ServiceUnitBillingModelsV1;
  serviceCapabilities?: Record<string, ServiceCapabilities>;
  maxConcurrency: number;
  currentLoad: number;
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
