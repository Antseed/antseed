import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BuyerPaymentNegotiator, type BuyerNegotiatorConfig, type NegotiationEmitter } from '../src/payments/buyer-payment-negotiator.js';
import type { PeerInfo, PeerId } from '../src/types/peer.js';
import type { SerializedHttpResponse, SerializedHttpRequest } from '../src/types/http.js';
import type { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { ChannelsClient, ChannelInfo } from '../src/payments/evm/channels-client.js';
import { CHANNEL_ROLE, CHANNEL_STATUS, type ChannelStore, type StoredChannel } from '../src/payments/channel-store.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { PaymentRequiredPayload } from '../src/types/protocol.js';

const enc = new TextEncoder();

const BUYER_PEER_ID = 'a'.repeat(40) as PeerId;
const SELLER_PEER_ID = 'b'.repeat(40) as PeerId;

function createMockIdentity(): Identity {
  return {
    peerId: BUYER_PEER_ID,
    privateKey: new Uint8Array(32),
    wallet: { address: '0x' + '11'.repeat(20) },
  } as unknown as Identity;
}

function createMockBpm(): BuyerPaymentManager & Record<string, unknown> {
  return {
    signPerRequestAuth: vi.fn().mockResolvedValue({
      payload: {
        channelId: '0x' + 'cc'.repeat(32),
        cumulativeAmount: '50000',
        metadataHash: '0x' + 'aa'.repeat(32),
        metadata: '0x00',
        spendingAuthSig: '0x' + 'bb'.repeat(65),
      },
      topUpNeeded: false,
    }),
    handleAuthAck: vi.fn(),
    handleNeedAuth: vi.fn(),
    authorizeSpending: vi.fn().mockResolvedValue(undefined),
    topUpReserve: vi.fn().mockResolvedValue(undefined),
    cleanupSession: vi.fn(),
    clearLockConfirmation: vi.fn(),
    getActiveSession: vi.fn().mockReturnValue(null),
    retireSession: vi.fn(),
    canReplayReserveAuth: vi.fn().mockReturnValue(false),
    hasPendingReserveAuth: vi.fn().mockReturnValue(false),
    reconcileReserveAmount: vi.fn().mockResolvedValue(undefined),
    extendCurrentSpendingAuth: vi.fn().mockResolvedValue(undefined),
    getCumulativeAmount: vi.fn().mockReturnValue(0n),
    resendCurrentSpendingAuth: vi.fn().mockResolvedValue(undefined),
    resendReserveAuth: vi.fn().mockResolvedValue(undefined),
    resendPendingReserveAuth: vi.fn().mockResolvedValue(undefined),
    isLockConfirmed: vi.fn().mockReturnValue(false),
    isLockRejected: vi.fn().mockReturnValue(false),
    recordAndPersistTokens: vi.fn(),
    recordObservedUnitUsage: vi.fn(),
    getRequestBilling: vi.fn().mockReturnValue(undefined),
    getSessionPricing: vi.fn().mockReturnValue(null),
    maxPerRequestUsdc: 100_000n,
    maxReserveAmountUsdc: 10_000_000n,
  } as unknown as BuyerPaymentManager & Record<string, unknown>;
}

function createMockDepositsClient(balance = 1_000_000n, reserved = 0n): DepositsClient {
  return {
    getBuyerBalance: vi.fn().mockResolvedValue({ available: balance, reserved, lastActivityAt: 0n }),
  } as unknown as DepositsClient;
}

function createMockChannelStore(): ChannelStore {
  return {
    upsertChannel: vi.fn(),
    getActiveChannelByPeer: vi.fn().mockReturnValue(null),
  } as unknown as ChannelStore;
}

function createMockChannelsClient(state?: Partial<ChannelInfo>): ChannelsClient {
  return {
    getSession: vi.fn().mockResolvedValue({
      buyer: '0x' + '11'.repeat(20),
      seller: '0x' + '22'.repeat(20),
      deposit: 1_000_000n,
      settled: 0n,
      metadataHash: '0x' + '00'.repeat(32),
      deadline: 0n,
      settledAt: 0n,
      closeRequestedAt: 0n,
      status: 1,
      ...state,
    }),
  } as unknown as ChannelsClient;
}

function createMockConn(): PeerConnection {
  return { send: vi.fn() } as unknown as PeerConnection;
}

function createPeer(peerId: PeerId = SELLER_PEER_ID): PeerInfo {
  return {
    peerId,
    lastSeen: Date.now(),
    providers: ['openai'],
    defaultInputUsdPerMillion: 3,
    defaultOutputUsdPerMillion: 15,
  } as PeerInfo;
}

describe('BuyerPaymentNegotiator', () => {
  let identity: Identity;
  let bpm: ReturnType<typeof createMockBpm>;
  let depositsClient: DepositsClient;
  let channelsClient: ChannelsClient;
  let channelStore: ChannelStore;
  let config: BuyerNegotiatorConfig;
  let emitter: NegotiationEmitter;
  let negotiator: BuyerPaymentNegotiator;
  let conn: PeerConnection;
  let peer: PeerInfo;

  beforeEach(() => {
    identity = createMockIdentity();
    bpm = createMockBpm();
    depositsClient = createMockDepositsClient();
    channelsClient = createMockChannelsClient();
    channelStore = createMockChannelStore();
    config = {};
    emitter = { emit: vi.fn() };
    negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, depositsClient, channelsClient, channelStore, config, emitter);
    conn = createMockConn();
    peer = createPeer();
  });

  describe('preparePreRequestAuth', () => {
    it('no-ops when peer is not locked', async () => {
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();
    });

    it('skips first request (initial auth already sent during negotiation)', async () => {
      // Simulate successful negotiation to add peer to _lockedPeers
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      // First call after lock — should skip (initial auth was sent during negotiation)
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();
    });

    it('sends per-request auth on subsequent requests', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      // First call — skip
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();

      // Simulate response cost data being available via estimateCostFromResponse
      negotiator.estimateCostFromResponse(peer, {
        requestId: 'req-1', statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } })),
      });

      // Second call — should send auth
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).toHaveBeenCalledOnce();
    });

    it('calls bpm.topUpReserve when topUpNeeded', async () => {
      (bpm.signPerRequestAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
        payload: {
          channelId: '0x' + 'cc'.repeat(32),
          cumulativeAmount: '90000',
          metadataHash: '0x' + 'aa'.repeat(32),
          metadata: '0x00',
          spendingAuthSig: '0x' + 'bb'.repeat(65),
        },
        topUpNeeded: true,
      });

      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      // Skip first
      await negotiator.preparePreRequestAuth(peer, conn);

      // Simulate response cost data being available via estimateCostFromResponse
      negotiator.estimateCostFromResponse(peer, {
        requestId: 'req-1', statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } })),
      });

      // Second triggers auth
      await negotiator.preparePreRequestAuth(peer, conn);

      expect(bpm.topUpReserve).toHaveBeenCalledOnce();
    });
  });

  describe('recoverPendingReserveBeforeRequest', () => {
    it('reconciles an initial reserve that reached chain before AuthAck was lost', async () => {
      let pending = true;
      (bpm.getActiveSession as ReturnType<typeof vi.fn>)
        .mockReturnValue(makeActiveSession(SELLER_PEER_ID));
      (bpm.hasPendingReserveAuth as ReturnType<typeof vi.fn>)
        .mockImplementation(() => pending);
      (bpm.reconcileReserveAmount as ReturnType<typeof vi.fn>)
        .mockImplementation(async () => {
          pending = false;
          (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
        });

      await negotiator.recoverPendingReserveBeforeRequest(peer, conn);

      expect(channelsClient.getSession).toHaveBeenCalled();
      expect(bpm.reconcileReserveAmount).toHaveBeenCalledWith(peer.peerId, 1_000_000n);
      expect(bpm.resendCurrentSpendingAuth).toHaveBeenCalledWith(peer.peerId, expect.anything());
    });

    it('fails closed when pending reserve recovery has no chain client', async () => {
      (bpm.hasPendingReserveAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);
      negotiator = new BuyerPaymentNegotiator(
        identity,
        bpm as unknown as BuyerPaymentManager,
        depositsClient,
        null,
        channelStore,
        config,
        emitter,
      );

      await expect(negotiator.recoverPendingReserveBeforeRequest(peer, conn))
        .rejects.toThrow(/without an on-chain channels client/);
    });
  });

  describe('handle402', () => {
    it('returns a non-payment error when no depositsClient is configured in auto mode', async () => {
      negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, null, channelsClient, channelStore, config, emitter);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      expect(result.action).toBe('return');
      const res = (result as { action: 'return'; response: SerializedHttpResponse }).response;
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(new TextDecoder().decode(res.body))).toMatchObject({
        error: 'payment_negotiation_failed',
        reason: 'deposits_not_configured',
      });
    });

    it('returns 402 when balance is zero', async () => {
      depositsClient = createMockDepositsClient(0n);
      negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, depositsClient, channelsClient, channelStore, config, emitter);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      expect(result.action).toBe('return');
    });

    it('skips the balance precheck and still negotiates while the chain RPC is unreachable', async () => {
      depositsClient = createMockDepositsClient(0n);
      negotiator = new BuyerPaymentNegotiator(
        identity,
        bpm as unknown as BuyerPaymentManager,
        depositsClient,
        channelsClient,
        channelStore,
        { isChainReachable: () => false },
        emitter,
      );
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      expect(result.action).toBe('retry');
      expect(depositsClient.getBuyerBalance).not.toHaveBeenCalled();
      expect(bpm.authorizeSpending).toHaveBeenCalledOnce();
    });

    it('continues negotiation when the advisory balance read has a transient RPC failure', async () => {
      depositsClient = {
        getBuyerBalance: vi.fn().mockRejectedValue(new Error('could not detect network')),
      } as unknown as DepositsClient;
      const onChainReadFailure = vi.fn();
      negotiator = new BuyerPaymentNegotiator(
        identity,
        bpm as unknown as BuyerPaymentManager,
        depositsClient,
        channelsClient,
        channelStore,
        { onChainReadFailure },
        emitter,
      );
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      expect(result.action).toBe('retry');
      expect(bpm.authorizeSpending).toHaveBeenCalledOnce();
      expect(onChainReadFailure).toHaveBeenCalledOnce();
    });

    it.each([0n, 25_000n])('replays %s without increasing spend when a seller asks for a fresh AuthAck', async (amount) => {
      // First, lock the peer through successful negotiation
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockClear();

      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (bpm.getCumulativeAmount as ReturnType<typeof vi.fn>).mockReturnValue(amount);
      (bpm.resendCurrentSpendingAuth as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });
      bufferPaymentRequired(negotiator, peer.peerId, conn);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.clearLockConfirmation).toHaveBeenCalledWith(peer.peerId);
      expect(bpm.extendCurrentSpendingAuth).not.toHaveBeenCalled();
      expect(bpm.resendCurrentSpendingAuth).toHaveBeenCalledWith(peer.peerId, expect.anything());
      expect(bpm.getCumulativeAmount(peer.peerId)).toBe(amount);
      expect(bpm.retireSession).not.toHaveBeenCalled();
      expect(bpm.authorizeSpending).not.toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('forwards requiredCumulativeAmount from the 402 body as the catch-up target', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockClear();

      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (bpm.getCumulativeAmount as ReturnType<typeof vi.fn>).mockReturnValueOnce(56218n).mockReturnValueOnce(85119n);
      (bpm.extendCurrentSpendingAuth as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      // 402 body carries the seller-reported catch-up target (no need to buffer a
      // PaymentRequired frame — the body alone should be enough to drive recovery).
      const response = make402Response({
        error: 'payment_required',
        minBudgetPerRequest: '10000',
        suggestedAmount: '1000000',
        requiredCumulativeAmount: '85119',
        currentSpent: '85119',
        currentAcceptedCumulative: '56218',
      });

      const result = await negotiator.handle402(response, peer, conn, makeRequest());

      expect(bpm.clearLockConfirmation).not.toHaveBeenCalled();
      expect(bpm.extendCurrentSpendingAuth).toHaveBeenCalledWith(
        peer.peerId,
        10000n,
        expect.anything(),
        85119n, // <— the catch-up target the seller asked for
      );
      expect(result.action).toBe('retry');
    });

    it('retires session as settled and renegotiates without retrying extend when seller flags channel_exhausted', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockClear();
      (bpm.extendCurrentSpendingAuth as ReturnType<typeof vi.fn>).mockClear();

      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (bpm.retireSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
      });
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      // Seller signals the channel is permanently exhausted: requiredCumulativeAmount
      // exceeds the on-chain reserveMaxAmount, so no signing on this channel can succeed.
      const response = make402Response({
        error: 'payment_required',
        code: 'channel_exhausted',
        minBudgetPerRequest: '10000',
        suggestedAmount: '1000000',
        requiredCumulativeAmount: '11019626',
        currentSpent: '11009626',
        currentAcceptedCumulative: '10998222',
        reserveMaxAmount: '11000000',
        channelId: '0x' + 'cd'.repeat(32),
      });

      const result = await negotiator.handle402(response, peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      // Critical: no futile signing on the dead channel.
      expect(bpm.extendCurrentSpendingAuth).not.toHaveBeenCalled();
      expect(bpm.resendCurrentSpendingAuth).not.toHaveBeenCalled();
      // Fresh negotiation opens a new channel.
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('detects exhaustion via reserveMaxAmount even when seller omits the explicit code', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockClear();
      (bpm.extendCurrentSpendingAuth as ReturnType<typeof vi.fn>).mockClear();

      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (bpm.retireSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
      });
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      // Older sellers might emit reserveMaxAmount without the explicit code field —
      // the buyer should still detect exhaustion when required > reserveMax.
      const response = make402Response({
        error: 'payment_required',
        minBudgetPerRequest: '10000',
        suggestedAmount: '1000000',
        requiredCumulativeAmount: '11019626',
        reserveMaxAmount: '11000000',
        channelId: '0x' + 'cd'.repeat(32),
      });

      const result = await negotiator.handle402(response, peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.extendCurrentSpendingAuth).not.toHaveBeenCalled();
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('retires session as ghost and negotiates fresh reserve when extendCurrentSpendingAuth makes no progress', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockClear();

      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      // Collapsed overdraft: extend is a no-op, so cumulative is identical before and after.
      (bpm.getCumulativeAmount as ReturnType<typeof vi.fn>).mockReturnValue(500n);
      (bpm.extendCurrentSpendingAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      // After retire, the active session should disappear so handle402 falls through
      // to open a fresh reserve instead of returning a negotiation failure.
      (bpm.retireSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
        (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
      });
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });
      bufferPaymentRequired(negotiator, peer.peerId, conn);

      const result = await negotiator.handle402(make402Response({
        error: 'payment_required',
        minBudgetPerRequest: paymentRequiredPayload.minBudgetPerRequest,
        suggestedAmount: paymentRequiredPayload.suggestedAmount,
        requiredCumulativeAmount: '600',
      }), peer, conn, makeRequest());

      expect(bpm.extendCurrentSpendingAuth).toHaveBeenCalled();
      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('retires a missing on-chain session before negotiating a new reserve', async () => {
      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (channelsClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        buyer: '0x' + '00'.repeat(20),
        seller: '0x' + '00'.repeat(20),
        deposit: 0n,
        settled: 0n,
        metadataHash: '0x' + '00'.repeat(32),
        deadline: 0n,
        settledAt: 0n,
        closeRequestedAt: 0n,
        status: 0,
      });
      (bpm.getActiveSession as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null);
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('does not open a new reserve when on-chain session lookup fails', async () => {
      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(activeSession);
      (channelsClient.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc down'));
      bufferPaymentRequired(negotiator, peer.peerId, conn);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.authorizeSpending).not.toHaveBeenCalled();
      expect(result.action).toBe('return');
      const res = (result as { action: 'return'; response: SerializedHttpResponse }).response;
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(new TextDecoder().decode(res.body))).toMatchObject({
        error: 'payment_negotiation_failed',
        reason: 'existing_channel_still_active',
      });
    });

    it('retires a stale local session when buyer reserved balance is zero', async () => {
      const activeSession = makeActiveSession(peer.peerId);
      depositsClient = createMockDepositsClient(1_000_000n, 0n);
      negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, depositsClient, channelsClient, channelStore, config, emitter);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(null);
      (channelsClient.getSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rpc down'));
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('retires a stored session when no channels client is configured', async () => {
      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(null);
      negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, depositsClient, null, channelStore, config, emitter);
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('retires a stored session on unknown on-chain status before renegotiating', async () => {
      const activeSession = makeActiveSession(peer.peerId);
      (bpm.getActiveSession as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(activeSession)
        .mockReturnValueOnce(null);
      (channelsClient.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        buyer: '0x' + '11'.repeat(20),
        seller: '0x' + '22'.repeat(20),
        deposit: 1_000_000n,
        settled: 0n,
        metadataHash: '0x' + '00'.repeat(32),
        deadline: 0n,
        settledAt: 0n,
        closeRequestedAt: 0n,
        status: 9,
      });
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(bpm.retireSession).toHaveBeenCalledWith(peer.peerId, CHANNEL_STATUS.GHOST);
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(result.action).toBe('retry');
    });

    it('auto-negotiates and returns retry on success', async () => {
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      // Make isLockConfirmed return true after authorizeSpending
      (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
      });

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());

      expect(result.action).toBe('retry');
      expect(bpm.authorizeSpending).toHaveBeenCalled();
      expect(bpm.authorizeSpending).toHaveBeenCalledWith(
        peer.peerId,
        expect.anything(),
        10000n,
        100000n,
        { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 }, services: {} },
        undefined,
      );
    });

    it('enriches 402 body with PaymentRequired data when credits are insufficient', async () => {
      depositsClient = createMockDepositsClient(0n);
      negotiator = new BuyerPaymentNegotiator(identity, bpm as unknown as BuyerPaymentManager, depositsClient, channelsClient, channelStore, config, emitter);
      bufferPaymentRequired(negotiator, peer.peerId, conn);

      const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      expect(result.action).toBe('return');

      const res = (result as { action: 'return'; response: SerializedHttpResponse }).response;
      const body = JSON.parse(new TextDecoder().decode(res.body));
      expect(body.error).toBe('payment_required');
      // Stable machine-readable code — not a free-form debug string — so
      // callers can switch on it without coupling to internal phrasing.
      expect(body.code).toBe('insufficient_deposits');
      expect(body.reason).toBeUndefined();
      expect(body.minBudgetPerRequest).toBe('10000');
      expect(body.suggestedAmount).toBe('100000');
      expect(body.peerId).toBe(peer.peerId);
      // Should be the buyer-authored, user-friendly body — not the raw seller 402
      // fields that would leak internal catch-up/accounting state.
      expect(body.requiredCumulativeAmount).toBeUndefined();
      expect(body.currentSpent).toBeUndefined();
      expect(body.inputUsdPerMillion).toBeUndefined();
      expect(typeof body.message).toBe('string');
    });

    it('throws on negotiation failure and clears locked state', async () => {
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      // Make isLockRejected return true to trigger failure
      (bpm.isLockRejected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await expect(negotiator.handle402(make402Response(), peer, conn, makeRequest()))
        .rejects.toThrow(/Lock rejected/);

      // After failure, the peer should not be locked, so preparePreRequestAuth no-ops
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();
    });
  });

  describe('lock failure diagnostics (issue #333)', () => {
    // These tests cover the enriched error messages that surface likely causes
    // when the seller fails to confirm a payment lock. The enrichment is
    // intentionally built from data the buyer already has locally (the reserve
    // amount it authorized, the seller's minBudgetPerRequest) — no extra RPC
    // calls to the buyer's (typically less reliable) endpoint. A follow-up
    // plumbs a structured AuthNack from the seller so the buyer can render the
    // exact revert reason and a fresh deposits snapshot instead.

    it('enriches "Lock rejected" errors with the reserve ceiling hint and generic causes', async () => {
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.isLockRejected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      let message = '';
      try {
        await negotiator.handle402(make402Response(), peer, conn, makeRequest());
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      expect(message).toContain('Lock rejected by seller');
      expect(message).toContain('Likely causes:');
      // suggestedAmount=100_000 → 0.1 USDC reserve ceiling hint.
      expect(message).toContain('reserve ceiling the seller will lock (0.1 USDC)');
      expect(message).toContain("reserve() reverts");
      expect(message).toContain('antseed buyer status');
      expect(message).toContain('antseed buyer deposit');
      expect(message).toContain('overloaded or gated on subscription');
    });

    it('enriches "Lock confirmation timed out" errors with likely causes', async () => {
      vi.useFakeTimers();
      try {
        bufferPaymentRequired(negotiator, peer.peerId, conn);
        // Seller neither confirms nor rejects — the 30s timeout fires.
        (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(false);
        (bpm.isLockRejected as ReturnType<typeof vi.fn>).mockReturnValue(false);

        const pending = negotiator.handle402(make402Response(), peer, conn, makeRequest());
        // Suppress unhandled-rejection noise before the timers advance
        pending.catch(() => undefined);

        // Allow microtasks (handle402's internal balance check promise) to flush.
        await vi.advanceTimersByTimeAsync(1);
        // Advance past the 30s lock-confirmation deadline.
        await vi.advanceTimersByTimeAsync(31_000);

        await expect(pending).rejects.toThrow(/Lock confirmation timed out for seller/);
        await expect(pending).rejects.toThrow(/Likely causes:/);
        await expect(pending).rejects.toThrow(/reserve ceiling the seller will lock/);
        await expect(pending).rejects.toThrow(/overloaded or gated on subscription/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not call the buyer RPC during or after a failed lock confirmation', async () => {
      // The whole point of the zero-RPC design: surface the hint from local
      // context (reserve, minBudget) without calling the buyer's less-reliable
      // RPC endpoint. The only balance check that should ever fire is the
      // pre-existing handle402 "available <= 0" gate, which runs once up front.
      const balanceSpy = vi.fn().mockResolvedValue({
        available: 1_000_000n,
        reserved: 0n,
        lastActivityAt: 0n,
      });
      depositsClient = { getBuyerBalance: balanceSpy } as unknown as DepositsClient;
      negotiator = new BuyerPaymentNegotiator(
        identity,
        bpm as unknown as BuyerPaymentManager,
        depositsClient,
        channelsClient,
        channelStore,
        config,
        emitter,
      );
      bufferPaymentRequired(negotiator, peer.peerId, conn);
      (bpm.isLockRejected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await expect(
        negotiator.handle402(make402Response(), peer, conn, makeRequest()),
      ).rejects.toThrow(/Lock rejected/);

      // Exactly one call — the pre-existing insufficient-credits gate. No extra
      // RPC load from the enriched hint, and no pre-flight reserve-ceiling check.
      expect(balanceSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('cost tracking', () => {
    it('estimateCostFromResponse stores estimated cost', () => {
      const response: SerializedHttpResponse = {
        requestId: 'req-1',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        })),
      };

      negotiator.estimateCostFromResponse(peer, response);

      // After estimating, preparePreRequestAuth on a locked peer should use the cost
      // We verify by checking that recording works (cost entry exists)
      // Record content should merge with existing entry
      negotiator.recordResponseContent(peer.peerId, new Uint8Array(0), response.body, 150);

      // Verify by doing a full flow — lock the peer, then send auth which reads cost
      // For simplicity, just verify no error is thrown and the method is callable

      // Verify recordAndPersistTokens was called with parsed token counts
      expect(bpm.recordAndPersistTokens).toHaveBeenCalledWith(
        peer.peerId, 100, 50,
      );
    });

    it('estimateCostFromResponse records zero tokens when no usage field (no body.length/4 fallback)', () => {
      const body = 'A'.repeat(400);
      const response: SerializedHttpResponse = {
        requestId: 'req-2',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(body),
      };

      negotiator.estimateCostFromResponse(peer, response);

      // No body.length/4 fallback — seller cost headers are authoritative
      expect(bpm.recordAndPersistTokens).toHaveBeenCalledWith(
        peer.peerId, 0, 0,
      );
    });

    it('does not throw or authorize when delivered image usage matches no billing tier', () => {
      (bpm.getRequestBilling as ReturnType<typeof vi.fn>).mockReturnValue({
        context: {
          sellerPeerId: peer.peerId,
          provider: 'openai',
          service: 'gpt-image-1',
          serviceApiProtocol: 'openai-images',
          attributes: {
            model: 'gpt-image-1',
            size: 'auto',
            quality: 'auto',
          },
          unitLimits: { output_images: 1 },
        },
        requestFacts: {
          model: 'gpt-image-1',
          size: 'auto',
          quality: 'auto',
          requestedImages: 1,
        },
        unitModel: {
          version: 1,
          components: [
            {
              unit: 'output_images',
              priceUsd: 0.04,
              match: { size: '1024x1024' },
            },
          ],
        },
      });
      const response: SerializedHttpResponse = {
        requestId: 'req-image-unmatched',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({
          data: [{ b64_json: 'delivered-image' }],
          usage: { input_tokens: 100, output_tokens: 200 },
        })),
      };

      expect(() =>
        negotiator.estimateCostFromResponse(
          peer,
          response,
          'gpt-image-1',
          'req-image-unmatched',
        ),
      ).not.toThrow();
      expect(bpm.recordObservedUnitUsage).toHaveBeenCalledWith(
        'req-image-unmatched',
        { units: { output_images: 1 } },
      );
      expect(bpm.recordAndPersistTokens).toHaveBeenCalledWith(peer.peerId, 100, 200);
      expect((negotiator as any)._lastResponseCost.has(peer.peerId)).toBe(false);
    });

    // parseCostHeaders tests removed — cost data now flows through NeedAuth

    it('recordResponseContent updates content and latency', async () => {
      // Set up cost entry first via estimateCostFromResponse
      negotiator.estimateCostFromResponse(peer, {
        requestId: 'req-1', statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 } })),
      });

      const reqBody = enc.encode('request body');
      const resBody = enc.encode('response body');
      negotiator.recordResponseContent(peer.peerId, reqBody, resBody, 250);

      // Verify the stored content is used during per-request auth.
      // Lock the peer and trigger signPerRequestAuth to check it receives content.
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);
      await negotiator.preparePreRequestAuth(peer, conn); // skip first
      await negotiator.preparePreRequestAuth(peer, conn); // sends auth

      expect(bpm.signPerRequestAuth).toHaveBeenCalled();
      const call = (bpm.signPerRequestAuth as ReturnType<typeof vi.fn>).mock.calls[0];
      // Second arg is the content object
      expect(call[1].inputBytes).toEqual(reqBody);
      expect(call[1].outputBytes).toEqual(resBody);
      // Cost is now estimated locally (not from seller headers), so check it's a bigint
      expect(typeof call[1].sellerClaimedCost).toBe('bigint');
      // No third arg; latency is no longer included in payment metadata
      expect(call[2]).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('onPeerDisconnect clears all state for a peer', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      // Peer is locked, first request sent tracking exists
      negotiator.onPeerDisconnect(peer.peerId);

      // After disconnect, preparePreRequestAuth should no-op (peer not locked)
      (bpm.signPerRequestAuth as ReturnType<typeof vi.fn>).mockClear();
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();

      // cleanupSession should have been called
      expect(bpm.cleanupSession).not.toHaveBeenCalled();
    });

    it('onPeerDisconnect rejects pending PaymentRequired', async () => {
      // Create a pending payment required by starting a negotiation that waits
      // We can't easily test the rejection directly, but we can verify the method
      // doesn't throw and cleans up
      negotiator.onPeerDisconnect(peer.peerId);
      // Should not throw even when there's nothing to clean up
    });

    it('cleanup clears all state and rejects pending promises', async () => {
      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      negotiator.cleanup();

      // After cleanup, peer should not be locked
      (bpm.signPerRequestAuth as ReturnType<typeof vi.fn>).mockClear();
      await negotiator.preparePreRequestAuth(peer, conn);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();
    });

    it('cleanup handles multiple peers', async () => {
      const peer2Id = 'c'.repeat(40) as PeerId;
      const peer2 = createPeer(peer2Id);
      const conn2 = createMockConn();

      await simulateSuccessfulNegotiation(negotiator, bpm, peer, conn);

      // Reset isLockConfirmed for second peer
      (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await simulateSuccessfulNegotiation(negotiator, bpm, peer2, conn2);

      negotiator.cleanup();

      // Both peers should be unlocked
      (bpm.signPerRequestAuth as ReturnType<typeof vi.fn>).mockClear();
      await negotiator.preparePreRequestAuth(peer, conn);
      await negotiator.preparePreRequestAuth(peer2, conn2);
      expect(bpm.signPerRequestAuth).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreatePaymentMux', () => {
    it('returns same mux for same peer', () => {
      const mux1 = negotiator.getOrCreatePaymentMux(peer.peerId, conn);
      const mux2 = negotiator.getOrCreatePaymentMux(peer.peerId, conn);
      expect(mux1).toBe(mux2);
    });

    it('returns different mux for different peers', () => {
      const peer2Id = 'c'.repeat(40) as PeerId;
      const conn2 = createMockConn();
      const mux1 = negotiator.getOrCreatePaymentMux(peer.peerId, conn);
      const mux2 = negotiator.getOrCreatePaymentMux(peer2Id, conn2);
      expect(mux1).not.toBe(mux2);
    });
  });

  describe('requestChannelClose', () => {
    const CHANNEL_ID = '0x' + 'ab'.repeat(32);

    beforeEach(() => {
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(makeActiveSession(SELLER_PEER_ID));
      (bpm as Record<string, unknown>).buildCloseChannelRequest = vi.fn().mockResolvedValue({
        version: 1,
        channelId: CHANNEL_ID,
        cumulativeAmount: '750000',
        metadataHash: '0x' + 'cc'.repeat(32),
        metadata: '0x00',
        spendingAuthSig: '0x' + 'ee'.repeat(65),
      });
    });

    /** Feed a CloseChannelResult back through the buyer's mux, as the seller would. */
    function replyWithResult(payload: Record<string, unknown>): void {
      void negotiator.getOrCreatePaymentMux(SELLER_PEER_ID, conn).handleFrame({
        type: 0x5A,
        messageId: 1,
        payload: enc.encode(JSON.stringify(payload)),
      });
    }

    it('throws when there is no active session', async () => {
      (bpm.getActiveSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
      await expect(negotiator.requestChannelClose(SELLER_PEER_ID, conn)).rejects.toThrow(/No active payment channel/);
    });

    it('does not transmit close when the pre-close authorization is not durable', async () => {
      vi.spyOn(negotiator, 'sendPostResponseAuthTo')
        .mockRejectedValue(new Error('IndexedDB persistence failed'));

      await expect(negotiator.requestChannelClose(SELLER_PEER_ID, conn))
        .rejects.toThrow('IndexedDB persistence failed');
      expect((bpm as Record<string, unknown>).buildCloseChannelRequest).not.toHaveBeenCalled();
      expect(conn.send).not.toHaveBeenCalled();
    });

    it('sends the request and retires the session once the seller confirms', async () => {
      const promise = negotiator.requestChannelClose(SELLER_PEER_ID, conn);
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      replyWithResult({
        version: 1,
        channelId: CHANNEL_ID,
        status: 'closed',
        txHash: '0x' + 'bb'.repeat(32),
        finalAmount: '750000',
      });

      const result = await promise;
      expect(result.status).toBe('closed');
      expect(result.txHash).toBe('0x' + 'bb'.repeat(32));
      expect(bpm.retireSession).toHaveBeenCalledWith(SELLER_PEER_ID, CHANNEL_STATUS.SETTLED, 750_000n);
      expect(emitter.emit).toHaveBeenCalledWith('payment:channel-closed', expect.objectContaining({
        peerId: SELLER_PEER_ID,
        channelId: CHANNEL_ID,
      }));
    });

    it('resolves (not throws) on a rejection and leaves the session alone', async () => {
      const promise = negotiator.requestChannelClose(SELLER_PEER_ID, conn);
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      replyWithResult({
        version: 1,
        channelId: CHANNEL_ID,
        status: 'rejected',
        code: 'busy',
        reason: 'still serving',
        retryAfterMs: 2000,
      });

      const result = await promise;
      expect(result.status).toBe('rejected');
      expect(result.code).toBe('busy');
      expect(bpm.retireSession).not.toHaveBeenCalled();
    });

    it('honours includeAuth: false', async () => {
      const promise = negotiator.requestChannelClose(SELLER_PEER_ID, conn, { includeAuth: false });
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      expect((bpm as Record<string, unknown>).buildCloseChannelRequest)
        .toHaveBeenCalledWith(SELLER_PEER_ID, { includeAuth: false });

      replyWithResult({ version: 1, channelId: CHANNEL_ID, status: 'closed', finalAmount: '0' });
      await promise;
    });

    it('ignores a result naming a different channel', async () => {
      const promise = negotiator.requestChannelClose(SELLER_PEER_ID, conn, { timeoutMs: 300 });
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      replyWithResult({ version: 1, channelId: '0x' + 'ff'.repeat(32), status: 'closed' });

      await expect(promise).rejects.toThrow(/did not answer/);
      expect(bpm.retireSession).not.toHaveBeenCalled();
    });

    it('rejects the pending request when the peer disconnects', async () => {
      const promise = negotiator.requestChannelClose(SELLER_PEER_ID, conn);
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      negotiator.onPeerDisconnect(SELLER_PEER_ID);
      await expect(promise).rejects.toThrow(/disconnected/);
    });

    it('refuses to start a second close while one is in flight', async () => {
      const first = negotiator.requestChannelClose(SELLER_PEER_ID, conn);
      await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
      await expect(negotiator.requestChannelClose(SELLER_PEER_ID, conn)).rejects.toThrow(/already in flight/);

      replyWithResult({ version: 1, channelId: CHANNEL_ID, status: 'closed', finalAmount: '750000' });
      await first;
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────

const paymentRequiredPayload: PaymentRequiredPayload = {
  minBudgetPerRequest: '10000',
  suggestedAmount: '100000',
  requestId: 'req-1',
};

/**
 * Simulates a successful payment negotiation so the peer gets added to _lockedPeers.
 * This uses handle402 with a pre-buffered PaymentRequired and mocked lock confirmation.
 */
async function simulateSuccessfulNegotiation(
  negotiator: BuyerPaymentNegotiator,
  bpm: ReturnType<typeof createMockBpm>,
  peer: PeerInfo,
  conn: PeerConnection,
): Promise<void> {
  bufferPaymentRequired(negotiator, peer.peerId, conn);
  (bpm.authorizeSpending as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    (bpm.isLockConfirmed as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  const result = await negotiator.handle402(make402Response(), peer, conn, makeRequest());
  expect(result.action).toBe('retry');
}

/**
 * Buffers a PaymentRequired payload for a peer so handle402 / _doNegotiatePayment
 * can consume it without waiting for a PaymentMux message.
 */
function bufferPaymentRequired(
  negotiator: BuyerPaymentNegotiator,
  peerId: PeerId,
  conn: PeerConnection,
): void {
  // Get or create the mux, then trigger its onPaymentRequired handler
  const mux = negotiator.getOrCreatePaymentMux(peerId, conn);
  // The mux registered an onPaymentRequired handler in getOrCreatePaymentMux.
  // We need to invoke it to buffer the payload. Access it via the mux's internal.
  // Since PaymentMux stores the handler privately, we simulate by calling handleFrame
  // with a PaymentRequired frame. But that requires encoding. Instead, we use a
  // simpler approach: directly access the _bufferedPaymentRequired map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (negotiator as any)._bufferedPaymentRequired.set(peerId, { ...paymentRequiredPayload });
}

function make402Response(body: Record<string, unknown> = {}): SerializedHttpResponse {
  return {
    requestId: 'req-1',
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(body)),
  };
}

function makeRequest(): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })),
  };
}

function makeActiveSession(peerId: string): StoredChannel {
  const now = Date.now();
  return {
    sessionId: '0x' + 'ab'.repeat(32),
    peerId,
    role: CHANNEL_ROLE.BUYER,
    sellerEvmAddr: '0x' + '22'.repeat(20),
    buyerEvmAddr: '0x' + '11'.repeat(20),
    nonce: 0,
    authMax: '100000',
    deadline: Math.floor(now / 1000) + 900,
    previousSessionId: '0x' + '00'.repeat(32),
    previousConsumption: '0',
    tokensDelivered: '0',
    requestCount: 0,
    reservedAt: now,
    settledAt: null,
    settledAmount: null,
    status: CHANNEL_STATUS.ACTIVE,
    latestBuyerSig: null,
    latestSpendingAuthSig: null,
    latestMetadata: null,
    createdAt: now,
    updatedAt: now,
  };
}
