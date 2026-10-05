import { describe, expect, it } from 'vitest';
import {
  buildSybilContext,
  computeOnChainSybilRisk,
  SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION,
} from '../src/reputation/sybil-risk.js';
import type { PeerInfo } from '../src/types/peer.js';

const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_SEC = Math.floor(NOW_MS / 1000);

const STUB_PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };

function makePeer(stats: Partial<PeerInfo> & { peerId?: string }): PeerInfo {
  const { peerId, ...rest } = stats;
  return {
    peerId: (peerId ?? 'a'.repeat(40)) as PeerInfo['peerId'],
    lastSeen: NOW_MS,
    providers: ['openai'],
    ...rest,
  } as PeerInfo;
}

describe('buildSybilContext', () => {
  it('counts services across all peers (case-sensitive)', () => {
    const a = makePeer({
      peerId: 'a'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'claude': STUB_PRICING } },
      },
    });
    const b = makePeer({
      peerId: 'b'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax': STUB_PRICING } },
      },
    });
    const ctx = buildSybilContext([a, b]);
    expect(ctx.serviceCounts.get('gpt-5')).toBe(2);
    expect(ctx.serviceCounts.get('claude')).toBe(1);
    expect(ctx.serviceCounts.get('minimax')).toBe(1);
  });
});

describe('computeOnChainSybilRisk', () => {
  const NETWORK_PEERS: PeerInfo[] = [
    makePeer({
      peerId: 'a'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'claude': STUB_PRICING } },
      },
    }),
    makePeer({
      peerId: 'b'.repeat(40),
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    }),
  ];
  const ctx = buildSybilContext(NETWORK_PEERS);

  it('fires narrow_custom for a single exclusive service', () => {
    const peer = makePeer({
      onChainChannelCount: 50,
      onChainTotalVolumeUsdcMicros: 100_000_000,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'bespoke-model-7': STUB_PRICING } },
      },
    });
    const customCtx = buildSybilContext([peer, ...NETWORK_PEERS]);
    const { risk, flags, signals } = computeOnChainSybilRisk(peer, customCtx, NOW_MS);
    expect(signals.narrow_custom).toBe(1.0);
    expect(flags).toContain('narrow_custom');
    expect(risk).toBeGreaterThan(0);
  });

  it('does NOT fire burn_rate alone on popular brand services (Dark Signal case)', () => {
    // 46 channels/day on widely-offered services → no narrow_custom → no burn_rate flag.
    const stakedAt = NOW_SEC - 27 * 86_400;
    const peer = makePeer({
      onChainChannelCount: 1265, // 1265 / 27 ≈ 46 ch/day
      onChainTotalVolumeUsdcMicros: 3_000_000_000,
      onChainStakedAtSec: stakedAt,
            onChainLastSettledAtSec: NOW_SEC,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    const { signals } = computeOnChainSybilRisk(peer, ctx, NOW_MS);
    expect(signals.narrow_custom).toBe(0);
    expect(signals.burn_rate).toBe(0);
  });

  it('fires burn_rate when channels/day is high AND narrow_custom is set', () => {
    const stakedAt = NOW_SEC - 6 * 86_400; // young
    const peer = makePeer({
      onChainChannelCount: 429, // 429 / 6 ≈ 71 ch/day
      onChainTotalVolumeUsdcMicros: 382_000_000,
      onChainStakedAtSec: stakedAt,
            onChainLastSettledAtSec: NOW_SEC,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'medical-reasoning-r1': STUB_PRICING } },
      },
    });
    const customCtx = buildSybilContext([peer, ...NETWORK_PEERS]);
    const { signals, risk } = computeOnChainSybilRisk(peer, customCtx, NOW_MS);
    expect(signals.narrow_custom).toBe(1.0);
    expect(signals.burn_rate).toBeGreaterThan(0.5); // strongly fired
    expect(signals.young_high_vol).toBeGreaterThan(0);
    expect(risk).toBeGreaterThan(0.5);
  });

  it('fires subfloor_ticket only above the channel floor, suppressed for cheap-advertised peers', () => {
    // Below SYBIL_SUBFLOOR_MIN_CHANNELS — no flag even at micro avg.
    const tiny = makePeer({
      onChainChannelCount: 10,
      onChainTotalVolumeUsdcMicros: 100_000,
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    expect(computeOnChainSybilRisk(tiny, ctx, NOW_MS).signals.subfloor_ticket).toBe(0);

    // Above the floor, micro avg, normal pricing → fires.
    const sub = makePeer({
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 10_000_000, // avg $0.10
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING } },
      },
    });
    expect(computeOnChainSybilRisk(sub, ctx, NOW_MS).signals.subfloor_ticket).toBeGreaterThan(0.5);

    // Same shape but the peer advertises sub-floor input prices → suppressed.
    const cheap = makePeer({
      onChainChannelCount: 100,
      onChainTotalVolumeUsdcMicros: 10_000_000,
      defaultInputUsdPerMillion: SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION - 0.001,
      defaultOutputUsdPerMillion: 0.1,
      providerPricing: {
        openai: {
          defaults: {
            inputUsdPerMillion: SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION - 0.001,
            outputUsdPerMillion: 0.1,
          },
          services: { 'gpt-5': STUB_PRICING },
        },
      },
    });
    expect(computeOnChainSybilRisk(cheap, ctx, NOW_MS).signals.subfloor_ticket).toBe(0);
  });
});

