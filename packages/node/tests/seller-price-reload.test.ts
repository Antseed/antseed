import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { SellerPaymentManager } from '../src/payments/seller-payment-manager.js';
import { ChannelStore } from '../src/payments/channel-store.js';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';
import type { Provider, ProviderPricing } from '../src/interfaces/seller-provider.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType } from '../src/types/protocol.js';

function makeIdentity() {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  return { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
}

function makeProvider(name: string, pricing: ProviderPricing): Provider {
  return {
    name,
    services: ['svc'],
    pricing,
    maxConcurrency: 1,
    handleRequest: vi.fn(async (req) => ({
      requestId: req.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } })),
    })),
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

/** Mirrors the CLI reload: replace leaf objects on the shared pricing object. */
function reprice(provider: Provider, input: number): void {
  provider.pricing.defaults = { inputUsdPerMillion: input, outputUsdPerMillion: input };
}

function snapshot(providers: Provider[]): () => ReadonlyMap<Provider, ProviderPricing> {
  return () => new Map(providers.map((p) => [p, { defaults: p.pricing.defaults }]));
}

describe('seller hot price reload', () => {
  it('pins pricing when a channel is activated; new channels get reloaded prices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'price-reload-'));
    const store = new ChannelStore(dir);
    try {
      const spm = new SellerPaymentManager(makeIdentity(), {
        rpcUrl: 'http://127.0.0.1:8545', channelsContractAddress: '0x' + 'dd'.repeat(20), chainId: 31337, dataDir: dir,
      }, store);
      const provider = makeProvider('p', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
      spm.setPricingSource(snapshot([provider]));
      const activate = (id: string, peer: string) => (spm as any)._activateSession(
        { sessionId: id, peerId: peer, role: 'seller', sellerEvmAddr: '0x1', buyerEvmAddr: '0x2', nonce: 0, authMax: '0', previousConsumption: '0', deadline: 0, previousSessionId: '', tokensDelivered: '0', requestCount: 0, reservedAt: 1, settledAt: null, settledAmount: null, status: 'active', latestBuyerSig: '', latestSpendingAuthSig: null, latestMetadata: '', createdAt: 1, updatedAt: 1 },
        peer, 0n, 1_000_000n, 0n, { spendingAuthSig: '', cumulativeAmount: 0n, metadataHash: '', metadata: '' },
      );
      activate('0xold', 'buyer-a');
      reprice(provider, 9);
      activate('0xnew', 'buyer-b');
      expect(spm.getChannelPricing('0xold')?.get(provider)?.defaults.inputUsdPerMillion).toBe(1);
      expect(spm.getChannelPricing('0xnew')?.get(provider)?.defaults.inputUsdPerMillion).toBe(9);
      // Re-activation of the same channel (top-up/recovery) keeps the original pin.
      activate('0xold', 'buyer-a');
      expect(spm.getChannelPricing('0xold')?.get(provider)?.defaults.inputUsdPerMillion).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function harness(pinned: ProviderPricing | undefined) {
    const provider = makeProvider('p', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
    const recordSpend = vi.fn();
    const getPaymentRequirements = vi.fn((_id: string, _peer: string, pricing: any) => ({ minBudgetPerRequest: '1', suggestedAmount: '1', ...pricing }));
    let hasSession = pinned !== undefined;
    const spm: any = {
      hasSession: () => hasSession,
      getChannelByPeer: () => (hasSession ? { sessionId: 'ch', authMax: '0' } : null),
      getChannelPricing: () => (pinned ? new Map([[provider, pinned]]) : undefined),
      recordSpend, getPaymentRequirements,
      getCumulativeSpend: () => 0n, getAcceptedCumulative: () => 0n, getReserveMax: () => 100_000_000n,
      getEffectiveReserveMax: () => 100_000_000n, isChannelBlocked: () => false,
      waitForPendingAuths: async () => {}, awaitAcceptedAtLeast: async () => true,
      beginBillableRequest: vi.fn(), endBillableRequest: vi.fn(), hasInFlightRequests: () => false, hasClosingChannel: () => false,
    };
    const handler = new SellerRequestHandler({
      identity: { peerId: 's'.repeat(40) } as any, providers: [provider], sellerPaymentManager: spm,
      sessionTracker: null, channelsClient: {} as any, announcer: null, emit: () => false,
    });
    const frames: Uint8Array[] = [];
    const sendNeedAuth = vi.fn();
    const { mux } = handler.handleConnection({ send: (f: Uint8Array) => frames.push(f), hasRemoteCapability: () => false } as any, 'b'.repeat(40), { sendNeedAuth, sendPaymentRequired: vi.fn() } as any);
    const send = (i: number) => mux.handleFrame({ type: MessageType.HttpRequest, messageId: i, payload: encodeHttpRequest({ requestId: `r${i}`, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'svc' })) }) });
    return { provider, recordSpend, getPaymentRequirements, sendNeedAuth, send, frames, setSession: (v: boolean) => { hasSession = v; } };
  }

  it('bills an existing channel at its pinned rate after a price increase', async () => {
    const h = harness({ defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
    reprice(h.provider, 5);
    await h.send(1);
    expect(h.recordSpend).toHaveBeenCalledWith('ch', 1_000_000n);
    expect(h.sendNeedAuth).toHaveBeenCalledWith(expect.objectContaining({ lastRequestCost: '1000000' }), );
  });

  it('keeps an existing channel on its pinned rate after a price cut', async () => {
    const h = harness({ defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } });
    reprice(h.provider, 0.5);
    await h.send(1);
    expect(h.recordSpend).toHaveBeenCalledWith('ch', 1_000_000n);
  });

  it('quotes live prices to buyers without a channel (no stale quote, no metadata needed)', async () => {
    const h = harness(undefined);
    await h.send(1);
    reprice(h.provider, 7);
    await h.send(2);
    const quoted = h.getPaymentRequirements.mock.calls.map((call) => call[2].inputUsdPerMillion);
    expect(quoted).toEqual([1, 7]);
    const body = JSON.parse(new TextDecoder().decode(decodeHttpResponse(decodeFrame(h.frames[1]!)!.message.payload).body));
    expect(body).toMatchObject({ error: 'payment_required', inputUsdPerMillion: 7 });
    expect(h.provider.handleRequest).not.toHaveBeenCalled();
  });
});

describe('announcer metadata after price reload', () => {
  function config(providers: AnnouncerConfig['providers']): AnnouncerConfig {
    return {
      identity: makeIdentity() as any, dht: { announce: vi.fn() } as any, providers, region: 'us',
      pricing: new Map(), reannounceIntervalMs: 60_000, signalingPort: 0,
    };
  }

  it('announces reloaded per-instance and cached-input pricing', async () => {
    const a: ProviderPricing = { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
    const b: ProviderPricing = { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 4 } };
    const announcer = new PeerAnnouncer(config([
      { provider: 'openai', services: ['x'], maxConcurrency: 1, pricing: a },
      { provider: 'openai', services: ['y'], maxConcurrency: 1, pricing: b },
    ]));
    a.defaults = { inputUsdPerMillion: 5, outputUsdPerMillion: 6, cachedInputUsdPerMillion: 0.5 };
    b.services = { y: { inputUsdPerMillion: 7, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.25 } };
    await announcer.refreshMetadata();
    const [first, second] = announcer.getLatestMetadata()!.providers;
    expect(first!.defaultPricing).toEqual({ inputUsdPerMillion: 5, outputUsdPerMillion: 6, cachedInputUsdPerMillion: 0.5 });
    expect(second!.defaultPricing).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 4 });
    expect(second!.servicePricing).toEqual({ y: { inputUsdPerMillion: 7, outputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.25 } });
  });

  it('does not let a slower, older metadata build overwrite a newer one', async () => {
    const pricing: ProviderPricing = { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } };
    let releaseOld!: () => void;
    const oldBuildGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const cfg = config([{ provider: 'p', services: ['x'], maxConcurrency: 1, pricing }]);
    cfg.paymentsEnabled = true;
    cfg.stakingClient = { getAgentId: vi.fn(async () => { await oldBuildGate; return 1n; }) } as any;
    cfg.channelsClient = { getAgentStats: vi.fn(async () => ({ channelCount: 0, ghostCount: 0 })) } as any;
    const announcer = new PeerAnnouncer(cfg);
    const slowAnnounce = announcer.announce(); // snapshots old prices, then blocks on chain stats
    await Promise.resolve();
    pricing.defaults = { inputUsdPerMillion: 2, outputUsdPerMillion: 2 };
    await announcer.refreshMetadata();
    releaseOld();
    await slowAnnounce;
    expect(announcer.getLatestMetadata()!.providers[0]!.defaultPricing.inputUsdPerMillion).toBe(2);
  });
});
