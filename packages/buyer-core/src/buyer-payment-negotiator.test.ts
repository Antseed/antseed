import { describe, expect, it, vi } from 'vitest';
import { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
import type { BuyerConnection, BuyerPeerView } from './interfaces.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import type { OneOffChannelPlan } from '@antseed/protocol/messages';

describe('BuyerPaymentNegotiator', () => {
  it('decodes a browser-compatible external spending auth header', async () => {
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: '0x00',
      spendingAuthSig: '0x1234',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const header = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    const sendSpendingAuth = vi.fn();
    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    Object.assign(negotiator as object, {
      getOrCreatePaymentMux: () => ({ sendSpendingAuth }),
      _resolveSellerAddr: async () => `0x${'3'.repeat(40)}`,
      _channelStore: null,
      _waitForLockConfirmation: async () => {},
      _lockedPeers: new Set(),
      _emit: { emit: vi.fn() },
    });

    const peer: BuyerPeerView = { peerId: toPeerId('4'.repeat(40)) };
    const connection = { state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as BuyerConnection;
    await negotiator.applyExternalSpendingAuth(peer, connection, header);

    expect(sendSpendingAuth).toHaveBeenCalledWith(payload);
  });

  describe('one-off video channels', () => {
    const peer: BuyerPeerView = { peerId: toPeerId('5'.repeat(40)) };
    const connection = { state: ConnectionState.Connected } as BuyerConnection;
    const requestId = 'video-create';
    const channelId = `0x${'9'.repeat(64)}`;

    function plan(overrides: Partial<OneOffChannelPlan> = {}): OneOffChannelPlan {
      return {
        openingReserveAmount: '1000000',
        requiredCumulativeAmount: '650000',
        requestCost: '4200000',
        ...overrides,
      };
    }

    function paymentRequired(body: Record<string, unknown>) {
      return {
        requestId,
        statusCode: 402,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    }

    function makeNegotiator(options: { available?: bigint; acked?: boolean; existing?: string | null } = {}) {
      const { available = 5_000_000n, acked = true, existing = null } = options;
      const bpm = {
        maxReserveAmountUsdc: 1_000_000n,
        maxVideoRequestUsdc: 10_000_000n,
        getActiveSession: vi.fn(() => ({ sessionId: `0x${'1'.repeat(64)}` })),
        getRequestBilling: vi.fn(() => ({
          context: { sellerPeerId: peer.peerId },
          requestFacts: { kind: 'video', video: { action: 'create' } },
          estimatedCostUsdc: 4_200_000n,
        })),
        getOneOffChannelForRequest: vi.fn(() => existing),
        isOneOffChannelConfirmed: vi.fn(() => false),
        openOneOffChannel: vi.fn(async () => channelId),
        waitForOneOffAck: vi.fn(async () => acked),
        confirmOneOffChannelOnChain: vi.fn(async () => {}),
        retireOneOffChannel: vi.fn(),
        retireSession: vi.fn(),
        reconcileReserveAmount: vi.fn(async () => {}),
      };
      const getSession = vi.fn(async () => ({ deposit: 4_200_000n, status: 1 }));
      const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
      Object.assign(negotiator as object, {
        _bpm: bpm,
        _identity: { wallet: { address: `0x${'6'.repeat(40)}` } },
        _depositsClient: { getBuyerBalance: vi.fn(async () => ({ available, reserved: 0n })) },
        _channelsClient: {
          getSession,
          getFirstSignCap: vi.fn(async () => 1_000_000n),
          getTopUpSettledThresholdBps: vi.fn(async () => 6_500n),
        },
        _isChainReachable: null,
        _onChainReadFailure: null,
        _lockedPeers: new Set([peer.peerId]),
        _bufferedPaymentRequired: new Map(),
        _pendingNeedAuth: new Set(),
        _oneOffLocks: new Map(),
        _topUpThresholdBps: null,
        _firstSignCapValue: null,
        getOrCreatePaymentMux: () => ({}),
      });
      return { negotiator, bpm, getSession };
    }

    it('opens a dedicated channel and leaves the session channel alone', async () => {
      const { negotiator, bpm } = makeNegotiator();
      const result = await negotiator.handle402(
        paymentRequired({ error: 'payment_required', code: 'one_off_channel_required', minBudgetPerRequest: '10000', suggestedAmount: '1000000', oneOffPlan: plan() }),
        peer,
        connection,
        { requestId } as never,
      );

      expect(result).toEqual({ action: 'retry' });
      expect(bpm.openOneOffChannel).toHaveBeenCalledWith(peer.peerId, requestId, plan(), expect.anything(), undefined);
      expect(bpm.retireSession).not.toHaveBeenCalled();
      expect(bpm.reconcileReserveAmount).not.toHaveBeenCalled();
    });

    it('needs no serious fee for a video within the opening cap', async () => {
      const { negotiator, bpm } = makeNegotiator();
      bpm.getRequestBilling.mockReturnValue({
        context: { sellerPeerId: peer.peerId },
        requestFacts: { kind: 'video', video: { action: 'create' } },
        estimatedCostUsdc: 800_000n,
      });
      const small = plan({ openingReserveAmount: '800000', requiredCumulativeAmount: '0', requestCost: '800000' });

      await negotiator.openOneOffChannelForRequest(peer, connection, requestId, small);

      expect(bpm.openOneOffChannel).toHaveBeenCalledWith(peer.peerId, requestId, small, expect.anything(), undefined);
    });

    it('returns insufficient_deposits when the buyer cannot cover the video', async () => {
      const { negotiator, bpm } = makeNegotiator({ available: 4_199_999n });
      const result = await negotiator.handle402(
        paymentRequired({ error: 'payment_required', code: 'one_off_channel_required', minBudgetPerRequest: '10000', suggestedAmount: '1000000', oneOffPlan: plan() }),
        peer,
        connection,
        { requestId } as never,
      );

      expect(result.action).toBe('return');
      expect(bpm.openOneOffChannel).not.toHaveBeenCalled();
    });

    it.each([
      ['wrong threshold', { requiredCumulativeAmount: '850000' }],
      ['wrong opening reserve', { openingReserveAmount: '500000' }],
      ['wrong price', { requestCost: '4300000' }],
    ])('rejects a plan with %s', async (_label, overrides) => {
      const { negotiator, bpm } = makeNegotiator();

      await expect(negotiator.openOneOffChannelForRequest(peer, connection, requestId, plan(overrides))).rejects.toMatchObject({
        code: 'peer-protocol-violation',
      });
      expect(bpm.openOneOffChannel).not.toHaveBeenCalled();
    });

    it('does not blame the seller when the contract limits cannot be read', async () => {
      const { negotiator, bpm } = makeNegotiator();
      (negotiator as any)._channelsClient.getTopUpSettledThresholdBps.mockRejectedValue(new Error('rpc down'));

      await expect(negotiator.openOneOffChannelForRequest(peer, connection, requestId, plan())).rejects.toMatchObject({
        code: 'chain-rpc-unavailable',
      });
      expect(bpm.openOneOffChannel).not.toHaveBeenCalled();
    });

    it('falls back to the on-chain reserve when the AuthAck is lost', async () => {
      const { negotiator, bpm, getSession } = makeNegotiator({ acked: false });
      let now = 1_000_000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      bpm.waitForOneOffAck.mockImplementation(async () => {
        now += 1_000;
        return false;
      });

      try {
        await negotiator.openOneOffChannelForRequest(peer, connection, requestId, plan());
      } finally {
        clock.mockRestore();
      }

      expect(getSession).toHaveBeenCalledWith(channelId);
      expect(bpm.confirmOneOffChannelOnChain).toHaveBeenCalledWith(channelId, 4_200_000n);
      // The reserve was visible from the first read; the buyer still waited out the grace window.
      expect(now - 1_000_000).toBeGreaterThanOrEqual(15_000);
    });

    it('waits for the AuthAck when the reserve is on-chain before the seller registers it', async () => {
      const { negotiator, bpm, getSession } = makeNegotiator({ acked: false });
      let polls = 0;
      bpm.waitForOneOffAck.mockImplementation(async () => ++polls >= 3);

      await negotiator.openOneOffChannelForRequest(peer, connection, requestId, plan());

      expect(getSession).toHaveBeenCalledTimes(2);
      expect(bpm.confirmOneOffChannelOnChain).not.toHaveBeenCalled();
    });

    it('refuses a second channel for a request whose channel is already confirmed', async () => {
      const { negotiator, bpm } = makeNegotiator({ existing: channelId });
      bpm.isOneOffChannelConfirmed.mockReturnValue(true);

      await expect(negotiator.openOneOffChannelForRequest(peer, connection, requestId, plan())).rejects.toMatchObject({
        code: 'peer-protocol-violation',
      });
      expect(bpm.openOneOffChannel).not.toHaveBeenCalled();
    });
  });

  describe('channel-scoped retirement', () => {
    const peerId = toPeerId('8'.repeat(40));
    const OLD_CHANNEL = `0x${'a'.repeat(64)}`;
    const NEW_CHANNEL = `0x${'b'.repeat(64)}`;

    function settledState(settled: bigint) {
      return {
        exists: true as const,
        status: 'settled' as const,
        channel: {
          buyer: '0x5EF698bF25d8A81ceeDB27caFE989fBBE9735558',
          seller: '0xc3cf17082a164C4cf3504D50962668649D327662',
          deposit: 1_000_000n,
          settled,
          metadataHash: `0x${'0'.repeat(64)}`,
          deadline: 0n,
          settledAt: 0n,
          closeRequestedAt: 0n,
          status: 2,
        },
      };
    }

    function makeNegotiator(activeSessionId: string | null) {
      const retireSession = vi.fn();
      const bpm = {
        getActiveSession: vi.fn(() => (activeSessionId ? { sessionId: activeSessionId } : null)),
        retireSession,
      };
      const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
      Object.assign(negotiator as object, { _bpm: bpm });
      return { negotiator, bpm, retireSession };
    }

    it('does not retire a newer channel with an older channel on-chain state', () => {
      const { negotiator, retireSession } = makeNegotiator(NEW_CHANNEL);

      const retired = (negotiator as unknown as {
        _retireIfNotOpenOnChain(peerId: string, onChain: unknown, expectedSessionId?: string): boolean;
      })._retireIfNotOpenOnChain(peerId, settledState(3767n), OLD_CHANNEL);

      expect(retired).toBe(false);
      expect(retireSession).not.toHaveBeenCalled();
    });

    it('retires the channel whose on-chain state was read', () => {
      const { negotiator, retireSession } = makeNegotiator(NEW_CHANNEL);

      const retired = (negotiator as unknown as {
        _retireIfNotOpenOnChain(peerId: string, onChain: unknown, expectedSessionId?: string): boolean;
      })._retireIfNotOpenOnChain(peerId, settledState(3767n), NEW_CHANNEL);

      expect(retired).toBe(true);
      expect(retireSession).toHaveBeenCalledTimes(1);
      expect(retireSession).toHaveBeenCalledWith(peerId, 'settled', 3767n, NEW_CHANNEL);
    });

    it('does not retire anything when the expected channel is no longer active', () => {
      const { negotiator, retireSession } = makeNegotiator(null);

      const retired = (negotiator as unknown as {
        _retireIfNotOpenOnChain(peerId: string, onChain: unknown, expectedSessionId?: string): boolean;
      })._retireIfNotOpenOnChain(peerId, settledState(3767n), OLD_CHANNEL);

      expect(retired).toBe(false);
      expect(retireSession).not.toHaveBeenCalled();
    });
  });

  describe('video spend cap from the caller', () => {
    const peer: BuyerPeerView = { peerId: toPeerId('7'.repeat(40)) };
    // 8 s at $0.10/s: $0.80.
    const request = {
      requestId: 'video-create',
      method: 'POST',
      path: '/api/v1/video/queue',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'wan-2.5', prompt: 'An ant', duration: '8s' })),
    };
    const route = {
      sellerPeerId: peer.peerId,
      provider: 'venice',
      service: 'wan-2.5',
      serviceApiProtocol: 'venice-video' as const,
      unitModel: { version: 1 as const, components: [{ unit: 'video_seconds' as const, priceUsd: 0.1 }] },
    };

    function makeNegotiator() {
      const bpm = { maxVideoRequestUsdc: 5_000_000n, trackRequestBilling: vi.fn(), trackRequestService: vi.fn() };
      const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
      Object.assign(negotiator as object, { _bpm: bpm });
      return { negotiator, bpm };
    }

    it('refuses a video priced above what the caller has left, before anything is sent', () => {
      const { negotiator, bpm } = makeNegotiator();
      expect(() => negotiator.trackRequestBillingContext(request, 'wan-2.5', route, 799_999n))
        .toThrow(/Video costs 0\.8\d* USDC, more than the 0\.79\d* USDC left/);
      expect(bpm.trackRequestBilling).not.toHaveBeenCalled();
    });

    it('accepts a video the caller can still afford, and any video without a cap', () => {
      const { negotiator, bpm } = makeNegotiator();
      // The price is returned, so an accepted create can report it to the caller.
      expect(negotiator.trackRequestBillingContext(request, 'wan-2.5', route, 800_000n)).toBe(800_000n);
      negotiator.trackRequestBillingContext(request, 'wan-2.5', route);
      expect(bpm.trackRequestBilling).toHaveBeenCalledTimes(2);
      expect(bpm.trackRequestBilling.mock.calls[0]![1]).toMatchObject({ estimatedCostUsdc: 800_000n });
    });
  });
});