describe('Real-network ordering (locks in the Auralis-cluster catch)', () => {
  // Fixtures from the Auralis wash-trading cluster caught during design.
  const STAKED_27D_AGO = NOW_SEC - 27 * 86_400;
  const STAKED_6D_AGO  = NOW_SEC -  6 * 86_400;
  const STAKED_5D_AGO  = NOW_SEC -  5 * 86_400;

  const darkSignal = makePeer({
    peerId: '1111111111111111111111111111111111111111',
    onChainChannelCount: 1263,
    onChainTotalVolumeUsdcMicros: 3_035_830_000,
        onChainStakedAtSec: STAKED_27D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax-m2.5': STUB_PRICING } },
    },
  });
  const openForge = makePeer({
    peerId: '2222222222222222222222222222222222222222',
    onChainChannelCount: 290,
    onChainTotalVolumeUsdcMicros: 1_116_980_000,
        onChainStakedAtSec: NOW_SEC - 29 * 86_400,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'gpt-5': STUB_PRICING, 'minimax-m2.5': STUB_PRICING } },
    },
  });
  const auralisMedical = makePeer({
    peerId: '3333333333333333333333333333333333333333',
    onChainChannelCount: 429,
    onChainTotalVolumeUsdcMicros: 382_300_000,
        onChainStakedAtSec: STAKED_6D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'medical-reasoning-r1': STUB_PRICING } },
    },
  });
  const auralisLegal = makePeer({
    peerId: '4444444444444444444444444444444444444444',
    onChainChannelCount: 90,
    onChainTotalVolumeUsdcMicros: 245_580_000,
        onChainStakedAtSec: STAKED_5D_AGO,
    onChainLastSettledAtSec: NOW_SEC,
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'legal-vl1': STUB_PRICING } },
    },
  });
  const peers = [darkSignal, openForge, auralisMedical, auralisLegal];
  const ctx = buildSybilContext(peers);

  it('Auralis cluster gets flagged with sybil signals', () => {
    const med = computeOnChainSybilRisk(auralisMedical, ctx, NOW_MS);
    const leg = computeOnChainSybilRisk(auralisLegal, ctx, NOW_MS);
    expect(med.flags).toContain('narrow_custom');
    expect(med.flags).toContain('burn_rate');
    expect(med.flags).toContain('young_high_vol');
    expect(med.risk).toBeGreaterThan(0.5);

    expect(leg.flags).toContain('narrow_custom');
    expect(leg.risk).toBeGreaterThan(0.20);
    expect(leg.risk).toBeLessThan(0.40);
  });

  it('legitimate peers (Dark Signal, Open Forge) carry no flags', () => {
    const ds = computeOnChainSybilRisk(darkSignal, ctx, NOW_MS);
    const of = computeOnChainSybilRisk(openForge, ctx, NOW_MS);
    expect(ds.flags).toHaveLength(0);
    expect(of.flags).toHaveLength(0);
    expect(ds.risk).toBe(0);
    expect(of.risk).toBe(0);
  });
});
