import type { PeerInfo } from '../types/peer.js';

/**
 * Local wash-trading / sybil heuristic, display-only.
 *
 * Flags peers whose lifetime `AntseedChannels` stats look like self-dealing
 * (many tiny channels, exclusive custom services burned through quickly,
 * very young accounts with high channel counts). The authoritative signal is
 * `AntseedWashTradingRegistry`, which feeds the trust score; this heuristic
 * only surfaces an early warning in the CLI and desktop.
 */

export const SYBIL_WEIGHT_SUBFLOOR_TICKET = 0.30;
export const SYBIL_WEIGHT_BURN_RATE       = 0.25;
export const SYBIL_WEIGHT_NARROW_CUSTOM   = 0.25;
export const SYBIL_WEIGHT_YOUNG_HIGH_VOL  = 0.20;

export const SYBIL_SUBFLOOR_TICKET_USDC = 1.0;
export const SYBIL_SUBFLOOR_MIN_CHANNELS = 50;

export const SYBIL_BURN_RATE_THRESHOLD = 30;
export const SYBIL_BURN_RATE_SATURATION = 80;

export const SYBIL_YOUNG_MAX_DAYS = 14;
export const SYBIL_YOUNG_CHANNEL_FLOOR = 100;
export const SYBIL_YOUNG_CHANNEL_SATURATION = 400;

export const SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION = 0.10;

export type SybilFlag =
  | 'subfloor_ticket'
  | 'burn_rate'
  | 'narrow_custom'
  | 'young_high_vol';

export interface SybilRiskResult {
  risk: number;
  flags: SybilFlag[];
  signals: Record<SybilFlag, number>;
}

export interface SybilContext {
  serviceCounts: Map<string, number>;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value <= lo) return lo;
  if (value >= hi) return hi;
  return value;
}

function nonNegativeFinite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function collectPeerServices(peer: PeerInfo): string[] {
  const out = new Set<string>();
  const pricing = peer.providerPricing;
  if (!pricing) return [];
  for (const entry of Object.values(pricing)) {
    if (entry.services) {
      for (const name of Object.keys(entry.services)) {
        const trimmed = name.trim();
        if (trimmed.length > 0) out.add(trimmed);
      }
    }
  }
  return Array.from(out);
}

function minAdvertisedInputUsdPerMillion(peer: PeerInfo): number | null {
  let best: number | null = null;
  const consider = (value: number | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      if (best === null || value < best) best = value;
    }
  };
  const pricing = peer.providerPricing;
  if (pricing) {
    for (const entry of Object.values(pricing)) {
      consider(entry.defaults?.inputUsdPerMillion);
      if (entry.services) {
        for (const s of Object.values(entry.services)) {
          consider(s.inputUsdPerMillion);
        }
      }
    }
  }
  consider(peer.defaultInputUsdPerMillion);
  return best;
}

export function buildSybilContext(peers: ReadonlyArray<PeerInfo>): SybilContext {
  const serviceCounts = new Map<string, number>();
  for (const peer of peers) {
    for (const name of collectPeerServices(peer)) {
      serviceCounts.set(name, (serviceCounts.get(name) ?? 0) + 1);
    }
  }
  return { serviceCounts };
}

/** Heuristic wash-trading risk in [0, 1]. */
export function computeOnChainSybilRisk(
  peer: PeerInfo,
  ctx: SybilContext,
  nowMs: number = Date.now(),
): SybilRiskResult {
  const channels = nonNegativeFinite(peer.onChainChannelCount) ?? 0;
  const volumeUsdc = (nonNegativeFinite(peer.onChainTotalVolumeUsdcMicros) ?? 0) / 1_000_000;
  const avgChannelUsdc = channels > 0 ? volumeUsdc / channels : 0;

  const stakedAtSec = nonNegativeFinite(peer.onChainStakedAtSec);
  const daysSinceStaked: number | null = stakedAtSec && stakedAtSec > 0
    ? Math.max(0, (nowMs - stakedAtSec * 1000) / 86_400_000)
    : null;
  const channelsPerDay: number | null = daysSinceStaked !== null && daysSinceStaked > 0
    ? channels / daysSinceStaked
    : null;

  const services = collectPeerServices(peer);
  const advertisedInput = minAdvertisedInputUsdPerMillion(peer);

  let narrowCustom = 0;
  if (services.length > 0 && services.length <= 2) {
    const allExclusive = services.every((s) => (ctx.serviceCounts.get(s) ?? 0) <= 1);
    if (allExclusive) narrowCustom = services.length === 1 ? 1.0 : 0.5;
  }

  let burnRate = 0;
  if (narrowCustom > 0 && channelsPerDay !== null) {
    burnRate = clamp(
      (channelsPerDay - SYBIL_BURN_RATE_THRESHOLD)
        / (SYBIL_BURN_RATE_SATURATION - SYBIL_BURN_RATE_THRESHOLD),
      0, 1,
    );
  }

  let subfloorTicket = 0;
  const advertisedCheap = advertisedInput != null
    && advertisedInput <= SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION;
  if (!advertisedCheap && channels >= SYBIL_SUBFLOOR_MIN_CHANNELS && avgChannelUsdc < SYBIL_SUBFLOOR_TICKET_USDC) {
    subfloorTicket = clamp(
      (SYBIL_SUBFLOOR_TICKET_USDC - avgChannelUsdc) / SYBIL_SUBFLOOR_TICKET_USDC,
      0, 1,
    );
  }

  let youngHighVol = 0;
  if (
    daysSinceStaked !== null
    && daysSinceStaked < SYBIL_YOUNG_MAX_DAYS
    && channels > SYBIL_YOUNG_CHANNEL_FLOOR
  ) {
    const ageComponent = clamp(
      (SYBIL_YOUNG_MAX_DAYS - daysSinceStaked) / SYBIL_YOUNG_MAX_DAYS, 0, 1,
    );
    const volComponent = clamp(
      (channels - SYBIL_YOUNG_CHANNEL_FLOOR)
        / (SYBIL_YOUNG_CHANNEL_SATURATION - SYBIL_YOUNG_CHANNEL_FLOOR),
      0, 0.5,
    );
    youngHighVol = Math.min(1, ageComponent + volComponent);
  }

  const signals: Record<SybilFlag, number> = {
    subfloor_ticket: subfloorTicket,
    burn_rate: burnRate,
    narrow_custom: narrowCustom,
    young_high_vol: youngHighVol,
  };

  const risk = Math.min(1,
    SYBIL_WEIGHT_SUBFLOOR_TICKET * subfloorTicket
    + SYBIL_WEIGHT_BURN_RATE       * burnRate
    + SYBIL_WEIGHT_NARROW_CUSTOM   * narrowCustom
    + SYBIL_WEIGHT_YOUNG_HIGH_VOL  * youngHighVol,
  );

  const flags = (Object.keys(signals) as SybilFlag[])
    .filter((k) => signals[k] > 0.05)
    .sort((a, b) => signals[b] - signals[a]);

  return { risk, flags, signals };
}
