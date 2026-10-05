import { describe, expect, it, vi } from 'vitest';
import { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
import type { BuyerConnection, BuyerPeerView } from './interfaces.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import type { ReserveAuthorizationPlan } from '@antseed/protocol/messages';

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

  describe('reserve plans', () => {
    const peer: BuyerPeerView = { peerId: toPeerId('5'.repeat(40)) };
    const connection = { state: ConnectionState.Connected } as BuyerConnection;
    const requestId = 'video-create';

    function plan(overrides: Partial<ReserveAuthorizationPlan> = {}): ReserveAuthorizationPlan {
      return {
        currentReserveAmount: '1000000',
        requiredCumulativeAmount: '650000',
        finalReserveAmount: '4200000',
        requestCost: '4200000',
        ...overrides,
      };
    }

    function makeNegotiator(available = 3_200_000n) {
      const events: string[] = [];
      const getSession = vi.fn()
        .mockResolvedValueOnce({ deposit: 1_000_000n, status: 1 })
        .mockResolvedValue({ deposit: 4_200_000n, status: 1 });
      const bpm = {
        getActiveSession: vi.fn(() => ({ sessionId: `0x${'1'.repeat(64)}` })),
        getRequestBilling: vi.fn(() => ({
          context: { sellerPeerId: peer.peerId },
          requestFacts: { kind: 'video', video: { action: 'create' } },
          estimatedCostUsdc: 4_200_000n,
        })),
        getDeliveredAmount: vi.fn(() => 0n),
        getPendingVideoTotal: vi.fn(() => 0n),
        reconcileReserveAmount: vi.fn(async () => {}),
        getBalance: vi.fn(async () => ({ available, reserved: 1_000_000n })),
        signAndSendReserveBatch: vi.fn(async (
          _peer: string,
          _request: string,
          amount: bigint,
          _cost: bigint,
          _deposit: bigint,
          reserve: bigint,
        ) => events.push(`batch:${amount}:${reserve}`)),
      };
      const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
      Object.assign(negotiator as object, {
        _bpm: bpm,
        _channelsClient: { getSession, getTopUpSettledThresholdBps: vi.fn(async () => 6_500n) },
        _lockedPeers: new Set([peer.peerId]),
        _pendingNeedAuth: new Set(),
        _reservePlanLocks: new Map(),
        _topUpThresholdBps: null,
        getOrCreatePaymentMux: () => ({}),
      });
      return { negotiator, bpm, events };
    }

    it('signs the contract threshold and tops up to the exact requested reserve', async () => {
      const { negotiator, events } = makeNegotiator();

      await negotiator.authorizeReservePlan(peer, connection, requestId, plan());

      expect(events).toEqual(['batch:650000:4200000']);
    });

    it('checks the full additional reserve before signing the advance', async () => {
      const { negotiator, bpm } = makeNegotiator(200_000n);

      await expect(negotiator.authorizeReservePlan(peer, connection, requestId, plan())).rejects.toMatchObject({
        code: 'buyer-deposits-insufficient',
      });
      expect(bpm.signAndSendReserveBatch).not.toHaveBeenCalled();
    });

    it('rejects a reserve plan that does not match the on-chain threshold', async () => {
      const { negotiator, bpm } = makeNegotiator();

      await expect(negotiator.authorizeReservePlan(peer, connection, requestId, plan({ requiredCumulativeAmount: '850000' }))).rejects.toMatchObject({
        code: 'peer-protocol-violation',
      });
      expect(bpm.signAndSendReserveBatch).not.toHaveBeenCalled();
    });
  });
});
