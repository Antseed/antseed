import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

/**
 * Staked free-tier promises as `AntseedFreeTierTerms` (packages/contracts/sellers) records them: per
 * agent, the free tier a seller promises to stakers and the notice it gives before changing it.
 * The types mirror the contract's structs, `validateFreeTierTerms` its bounds with the same error
 * codes, and `encodeFreeTierTerms` its `abi.encode(terms)`, whose keccak256 is the terms hash.
 */

export const FREE_TIER_MIN_NOTICE_EPOCHS = 2;
export const FREE_TIER_MAX_NOTICE_EPOCHS = 104;
export const FREE_TIER_MAX_PROGRAMS = 16;
export const FREE_TIER_MAX_TIERS = 4;
export const FREE_TIER_MAX_MODELS = 32;
export const FREE_TIER_MIN_WINDOW_SECS = 60;
export const FREE_TIER_MAX_WINDOW_SECS = 30 * 24 * 3600;
export const FREE_TIER_MAX_MIN_POWER_ANTS = 2n ** 53n - 1n;
export const FREE_TIER_MAX_FINITE_REQUESTS = 2 ** 31;
/** `requests` value for a tier with no limit. */
export const FREE_TIER_UNLIMITED = 2 ** 32 - 1;
/** `scope` of the seller-wide program. */
export const FREE_TIER_SELLER_WIDE_SCOPE = '0x' + '00'.repeat(32);
/** A zero-priced model. */
export const FREE_TIER_KIND_FREE = 1;
/** A free allowance on a priced model. */
export const FREE_TIER_KIND_ALLOWANCE = 2;

export interface FreeTierTier {
  /** Whole ANTS-epochs of stake power. */
  minPowerAnts: bigint;
  /** Requests per window; `FREE_TIER_UNLIMITED` for no limit. */
  requests: number;
}

export interface FreeTierModel {
  /** keccak256 of the UTF-8 service id (`freeTierModelHash`). */
  modelHash: string;
  kind: number;
}

export interface FreeTierProgram {
  /** `FREE_TIER_SELLER_WIDE_SCOPE`, or the hash of the one model this program covers. */
  scope: string;
  windowSecs: number;
  buyerLimitsApplyToStakers: boolean;
  /** 1 to 4 tiers, thresholds and requests strictly increasing. */
  tiers: FreeTierTier[];
  /** 1 to 32 models, ascending by hash; a model's own program lists exactly that model. */
  models: FreeTierModel[];
}

export interface FreeTierTerms {
  noticeEpochs: number;
  /** Ascending by scope, so the seller-wide program comes first. Empty: no promise. */
  programs: FreeTierProgram[];
}

const PROGRAM_ABI_TUPLE =
  'tuple(bytes32 scope, uint32 windowSecs, bool buyerLimitsApplyToStakers, tuple(uint64 minPowerAnts, uint32 requests)[] tiers, tuple(bytes32 modelHash, uint8 kind)[] models)';
const TERMS_ABI_TUPLE = `tuple(uint16 noticeEpochs, ${PROGRAM_ABI_TUPLE}[] programs)`;

/** keccak256 of the UTF-8 bytes of a service id: the model hash terms use. */
export function freeTierModelHash(serviceId: string): string {
  return keccak256(toUtf8Bytes(serviceId));
}

/** The contract's `abi.encode(terms)`. */
export function encodeFreeTierTerms(terms: FreeTierTerms): string {
  return AbiCoder.defaultAbiCoder().encode([TERMS_ABI_TUPLE], [terms]);
}

/** The hash the board records the terms under. */
export function freeTierTermsHash(terms: FreeTierTerms): string {
  return keccak256(encodeFreeTierTerms(terms));
}

/** Decodes `abi.encode(terms)`, as `termsAt` returns them. */
export function decodeFreeTierTerms(encoded: string): FreeTierTerms {
  const [raw] = AbiCoder.defaultAbiCoder().decode([TERMS_ABI_TUPLE], encoded);
  return {
    noticeEpochs: Number(raw.noticeEpochs),
    programs: raw.programs.map((program: { scope: string; windowSecs: bigint; buyerLimitsApplyToStakers: boolean; tiers: Array<{ minPowerAnts: bigint; requests: bigint }>; models: Array<{ modelHash: string; kind: bigint }> }) => ({
      scope: program.scope,
      windowSecs: Number(program.windowSecs),
      buyerLimitsApplyToStakers: program.buyerLimitsApplyToStakers,
      tiers: program.tiers.map((tier) => ({ minPowerAnts: tier.minPowerAnts, requests: Number(tier.requests) })),
      models: program.models.map((model) => ({ modelHash: model.modelHash, kind: Number(model.kind) })),
    })),
  };
}

/**
 * The contract's bounds: 0 when `terms` keep all of them, else the code of the first broken one, as
 * in the contract's `InvalidTerms(code)`.
 */
