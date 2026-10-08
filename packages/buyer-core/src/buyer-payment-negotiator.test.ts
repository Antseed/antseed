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
});
