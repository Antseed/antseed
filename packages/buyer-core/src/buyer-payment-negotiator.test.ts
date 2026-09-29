import { describe, expect, it, vi } from 'vitest';
import { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
import type { BuyerConnection, BuyerPeerView } from './interfaces.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';

describe('BuyerPaymentNegotiator', () => {
  it('decodes a browser-compatible external spending auth header', async () => {
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: '0x00',
      spendingAuthSig: '0x1234',
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const headerValue = btoa(Array.from(payloadBytes, (byte) => String.fromCharCode(byte)).join(''));
    const sendSpendingAuth = vi.fn();
    const emit = vi.fn();
    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const internals = negotiator as unknown as {
      getOrCreatePaymentMux: () => { sendSpendingAuth: typeof sendSpendingAuth };
      _resolveSellerAddr: () => Promise<string>;
      _channelStore: null;
      _waitForLockConfirmation: () => Promise<void>;
      _lockedPeers: Set<string>;
      _emit: { emit: typeof emit };
    };
    internals.getOrCreatePaymentMux = () => ({ sendSpendingAuth });
    internals._resolveSellerAddr = async () => `0x${'3'.repeat(40)}`;
    internals._channelStore = null;
    internals._waitForLockConfirmation = async () => {};
    internals._lockedPeers = new Set();
    internals._emit = { emit };

    const peer: BuyerPeerView = { peerId: toPeerId('4'.repeat(40)) };
    const connection = {
      state: ConnectionState.Connected,
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BuyerConnection;
    await negotiator.applyExternalSpendingAuth(peer, connection, headerValue);

    expect(sendSpendingAuth).toHaveBeenCalledWith(payload);
    expect(emit).toHaveBeenCalledWith('payment:signed', {
      peerId: peer.peerId,
      sellerEvmAddr: `0x${'3'.repeat(40)}`,
      amount: payload.cumulativeAmount,
    });
  });

  it('persists and flushes the signed auth before transmitting it', async () => {
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: '0x00',
      spendingAuthSig: '0x1234',
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const headerValue = btoa(Array.from(payloadBytes, (byte) => String.fromCharCode(byte)).join(''));

    const events: string[] = [];
    const upsertChannel = vi.fn((channel: { latestSpendingAuthSig: string | null; latestMetadata: string | null }) => {
      events.push('upsert');
      return channel;
    });
    // Async flush that only settles on a later macrotask: if the negotiator
    // transmitted without awaiting the durability barrier, 'send' would be
    // recorded before 'flush:end'.
    const flush = vi.fn(() => {
      events.push('flush:start');
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          events.push('flush:end');
          resolve();
        }, 10);
      });
    });
    const sendSpendingAuth = vi.fn(() => {
      events.push('send');
    });
    const adoptPersistedAuthorization = vi.fn(() => {
      events.push('adopt');
    });

    const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
    const internals = negotiator as unknown as {
      getOrCreatePaymentMux: () => { sendSpendingAuth: typeof sendSpendingAuth };
      _resolveSellerAddr: () => Promise<string>;
      _channelStore: { upsertChannel: typeof upsertChannel; flush: typeof flush };
      _bpm: { adoptPersistedAuthorization: typeof adoptPersistedAuthorization };
      _identity: { wallet: { address: string } };
      _waitForLockConfirmation: () => Promise<void>;
      _lockedPeers: Set<string>;
      _emit: { emit: ReturnType<typeof vi.fn> };
    };
    internals.getOrCreatePaymentMux = () => ({ sendSpendingAuth });
    internals._resolveSellerAddr = async () => `0x${'3'.repeat(40)}`;
    internals._channelStore = { upsertChannel, flush };
    internals._bpm = { adoptPersistedAuthorization };
    internals._identity = { wallet: { address: `0x${'4'.repeat(40)}` } };
    internals._waitForLockConfirmation = async () => {};
    internals._lockedPeers = new Set();
    internals._emit = { emit: vi.fn() };

    const peer: BuyerPeerView = { peerId: toPeerId('4'.repeat(40)) };
    const connection = {
      state: ConnectionState.Connected,
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BuyerConnection;
    await negotiator.applyExternalSpendingAuth(peer, connection, headerValue);

    // The signed authorization must be durably persisted before the seller
    // can ever see it — a crash after transmit must not lose the signature.
    expect(events).toEqual(['upsert', 'flush:start', 'flush:end', 'adopt', 'send']);
    expect(upsertChannel).toHaveBeenCalledWith(expect.objectContaining({
      latestSpendingAuthSig: payload.spendingAuthSig,
      latestMetadata: payload.metadata,
    }));
    expect(upsertChannel.mock.calls[0]?.[0]).not.toHaveProperty('reserveAuthPending');
    expect(adoptPersistedAuthorization).toHaveBeenCalledWith(upsertChannel.mock.calls[0]?.[0]);
  });

  describe('ensureVideoHeadroom', () => {
    const peer: BuyerPeerView = { peerId: toPeerId('5'.repeat(40)) };
    const connection = { state: ConnectionState.Connected } as unknown as BuyerConnection;
    const requestId = 'video-create';

    function makeNegotiator(opts: {
      cumulative: bigint;
      deposit: bigint;
      videoCost?: bigint;
      available?: bigint;
      confirmedDeposits?: bigint[];
    }) {
      const events: string[] = [];
      const deposits = [opts.deposit, ...(opts.confirmedDeposits ?? [])];
      const getSession = vi.fn(async () => ({ deposit: deposits.length > 1 ? deposits.shift()! : deposits[0]! }));
      const bpm = {
        maxVideoRequestUsdc: 5_000_000n,
        getRequestBilling: vi.fn(() => (opts.videoCost ? { estimatedCostUsdc: opts.videoCost } : undefined)),
        getActiveSession: vi.fn(() => ({ sessionId: `0x${'a'.repeat(64)}` })),
        getCumulativeAmount: vi.fn(() => opts.cumulative),
        reconcileReserveAmount: vi.fn(async () => {}),
        getBalance: vi.fn(async () => ({ available: opts.available ?? 10_000_000n, reserved: 0n })),
        signVideoDownPayment: vi.fn(async (_peer: string, _mux: unknown, _req: string, target: bigint) => {
          events.push(`down:${target}`);
        }),
        topUpReserve: vi.fn(async (_peer: string, _mux: unknown, target: bigint) => {
          events.push(`topup:${target}`);
        }),
      };
      const negotiator = Object.create(BuyerPaymentNegotiator.prototype) as BuyerPaymentNegotiator;
      Object.assign(negotiator as object, {
        _bpm: bpm,
        _channelsClient: { getSession, getTopUpSettledThresholdBps: vi.fn(async () => 8_500n) },
        _lockedPeers: new Set([peer.peerId]),
        _pendingNeedAuth: new Set(),
        _videoHeadroomLocks: new Map(),
        _topUpThresholdBps: null,
        _videoTopUpPollMs: 1,
        _videoTopUpTimeoutMs: 20,
        getOrCreatePaymentMux: () => ({}),
      });
      return { negotiator, bpm, events, getSession };
    }

    it('does nothing when the video fits the locked reserve', async () => {
      const { negotiator, bpm } = makeNegotiator({ cumulative: 0n, deposit: 1_000_000n, videoCost: 800_000n });
      await negotiator.ensureVideoHeadroom(peer, connection, requestId);
      expect(bpm.signVideoDownPayment).not.toHaveBeenCalled();
      expect(bpm.topUpReserve).not.toHaveBeenCalled();
    });

    it('prepays to the settle threshold, then tops up straight to the video limit', async () => {
      const { negotiator, events } = makeNegotiator({
        cumulative: 0n,
        deposit: 1_000_000n,
        videoCost: 4_200_000n,
        confirmedDeposits: [5_000_000n],
      });
      await negotiator.ensureVideoHeadroom(peer, connection, requestId);
      expect(events).toEqual(['down:850000', 'topup:5000000']);
    });

    it('skips the prepayment when the threshold is already settled', async () => {
      const { negotiator, events } = makeNegotiator({
        cumulative: 900_000n,
        deposit: 1_000_000n,
        videoCost: 4_200_000n,
        confirmedDeposits: [5_900_000n],
      });
      await negotiator.ensureVideoHeadroom(peer, connection, requestId);
      expect(events).toEqual(['topup:5900000']);
    });

    it('tops up only to the video price when deposits cannot cover the full video limit', async () => {
      const { negotiator, events } = makeNegotiator({
        cumulative: 0n,
        deposit: 1_000_000n,
        videoCost: 1_500_000n,
        available: 1_000_000n,
        confirmedDeposits: [1_500_000n],
      });
      await negotiator.ensureVideoHeadroom(peer, connection, requestId);
      expect(events).toEqual(['down:850000', 'topup:1500000']);
    });

    it('fails before signing when deposits cannot cover the video price', async () => {
      const { negotiator, bpm } = makeNegotiator({
        cumulative: 0n,
        deposit: 1_000_000n,
        videoCost: 4_200_000n,
        available: 1_000_000n,
      });
      await expect(negotiator.ensureVideoHeadroom(peer, connection, requestId)).rejects.toMatchObject({
        code: 'buyer-deposits-insufficient',
      });
      expect(bpm.signVideoDownPayment).not.toHaveBeenCalled();
      expect(bpm.topUpReserve).not.toHaveBeenCalled();
    });

    it('times out when the seller never lands the top-up', async () => {
      const { negotiator } = makeNegotiator({ cumulative: 0n, deposit: 1_000_000n, videoCost: 4_200_000n });
      await expect(negotiator.ensureVideoHeadroom(peer, connection, requestId)).rejects.toMatchObject({
        code: 'buyer-reserve-topup-timeout',
      });
    });

    it('does nothing before a channel is established', async () => {
      const { negotiator, getSession } = makeNegotiator({ cumulative: 0n, deposit: 0n, videoCost: 4_200_000n });
      (negotiator as unknown as { _lockedPeers: Set<string> })._lockedPeers.clear();
      await negotiator.ensureVideoHeadroom(peer, connection, requestId);
      expect(getSession).not.toHaveBeenCalled();
    });
  });
});
