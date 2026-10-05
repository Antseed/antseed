import type { ChatServiceOptionEntry, DiscoverRow, ServiceCapabilitiesView, TrustBreakdown } from '../../core/state';
import type { DiscoverVerificationLink } from '../../core/state';
import { isTextCapableRow } from './model-capabilities';
import { normalizeAdvertisedVerifierIds } from '@antseed/node/verifier-capabilities';

const CHAT_SERVICE_SELECTION_SEPARATOR = '\u0001';

function boundedScore(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= 100 ? input : null;
}

function nonNegative(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null;
}

function asObject(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

/** Validate the buyer's `TrustBreakdown`; each part is nullable, the final score must be 0-100. */
export function normalizeTrust(raw: unknown): TrustBreakdown | null {
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
    washFlagged: typeof value.washFlagged === 'boolean' ? value.washFlagged : null,
  };
}

function normalizeHistoryPart(raw: Record<string, unknown> | null): TrustBreakdown['history'] {
  if (!raw) return null;
  const score = boundedScore(raw.score);
  const channelCount = nonNegative(raw.channelCount);
  const totalVolumeUsdcMicros = nonNegative(raw.totalVolumeUsdcMicros);
  if (score === null || channelCount === null || totalVolumeUsdcMicros === null) return null;
  return { score, channelCount, totalVolumeUsdcMicros };
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

function toNullableBigintString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v).toString();
  if (typeof v === 'bigint') return v.toString();
  return null;
}

