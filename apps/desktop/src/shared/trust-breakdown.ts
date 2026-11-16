import type { TrustBreakdown } from '@antseed/node';

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Validate a `trust` blob read from buyer.state.json. The buyer daemon writes
 * `TrustBreakdown`, but the file may predate the field or be hand-edited, so
 * every part is checked and the whole breakdown is dropped when the final
 * score is missing or out of range.
 */
export function normalizeTrustBreakdown(raw: unknown): TrustBreakdown | null {
  const value = asObject(raw);
  if (!value) return null;
  const score = boundedScore(value.score);
  if (score === null) return null;
  return {
    score,
    history: normalizeHistoryPart(asObject(value.history)),
    usage: normalizeSharePart(asObject(value.usage)),
    power: normalizeSharePart(asObject(value.power)),
    identity: normalizeIdentityPart(asObject(value.identity)),
    freeModels: normalizeFreeModelsPart(asObject(value.freeModels)),
    washFlagged: typeof value.washFlagged === 'boolean' ? value.washFlagged : null,
    verification: normalizeVerificationPart(asObject(value.verification)),
  };
}

/** The model-verification effect: the points multiplier and what it added to or took off the score. */
function normalizeVerificationPart(raw: Record<string, unknown> | null): TrustBreakdown['verification'] {
  if (!raw) return null;
  const multiplierBps = nonNegative(raw.multiplierBps);
  const sameCount = nonNegative(raw.sameCount);
  const diffCount = nonNegative(raw.diffCount);
  // A state file from an older buyer daemon has a positive `penalty` instead of a signed `change`.
  const legacyPenalty = boundedScore(raw.penalty);
  const change = typeof raw.change === 'number' && Number.isFinite(raw.change)
    ? raw.change
    : legacyPenalty === null ? null : -legacyPenalty;
  if (multiplierBps === null || sameCount === null || diffCount === null || change === null || change === 0) return null;
  return { multiplierBps, sameCount, diffCount, change, penalty: Math.max(0, -change) };
}

function normalizeFreeModelsPart(raw: Record<string, unknown> | null): TrustBreakdown['freeModels'] {
  if (!raw) return null;
  const score = boundedScore(raw.score);
  if (score === null || typeof raw.service !== 'string' || raw.service.length === 0) return null;
  return { score, service: raw.service };
}

function normalizeHistoryPart(raw: Record<string, unknown> | null): TrustBreakdown['history'] {
  if (!raw) return null;
  const channelCount = nonNegative(raw.channelCount);
  const totalVolumeUsdcMicros = nonNegative(raw.totalVolumeUsdcMicros);
  if (channelCount === null || totalVolumeUsdcMicros === null) return null;
  return { score: boundedScore(raw.score) ?? 0, channelCount, totalVolumeUsdcMicros };
}

/** A usage or power part: weighted score plus the share and epoch it came from. */
function normalizeSharePart(raw: Record<string, unknown> | null): TrustBreakdown['usage'] {
  if (!raw) return null;
  const score = boundedScore(raw.score);
  const shareBps = nonNegative(raw.shareBps);
  const epoch = nonNegative(raw.epoch);
  if (score === null || shareBps === null || epoch === null) return null;
  return { score, shareBps, epoch };
}

function normalizeIdentityPart(raw: Record<string, unknown> | null): TrustBreakdown['identity'] {
  if (!raw) return null;
  const score = boundedScore(raw.score);
  if (score === null) return null;
  if (raw.kind !== 'github' && raw.kind !== 'domain') return null;
  const claim = typeof raw.claim === 'string' ? raw.claim : '';
  return { score, kind: raw.kind, claim };
}