export function validateFreeTierTerms(terms: FreeTierTerms): number {
  if (terms.noticeEpochs < FREE_TIER_MIN_NOTICE_EPOCHS || terms.noticeEpochs > FREE_TIER_MAX_NOTICE_EPOCHS) return 1;
  const programs = terms.programs;
  if (programs.length > FREE_TIER_MAX_PROGRAMS) return 2;
  for (let p = 0; p < programs.length; p += 1) {
    const program = programs[p]!;
    if (p > 0 && BigInt(program.scope) <= BigInt(programs[p - 1]!.scope)) return 3;
    if (program.windowSecs < FREE_TIER_MIN_WINDOW_SECS || program.windowSecs > FREE_TIER_MAX_WINDOW_SECS) return 4;
    const tierError = validateTiers(program.tiers);
    if (tierError) return tierError;
    const models = program.models;
    if (models.length === 0 || models.length > FREE_TIER_MAX_MODELS) return 5;
    for (let m = 0; m < models.length; m += 1) {
      const hash = BigInt(models[m]!.modelHash);
      if (hash === 0n || (m > 0 && hash <= BigInt(models[m - 1]!.modelHash))) return 6;
      if (models[m]!.kind !== FREE_TIER_KIND_FREE && models[m]!.kind !== FREE_TIER_KIND_ALLOWANCE) return 7;
    }
    const scope = BigInt(program.scope);
    if (scope !== 0n) {
      if (models.length !== 1 || BigInt(models[0]!.modelHash) !== scope) return 8;
      const first = programs[0]!;
      if (BigInt(first.scope) === 0n && first.models.some((model) => BigInt(model.modelHash) === scope)) return 9;
    }
  }
  return 0;
}

function validateTiers(tiers: FreeTierTier[]): number {
  if (tiers.length === 0 || tiers.length > FREE_TIER_MAX_TIERS) return 10;
  for (let t = 0; t < tiers.length; t += 1) {
    const { minPowerAnts, requests } = tiers[t]!;
    if (minPowerAnts === 0n || minPowerAnts > FREE_TIER_MAX_MIN_POWER_ANTS) return 11;
    if (requests === 0 || (requests > FREE_TIER_MAX_FINITE_REQUESTS && requests !== FREE_TIER_UNLIMITED)) return 12;
    if (requests === FREE_TIER_UNLIMITED && t !== tiers.length - 1) return 13;
    if (t > 0 && (minPowerAnts <= tiers[t - 1]!.minPowerAnts || requests <= tiers[t - 1]!.requests)) return 14;
  }
  return 0;
}

export interface FreeTierProgramMatch {
  program: FreeTierProgram;
  kind: number;
}

/**
 * The program covering `modelHash`, as the contract's `programFor` finds it: the program whose scope
 * is the model, else the seller-wide program if it lists the model, else null.
 */
export function programForModel(terms: FreeTierTerms, modelHash: string): FreeTierProgramMatch | null {
  const target = BigInt(modelHash);
  if (target === 0n) return null;
  for (const program of terms.programs) {
    const scope = BigInt(program.scope);
    if (scope !== target && scope !== 0n) continue;
    const model = program.models.find((entry) => BigInt(entry.modelHash) === target);
    if (model) return { program, kind: model.kind };
  }
  return null;
}

/**
 * The 1-based index of the highest tier `power` (raw stake power, wei x epochs) reaches, comparing
 * whole ANTS-epochs (`power / 10^18 >= minPowerAnts`); 0 for none.
 */
export function tierFor(program: FreeTierProgram, power: bigint): number {
  const whole = power / 10n ** 18n;
  for (let tier = program.tiers.length; tier > 0; tier -= 1) {
    if (whole >= program.tiers[tier - 1]!.minPowerAnts) return tier;
  }
  return 0;
}

/** Human-readable ABI of `AntseedFreeTierTerms`, copied exactly from the Solidity. */
export const FREE_TIER_TERMS_ABI = [
  `function setTerms(uint256 agentId, ${TERMS_ABI_TUPLE} terms, uint256 maxFromEpoch) returns (uint256 fromEpoch)`,
  `function validate(${TERMS_ABI_TUPLE} terms) pure`,
  `function termsAt(uint256 agentId, uint256 epoch) view returns (uint256 fromEpoch, bytes32 termsHash, ${TERMS_ABI_TUPLE} terms)`,
  `function programFor(uint256 agentId, uint256 epoch, bytes32 modelHash) view returns (bool found, ${PROGRAM_ABI_TUPLE} program, uint8 kind)`,
  'function nextChangeAfter(uint256 agentId, uint256 epoch) view returns (bool exists, uint256 fromEpoch, bytes32 termsHash)',
  'function promisedThrough(uint256 agentId) view returns (bool promised, uint256 throughEpoch)',
  'function scheduleLength(uint256 agentId) view returns (uint256)',
  'function entryAt(uint256 agentId, uint256 index) view returns (tuple(uint64 fromEpoch, uint16 noticeEpochs, uint8 programCount, bytes32 termsHash))',
  'function isWriter(uint256 agentId, address who) view returns (bool)',
  `event TermsScheduled(uint256 indexed agentId, uint256 fromEpoch, bytes32 indexed termsHash, address writer, ${TERMS_ABI_TUPLE} terms)`,
] as const;