function normalizeVerificationLink(raw: unknown): DiscoverVerificationLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'domain' || r.kind === 'github' ? r.kind : null;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  const href = typeof r.href === 'string' ? r.href.trim() : '';
  if (!kind || !label || !href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return null;
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const description = typeof r.description === 'string' ? r.description.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
    let faviconUrl = '';
    if (typeof r.faviconUrl === 'string' && r.faviconUrl.trim().length > 0) {
      try {
        const iconUrl = new URL(r.faviconUrl.trim());
        faviconUrl = iconUrl.protocol === 'https:' ? iconUrl.toString() : '';
      } catch {
        faviconUrl = '';
      }
    }
    return {
      kind,
      label,
      href: url.toString(),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(faviconUrl ? { faviconUrl } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeCapabilities(value: unknown): ServiceCapabilitiesView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const positiveInteger = (candidate: unknown): number | undefined => (
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined
  );
  const stringList = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    const result = [...new Set(candidate.filter((item): item is string => typeof item === 'string' && item.length > 0))];
    return result.length > 0 ? result : undefined;
  };
  const normalized: ServiceCapabilitiesView = {
    ...(positiveInteger(raw.contextWindow) ? { contextWindow: positiveInteger(raw.contextWindow) } : {}),
    ...(positiveInteger(raw.maxOutputTokens) ? { maxOutputTokens: positiveInteger(raw.maxOutputTokens) } : {}),
    ...(stringList(raw.inputs) ? { inputs: stringList(raw.inputs) } : {}),
    ...(stringList(raw.outputs) ? { outputs: stringList(raw.outputs) } : {}),
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw.toolUse === 'boolean' ? { toolUse: raw.toolUse } : {}),
    ...(typeof raw.structuredOutput === 'boolean' ? { structuredOutput: raw.structuredOutput } : {}),
    ...(stringList(raw.supportedParameters) ? { supportedParameters: stringList(raw.supportedParameters) } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeDiscoverRow(raw: unknown): DiscoverRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const peerId = String(r.peerId ?? '').trim();
  const serviceId = String(r.serviceId ?? '').trim();
  if (!peerId || !serviceId) return null;
  return {
    advertisedVerifierIds: normalizeAdvertisedVerifierIds(r.advertisedVerifierIds),
    rowKey: String(r.rowKey ?? `${peerId}:${serviceId}`),
    serviceId,
    serviceLabel: String(r.serviceLabel ?? serviceId),
    categories: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === 'string') : [],
    provider: String(r.provider ?? 'unknown'),
    protocol: String(r.protocol ?? ''),
    capabilities: normalizeCapabilities(r.capabilities),
    peerId,
    peerEvmAddress: String(r.peerEvmAddress ?? ''),
    sellerContract: typeof r.sellerContract === 'string' && r.sellerContract.length > 0 ? r.sellerContract : null,
    verificationLinks: Array.isArray(r.verificationLinks)
      ? r.verificationLinks
        .map(normalizeVerificationLink)
        .filter((link): link is DiscoverVerificationLink => link !== null)
      : [],
    peerIconUrl: normalizeHttpsUrl(r.peerIconUrl),
    peerDisplayName: typeof r.peerDisplayName === 'string' ? r.peerDisplayName : null,
    peerLabel: String(r.peerLabel ?? ''),
    inputUsdPerMillion: typeof r.inputUsdPerMillion === 'number' ? r.inputUsdPerMillion : null,
    outputUsdPerMillion: typeof r.outputUsdPerMillion === 'number' ? r.outputUsdPerMillion : null,
    // Billing charges cached tokens at the input rate when a seller doesn't
    // advertise a cached price (buyer-core pricing fallback) — mirror that
    // here so every price display and free check sees the effective rate.
    cachedInputUsdPerMillion: typeof r.cachedInputUsdPerMillion === 'number'
      ? r.cachedInputUsdPerMillion
      : (typeof r.inputUsdPerMillion === 'number' ? r.inputUsdPerMillion : null),
    minImageUsdPerImage: typeof r.minImageUsdPerImage === 'number' ? r.minImageUsdPerImage : null,
    maxImageUsdPerImage: typeof r.maxImageUsdPerImage === 'number' ? r.maxImageUsdPerImage : null,
    lifetimeSessions: Number(r.lifetimeSessions) || 0,
    lifetimeRequests: Number(r.lifetimeRequests) || 0,
    lifetimeInputTokens: Number(r.lifetimeInputTokens) || 0,
    lifetimeOutputTokens: Number(r.lifetimeOutputTokens) || 0,
    lifetimeFirstSessionAt: typeof r.lifetimeFirstSessionAt === 'number' ? r.lifetimeFirstSessionAt : null,
    lifetimeLastSessionAt: typeof r.lifetimeLastSessionAt === 'number' ? r.lifetimeLastSessionAt : null,
    onChainChannelCount: typeof r.onChainChannelCount === 'number' ? r.onChainChannelCount : null,
    agentId: Number(r.agentId) || 0,
    poolStakeAnts: nonNegative(r.poolStakeAnts) ?? 0,
    onChainActiveChannelCount: Number(r.onChainActiveChannelCount) || 0,
    onChainGhostCount: Number(r.onChainGhostCount) || 0,
    onChainTotalVolumeUsdc: String(r.onChainTotalVolumeUsdc ?? '0'),
    onChainLastSettledAt: Number(r.onChainLastSettledAt) || 0,
    onChainReputationScore: typeof r.onChainReputationScore === 'number' && Number.isFinite(r.onChainReputationScore)
      ? r.onChainReputationScore
      : null,
    trust: normalizeTrust(r.trust),
    washFlagged: typeof r.washFlagged === 'boolean' ? r.washFlagged : null,
    effectiveReputationScore: typeof r.effectiveReputationScore === 'number' && Number.isFinite(r.effectiveReputationScore)
      ? r.effectiveReputationScore
      : null,
    onChainSybilRisk: typeof r.onChainSybilRisk === 'number' && Number.isFinite(r.onChainSybilRisk)
      ? r.onChainSybilRisk
      : null,
    onChainSybilFlags: Array.isArray(r.onChainSybilFlags)
      ? r.onChainSybilFlags.filter((f): f is string => typeof f === 'string')
      : [],
    networkRequests: toNullableBigintString(r.networkRequests),
    networkInputTokens: toNullableBigintString(r.networkInputTokens),
    networkOutputTokens: toNullableBigintString(r.networkOutputTokens),
    peerCooldownUntil: typeof r.peerCooldownUntil === 'number' && Number.isFinite(r.peerCooldownUntil)
      ? r.peerCooldownUntil
      : null,
    peerFailureStreak: Number(r.peerFailureStreak) || 0,
    peerLastFailureReason: typeof r.peerLastFailureReason === 'string' ? r.peerLastFailureReason : null,
    selectionValue: String(r.selectionValue ?? ''),
  };
}

export function projectRowsToChatServiceOptions(rows: DiscoverRow[]): ChatServiceOptionEntry[] {
  const grouped = new Map<string, ChatServiceOptionEntry>();
  for (const row of rows) {
    // AI VPN can browse image generators, but the built-in chat pipeline must
    // only receive protocols it knows how to serialize and stream.
    if (!isTextCapableRow(row)) continue;
    const key = `${row.provider}${CHAT_SERVICE_SELECTION_SEPARATOR}${row.serviceId}${CHAT_SERVICE_SELECTION_SEPARATOR}${row.peerId}`;
    if (grouped.has(key)) continue;
    grouped.set(key, {
      id: row.serviceId,
      label: row.serviceLabel,
      provider: row.provider,
      protocol: row.protocol,
      capabilities: row.capabilities,
      count: 1,
      value: row.selectionValue,
      peerId: row.peerId,
      peerDisplayName: row.peerDisplayName,
      peerLabel: row.peerLabel,
      peerIconUrl: row.peerIconUrl,
      inputUsdPerMillion: row.inputUsdPerMillion,
      outputUsdPerMillion: row.outputUsdPerMillion,
      cachedInputUsdPerMillion: row.cachedInputUsdPerMillion,
      minImageUsdPerImage: row.minImageUsdPerImage,
      maxImageUsdPerImage: row.maxImageUsdPerImage,
      categories: row.categories,
      description: '',
    });
  }
  return Array.from(grouped.values());
}
