import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { BuyerPaymentManager } from '../src/payments/buyer-payment-manager.js';
import { BuyerPaymentNegotiator, type Handle402Result } from '../src/payments/buyer-payment-negotiator.js';
import { ChannelStore, CHANNEL_STATUS, type StoredChannel } from '../src/payments/channel-store.js';
import type { ChannelsClient, ChannelInfo } from '../src/payments/evm/channels-client.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { FrameDecoder } from '../src/p2p/message-protocol.js';
import * as codec from '../src/p2p/payment-codec.js';
import { ConnectionState } from '../src/types/connection.js';
import { MessageType } from '../src/types/protocol.js';
import { toPeerId, type PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const SELLER = toPeerId('b'.repeat(40));
/** The opening reserve, and the step each top-up adds. */
const RESERVE = 1_000_000n;
const PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const PEER = {
  peerId: SELLER,
  lastSeen: Date.now(),
  providers: ['openai'],
  defaultInputUsdPerMillion: 3,
  defaultOutputUsdPerMillion: 15,
} as PeerInfo;
const REQUEST: SerializedHttpRequest = {
  requestId: 'req-402',
  method: 'POST',
  path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  body: enc.encode(JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] })),
};

/**
 * The buyer's end of one connection to the seller. It records the payment
 * frames the buyer sends and, like PeerConnection, refuses to send once it
 * is down. The seller declines every close request it gets as busy, unless
 * it is `idle`.
 */
interface SellerConnection {
  conn: PeerConnection & { state: ConnectionState };
  /** Cumulative amounts of the SpendingAuths sent on this connection (not the reserve authorizations). */
  spendingAuths(): string[];
  /** Ceilings of the reserve authorizations sent on this connection. */
  reserveAuths(): string[];
  /** Cumulative amounts of the close requests sent on this connection. */
  closeRequests(): string[];
  /** Answer close requests (default) or leave them waiting, as a seller that went down would. */
  answerCloses: boolean;
  /**
   * A seller with nothing in flight: it closes the channel at the amount a
   * close request asks for when the chain's deposit covers it (the contract
   * refuses a close above the deposit), and acknowledges a new channel's reserve.
   */
  idle: boolean;
  /**
   * The connection drops, and the node tells the negotiator, as it does on a
   * failed connection. With `teardown` false it does not: the node skips the
   * teardown when a new connection to the seller was wired before this one's
   * close event.
   */
  drop(teardown?: boolean): void;
}

function chainInfo(deposit: bigint): ChannelInfo {
  return {
    buyer: '0x' + '11'.repeat(20),
    seller: '0x' + '22'.repeat(20),
    deposit,
    settled: 0n,
    metadataHash: '0x' + '00'.repeat(32),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status: 1,
  };
}

/** The seller's budget-exhausted 402: it served `spent` on the channel and holds an authorization for less. */
function catchUp402(channelId: string, spent: bigint, accepted: bigint): SerializedHttpResponse {
  return {
    requestId: REQUEST.requestId,
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify({
      error: 'payment_required',
      minBudgetPerRequest: '10000',
      suggestedAmount: RESERVE.toString(),
      requiredCumulativeAmount: spent.toString(),
      currentSpent: spent.toString(),
      currentAcceptedCumulative: accepted.toString(),
      channelId,
    })),
  };
}

/** A 402 whose payment terms follow in a PaymentRequired frame of their own. */
function termsToFollow402(): SerializedHttpResponse {
  return {
    requestId: REQUEST.requestId,
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify({ error: 'payment_required' })),
  };
}

/** What a 402 ended in: a retry, the reason of the answer the buyer returned instead, or the error it failed with. */
function outcomeOf(handled: Promise<Handle402Result>): Promise<string> {
  return handled.then(
    (result) => result.action === 'retry'
      ? 'retry'
      : `return ${(JSON.parse(dec.decode(result.response.body)) as { reason?: string }).reason ?? result.response.statusCode}`,
    (err: unknown) => `error ${err instanceof Error ? err.message : String(err)}`,
  );
}

describe('buyer recovery of a channel the seller asks to catch up on', () => {
  let tempDir: string;
  let identity: Identity;
  let store: ChannelStore;
  let manager: BuyerPaymentManager;
  let negotiator: BuyerPaymentNegotiator;
  let channels: { getSession: ReturnType<typeof vi.fn> };
  /** The channel's deposit on-chain right now. */
  let deposit: bigint;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buyer-payment-recovery-'));
    const wallet = Wallet.createRandom();
    identity = {
      peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
      privateKey: new Uint8Array(32),
      wallet,
    } as unknown as Identity;
    store = new ChannelStore(tempDir);
    deposit = 0n;
    channels = { getSession: vi.fn(async () => chainInfo(deposit)) };
    startBuyer();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Start the buyer on the store, as the node does each time it starts. */
  function startBuyer(): void {
    manager = new BuyerPaymentManager(identity, {
      rpcUrl: 'http://127.0.0.1:8545',
      depositsContractAddress: '0x' + 'dd'.repeat(20),
      channelsContractAddress: '0x' + 'cc'.repeat(20),
      usdcAddress: '0x' + 'ee'.repeat(20),
      identityRegistryAddress: '0x' + 'ff'.repeat(20),
      chainId: 31337,
      defaultAuthDurationSecs: 3600,
      maxPerRequestUsdc: 100_000n,
      maxReserveAmountUsdc: RESERVE,
      dataDir: tempDir,
    }, store);
    vi.spyOn(manager, 'getBalance').mockResolvedValue({ available: 10n ** 12n, reserved: 0n });
    const deposits = {
      // The channel's reserve is still locked.
      getBuyerBalance: vi.fn(async () => ({ available: 10n ** 12n, reserved: deposit, lastActivityAt: 0n })),
    };
    negotiator = new BuyerPaymentNegotiator(
      identity,
      manager,
      deposits as unknown as DepositsClient,
      channels as unknown as ChannelsClient,
      store,
      {},
      { emit: vi.fn() },
    );
  }

  function sellerConnection(): SellerConnection {
    const decoder = new FrameDecoder();
    const frames: Array<{ type: number; payload: Uint8Array }> = [];
    const conn = {
      state: ConnectionState.Open,
      send(data: Uint8Array): void {
        if (conn.state !== ConnectionState.Open) throw new Error(`Cannot send in state ${conn.state}`);
        for (const frame of decoder.feed(data)) {
          frames.push(frame);
          if (frame.type === MessageType.CloseChannelRequest && seller.answerCloses) {
            const { channelId, cumulativeAmount } = codec.decodeCloseChannelRequest(frame.payload);
            const closes = seller.idle && BigInt(cumulativeAmount ?? '0') <= deposit;
            queueMicrotask(() => void negotiator.getPaymentMux(SELLER)?.handleFrame({
              type: MessageType.CloseChannelResult,
              messageId: 0,
              payload: codec.encodeCloseChannelResult(closes
                ? { version: 1, channelId, status: 'closed', finalAmount: cumulativeAmount ?? '0' }
                : {
                  version: 1,
                  channelId,
                  status: 'rejected',
                  code: 'busy',
                  reason: 'a request is still being served on this channel',
                }),
            }));
          }
          if (frame.type === MessageType.SpendingAuth && seller.idle) {
            const { channelId, reserveMaxAmount } = codec.decodeSpendingAuth(frame.payload);
            if (reserveMaxAmount != null) queueMicrotask(() => void manager.handleAuthAck(SELLER, { version: 1, channelId } as never));
          }
        }
      },
      on(): void {},
      off(): void {},
    };
    const ofType = (type: number) => frames.filter((frame) => frame.type === type);
    const auths = () => ofType(MessageType.SpendingAuth).map((frame) => codec.decodeSpendingAuth(frame.payload));
    const seller: SellerConnection = {
      conn: conn as unknown as SellerConnection['conn'],
      spendingAuths: () => auths().filter((auth) => auth.reserveMaxAmount == null).map((auth) => auth.cumulativeAmount),
      reserveAuths: () => auths().flatMap((auth) => auth.reserveMaxAmount != null ? [auth.reserveMaxAmount] : []),
      closeRequests: () => ofType(MessageType.CloseChannelRequest).map((frame) => codec.decodeCloseChannelRequest(frame.payload).cumulativeAmount ?? '0'),
      answerCloses: true,
      idle: false,
      drop(teardown = true): void {
        conn.state = ConnectionState.Failed;
        if (teardown) negotiator.onPeerDisconnect(SELLER);
      },
    };
    return seller;
  }

  /** A channel the seller opened at RESERVE on `seller`'s connection, with `signed` authorized on it. */
  async function openChannel(seller: SellerConnection, signed: bigint): Promise<string> {
    const pmux = negotiator.getOrCreatePaymentMux(SELLER, seller.conn);
    const channelId = await manager.authorizeSpending(SELLER, pmux, 10_000n, PRICING);
    await manager.handleAuthAck(SELLER, { version: 1, channelId } as never);
    deposit = RESERVE;
    if (signed > 0n) await sign(signed, seller);
    return channelId;
  }

  /** Sign up to `cumulative`, as an earlier catch-up with requests in flight did. */
  async function sign(cumulative: bigint, seller: SellerConnection): Promise<void> {
    await manager.extendCurrentSpendingAuth(SELLER, 10_000n, negotiator.getOrCreatePaymentMux(SELLER, seller.conn), cumulative, undefined, 32);
    expect(manager.getCumulativeAmount(SELLER)).toBe(cumulative);
  }

  /** The buyer asks for a top-up of RESERVE; `landed` says whether the seller's topUp() is on-chain yet. */
  async function topUp(seller: SellerConnection, landed: boolean): Promise<void> {
    await manager.topUpReserve(SELLER, negotiator.getOrCreatePaymentMux(SELLER, seller.conn));
    expect(manager.getReserveCeiling(SELLER)).toBe(2n * RESERVE);
    if (!landed) return;
    deposit = 2n * RESERVE;
    await manager.reconcileReserveAmount(SELLER, deposit);
  }

  /** The seller sends the terms of a budget-exhausted 402 in a PaymentRequired frame. */
  function sendTerms(channelId: string, spent: bigint, accepted: bigint): void {
    negotiator.getPaymentMux(SELLER)!.handleFrame({
      type: MessageType.PaymentRequired,
      messageId: 0,
      payload: codec.encodePaymentRequired({
        minBudgetPerRequest: '10000',
        suggestedAmount: RESERVE.toString(),
        requestId: REQUEST.requestId,
        requiredCumulativeAmount: spent.toString(),
        currentSpent: spent.toString(),
        currentAcceptedCumulative: accepted.toString(),
        channelId,
      }),
    });
  }

  /** One chain read of the channel answered by a node a block behind, from before the top-up landed. */
  function nextReadLags(staleDeposit: bigint): void {
    channels.getSession.mockImplementationOnce(async () => chainInfo(staleDeposit));
  }

  /** Hold the next write of an authorization until `release`, as a store that writes asynchronously does. */
  function holdNextCommit(): { started: Promise<void>; release(): void } {
    const commit = store.commitAuthorization.bind(store);
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, 'commitAuthorization').mockImplementationOnce(async (channel, services) => {
      begin();
      await held;
      commit(channel, services);
    });
    return { started, release };
  }

  /** Hold the next chain read of the channel until `release`; `started` resolves once the read began. */
  function holdNextRead(): { started: Promise<void>; release(): void } {
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    channels.getSession.mockImplementationOnce(async () => {
      begin();
      await held;
      return chainInfo(deposit);
    });
    return { started, release };
  }

  describe('a deposit read below the reserve', () => {
    it('keeps the reserve the chain already confirmed', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, true);

      // A node a block behind still reports the deposit from before the top-up.
      await manager.reconcileReserveAmount(SELLER, RESERVE);

      expect({
        ceiling: manager.getReserveCeiling(SELLER),
        stored: store.getChannel(channelId)?.confirmedReserveAmount,
      }).toEqual({ ceiling: 2n * RESERVE, stored: (2n * RESERVE).toString() });
    });

    it('keeps a deposit a read showed while the store is still writing it', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, false);
      deposit = 2n * RESERVE;
      // The read that shows the top-up landed is still being stored when a
      // read from a node a block behind comes in.
      const write = holdNextCommit();
      const landed = manager.reconcileReserveAmount(SELLER, deposit);
      await write.started;
      await manager.reconcileReserveAmount(SELLER, RESERVE);
      write.release();
      await landed;

      expect({
        ceiling: manager.getReserveCeiling(SELLER),
        stored: store.getChannel(channelId)?.confirmedReserveAmount,
      }).toEqual({ ceiling: 2n * RESERVE, stored: (2n * RESERVE).toString() });
    });

    it('keeps a deposit an earlier read showed while a second top-up is still mining', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, false);
      // A second top-up, stacked on the first, then a read shows the first one landed.
      await manager.topUpReserve(SELLER, negotiator.getOrCreatePaymentMux(SELLER, seller.conn));
      deposit = 2n * RESERVE;
      await manager.reconcileReserveAmount(SELLER, deposit);

      await manager.reconcileReserveAmount(SELLER, RESERVE);
      const afterRead = { ceiling: manager.getReserveCeiling(SELLER), stored: store.getChannel(channelId)?.confirmedReserveAmount };
      // A 402 recovery then replays the second top-up.
      await manager.resendPendingReserveAuth(SELLER, negotiator.getOrCreatePaymentMux(SELLER, seller.conn));

      expect({ afterRead, storedAfterReplay: store.getChannel(channelId)?.confirmedReserveAmount }).toEqual({
        // The second top-up is still on its way: its ceiling stands.
        afterRead: { ceiling: 3n * RESERVE, stored: (2n * RESERVE).toString() },
        storedAfterReplay: (2n * RESERVE).toString(),
      });
    });

    it('keeps a deposit it saw while budgeting a top-up', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, false);
      const pmux = negotiator.getOrCreatePaymentMux(SELLER, seller.conn);
      await manager.topUpReserve(SELLER, pmux);
      // The first top-up lands, and the buyer sees it while it budgets a third.
      deposit = 2n * RESERVE;
      await manager.topUpReserve(SELLER, pmux);

      await manager.reconcileReserveAmount(SELLER, RESERVE);

      expect(store.getChannel(channelId)?.confirmedReserveAmount).toBe((2n * RESERVE).toString());
    });

    it('keeps the reserve the chain confirmed when the buyer restarts', async () => {
      const before = sellerConnection();
      const channelId = await openChannel(before, 0n);
      await topUp(before, true);
      await sign(1_500_000n, before);

      // The buyer restarts, and its first read comes from a node a block behind.
      startBuyer();
      const after = sellerConnection();
      nextReadLags(RESERVE);
      const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, after.conn, REQUEST));

      expect({ outcome, closeRequests: after.closeRequests(), resent: after.spendingAuths() }).toEqual({
        outcome: 'retry',
        closeRequests: [],
        resent: ['1500000'],
      });
    });

    it('caps a close at the deposit the chain has shown, not at a read that lags it', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, true);
      await sign(1_500_000n, seller);
      expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST))).toBe('retry');
      // The seller still asks for it once the resend had time to land, and the
      // read for that 402 lags the top-up: the buyer asks the seller to close.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      nextReadLags(RESERVE);

      await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));

      expect(seller.closeRequests()).toEqual(['1500000']);
    });

    it('warns about a read below the confirmed deposit, and only about that', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, true);
      vi.stubEnv('ANTSEED_DEBUG', '1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.reconcileReserveAmount(SELLER, 2n * RESERVE);
      const afterSameRead = warn.mock.calls.length;
      await manager.reconcileReserveAmount(SELLER, RESERVE);

      expect({ afterSameRead, warnings: warn.mock.calls.map((args) => args.join(' ')) }).toEqual({
        afterSameRead: 0,
        warnings: [
          '[BuyerPayment] Ignoring a chain read of deposit 1000000 below the confirmed 2000000: ' +
          `channel=${channelId.slice(0, 18)}... seller=${SELLER.slice(0, 12)}...`,
        ],
      });
    });

    describe('that reads keep showing', () => {
      /** The reserve ceiling, and the confirmed deposit as stored. */
      const reserve = (channelId: string) => ({
        ceiling: manager.getReserveCeiling(SELLER),
        stored: store.getChannel(channelId)?.confirmedReserveAmount,
      });
      const TOPPED_UP = { ceiling: 2n * RESERVE, stored: (2n * RESERVE).toString() };
      const OPENING = { ceiling: RESERVE, stored: RESERVE.toString() };

      /** A channel topped up to 2 x RESERVE, with the clock stopped at the returned time. */
      async function toppedUpChannel(seller: SellerConnection): Promise<{ channelId: string; at(ms: number): void }> {
        const channelId = await openChannel(seller, 0n);
        await topUp(seller, true);
        const start = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
        return { channelId, at: (ms) => { clock.mockReturnValue(start + ms); } };
      }

      it('takes a lower deposit for the chain\'s once a read shows it again after the lag window', async () => {
        const { channelId, at } = await toppedUpChannel(sellerConnection());
        // The top-up is rolled back: from now on every read shows the opening reserve.
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        at(29_000);
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        const insideWindow = reserve(channelId);
        at(30_000);
        await manager.reconcileReserveAmount(SELLER, RESERVE);

        expect({ insideWindow, afterWindow: reserve(channelId) }).toEqual({ insideWindow: TOPPED_UP, afterWindow: OPENING });
      });

      it('still takes a lower read for a lagging node after a read in between showed the confirmed deposit', async () => {
        const { channelId, at } = await toppedUpChannel(sellerConnection());
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        at(20_000);
        await manager.reconcileReserveAmount(SELLER, 2n * RESERVE);
        // More than the window after the first lagging read, but the first since the chain's own.
        at(40_000);
        await manager.reconcileReserveAmount(SELLER, RESERVE);

        expect(reserve(channelId)).toEqual(TOPPED_UP);
      });

      it('starts the lag window again when the lower deposit that reads show changes', async () => {
        const { channelId, at } = await toppedUpChannel(sellerConnection());
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        at(30_000);
        await manager.reconcileReserveAmount(SELLER, 1_500_000n);
        const firstOther = reserve(channelId);
        at(60_000);
        await manager.reconcileReserveAmount(SELLER, 1_500_000n);

        expect({ firstOther, readAgain: reserve(channelId) }).toEqual({
          firstOther: TOPPED_UP,
          readAgain: { ceiling: 1_500_000n, stored: '1500000' },
        });
      });

      it('never takes a deposit of zero for the chain\'s', async () => {
        const { channelId, at } = await toppedUpChannel(sellerConnection());
        await manager.reconcileReserveAmount(SELLER, 0n);
        at(30_000);
        await manager.reconcileReserveAmount(SELLER, 0n);

        expect(reserve(channelId)).toEqual(TOPPED_UP);
      });

      it('keeps a lower deposit it took for the chain\'s while the store is still writing it', async () => {
        const { channelId, at } = await toppedUpChannel(sellerConnection());
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        at(30_000);
        // The read that is taken is still being stored when a parallel 402's read comes in.
        const write = holdNextCommit();
        const taken = manager.reconcileReserveAmount(SELLER, RESERVE);
        await write.started;
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        write.release();
        await taken;

        expect(reserve(channelId)).toEqual(OPENING);
      });

      it('keeps a deposit it saw while budgeting a top-up after it took a lower one for the chain\'s', async () => {
        const seller = sellerConnection();
        const { channelId, at } = await toppedUpChannel(seller);
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        at(30_000);
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        expect(reserve(channelId)).toEqual(OPENING);
        // The buyer tops up again, twice, and sees the first one landed while it budgets a third.
        const pmux = negotiator.getOrCreatePaymentMux(SELLER, seller.conn);
        deposit = RESERVE;
        await manager.topUpReserve(SELLER, pmux);
        await manager.topUpReserve(SELLER, pmux);
        deposit = 2n * RESERVE;
        await manager.topUpReserve(SELLER, pmux);

        // A node a block behind still reports the deposit from before it.
        await manager.reconcileReserveAmount(SELLER, RESERVE);

        expect(store.getChannel(channelId)?.confirmedReserveAmount).toBe((2n * RESERVE).toString());
      });

      it('replays a top-up stacked on a rolled-back one against the deposit the chain has', async () => {
        const seller = sellerConnection();
        const channelId = await openChannel(seller, 0n);
        await topUp(seller, false);
        const pmux = negotiator.getOrCreatePaymentMux(SELLER, seller.conn);
        await manager.topUpReserve(SELLER, pmux);
        await manager.reconcileReserveAmount(SELLER, 2n * RESERVE);
        // The first top-up is rolled back; the second is still on its way.
        const start = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        clock.mockReturnValue(start + 30_000);
        await manager.reconcileReserveAmount(SELLER, RESERVE);
        const afterRead = reserve(channelId);
        await manager.resendPendingReserveAuth(SELLER, pmux);

        expect({ afterRead, storedAfterReplay: store.getChannel(channelId)?.confirmedReserveAmount }).toEqual({
          afterRead: { ceiling: 3n * RESERVE, stored: RESERVE.toString() },
          storedAfterReplay: RESERVE.toString(),
        });
      });
    });

    it('closes at the deposit the chain has when a top-up a read showed is rolled back', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, true);
      await sign(1_500_000n, seller);
      const sentBefore = seller.spendingAuths().length;
      // The block with the top-up is dropped: from now on every read shows the opening reserve.
      deposit = RESERVE;

      const first = await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));
      const resent = seller.spendingAuths().slice(sentBefore);
      // The seller cannot accept the resend, and asks again once it had time to
      // land. By then it has nothing else in flight on the channel.
      seller.idle = true;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      const second = await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));

      const closed = store.getChannel(channelId);
      expect({
        first,
        resent,
        second,
        closeRequests: seller.closeRequests(),
        closed: { status: closed?.status, settledAmount: closed?.settledAmount },
        replacedBy: manager.getActiveSession(SELLER)?.sessionId !== channelId,
      }).toEqual({
        first: 'retry',
        resent: ['1500000'],
        // A close the contract accepts, and a new channel for the request.
        second: 'retry',
        closeRequests: [RESERVE.toString()],
        closed: { status: CHANNEL_STATUS.SETTLED, settledAmount: RESERVE.toString() },
        replacedBy: true,
      });
    });

    it('caps a close at the read of this recovery when the read for the close fails', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, true);
      await sign(1_500_000n, seller);
      deposit = RESERVE;
      expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST))).toBe('retry');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      channels.getSession
        .mockImplementationOnce(async () => chainInfo(deposit))
        .mockImplementationOnce(async () => { throw new Error('the chain RPC is down'); });

      await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));

      expect(seller.closeRequests()).toEqual([RESERVE.toString()]);
    });

    it.each([
      { state: 'the top-up landed and the read lags it', landed: true, replayed: [], topUpPending: false, confirmed: '2000000' },
      { state: 'the top-up is still mining', landed: false, replayed: ['2000000'], topUpPending: true, confirmed: '1000000' },
    ])('resends an authorization the reserve covers instead of closing the channel: $state', async ({ landed, replayed, topUpPending, confirmed }) => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, landed);
      // Signed past the opening reserve, against the top-up.
      await sign(1_500_000n, seller);
      const sentBefore = seller.spendingAuths().length;
      const reservesBefore = seller.reserveAuths().length;
      if (landed) nextReadLags(RESERVE);

      const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));

      expect({
        outcome,
        closeRequests: seller.closeRequests(),
        // The seller needs a top-up still on its way to accept what is resent.
        replayed: seller.reserveAuths().slice(reservesBefore),
        resent: seller.spendingAuths().slice(sentBefore),
        status: store.getChannel(channelId)?.status,
        topUpPending: manager.hasPendingReserveAuth(SELLER),
        confirmed: store.getChannel(channelId)?.confirmedReserveAmount,
      }).toEqual({
        outcome: 'retry',
        closeRequests: [],
        replayed,
        resent: ['1500000'],
        status: CHANNEL_STATUS.ACTIVE,
        topUpPending,
        confirmed,
      });
    });

    it('resends while a parallel 402 reads the chain before the top-up lands', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 0n);
      await topUp(seller, false);
      await sign(1_500_000n, seller);
      // Two 402s of the burst: the second reads the chain once the first has
      // replayed the top-up, and replays it only once the first has decided.
      const secondRead = holdNextRead();
      const replay = manager.resendPendingReserveAuth.bind(manager);
      let secondAtReplay!: () => void;
      const secondReconciled = new Promise<void>((resolve) => { secondAtReplay = resolve; });
      let first!: Promise<string>;
      vi.spyOn(manager, 'resendPendingReserveAuth')
        .mockImplementationOnce(async (peerId, pmux) => {
          const replayed = await replay(peerId, pmux);
          secondRead.release();
          await secondReconciled;
          return replayed;
        })
        .mockImplementationOnce(async (peerId, pmux) => {
          secondAtReplay();
          await first;
          return replay(peerId, pmux);
        });
      const reservesBefore = seller.reserveAuths().length;
      const second = outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));
      await secondRead.started;
      first = outcomeOf(negotiator.handle402(catchUp402(channelId, 1_500_000n, 900_000n), PEER, seller.conn, REQUEST));

      expect({
        first: await first,
        second: await second,
        replayed: seller.reserveAuths().slice(reservesBefore),
        closeRequests: seller.closeRequests(),
      }).toEqual({
        first: 'retry',
        second: 'retry',
        replayed: ['2000000', '2000000'],
        closeRequests: [],
      });
    });

    it('still closes at the deposit a channel whose signed amount no reserve covers', async () => {
      const seller = sellerConnection();
      // Signed 1.5 USDC on a 1 USDC channel, with no top-up on its way (for
      // example after a restart that lost the top-up): the seller can never
      // accept it, and the contract refuses a close above the deposit.
      const channelId = await openChannel(seller, 0n);
      const row = store.getChannel(channelId)!;
      const overSigned: StoredChannel = { ...row, authMax: '1500000', updatedAt: Date.now() };
      store.upsertChannel(overSigned);
      manager.adoptPersistedAuthorization(overSigned);

      const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 1_200_000n, 900_000n), PEER, seller.conn, REQUEST));

      expect({ outcome, closeRequests: seller.closeRequests() }).toEqual({
        outcome: 'return existing_channel_still_active',
        closeRequests: [RESERVE.toString()],
      });
    });
  });

  it('retries a 402 from the same burst that waited on a slow chain read, instead of closing the channel', async () => {
    const seller = sellerConnection();
    const channelId = await openChannel(seller, 500_000n);
    expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST))).toBe('retry');
    // Another 402 of the burst arrived with the first, but its chain read takes
    // longer than the settle window.
    const arrived = Date.now();
    const read = holdNextRead();
    const sibling = outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST));
    await read.started;
    vi.spyOn(Date, 'now').mockReturnValue(arrived + 10_000);
    read.release();

    expect({ outcome: await sibling, closeRequests: seller.closeRequests() }).toEqual({ outcome: 'retry', closeRequests: [] });
  });

  it('retries a 402 from the same burst whose terms came after the settle window, instead of closing the channel', async () => {
    const seller = sellerConnection();
    const channelId = await openChannel(seller, 500_000n);
    const resentAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(resentAt);
    expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST))).toBe('retry');
    // Another 402 of the burst arrives inside the settle window; its terms
    // come in a frame of their own after the window ends.
    clock.mockReturnValue(resentAt + 6_000);
    const sibling = outcomeOf(negotiator.handle402(termsToFollow402(), PEER, seller.conn, REQUEST));
    clock.mockReturnValue(resentAt + 7_500);
    sendTerms(channelId, 500_000n, 400_000n);

    expect({ outcome: await sibling, closeRequests: seller.closeRequests() }).toEqual({ outcome: 'retry', closeRequests: [] });
  });

  it('resends again after a resend that failed on a live connection, instead of closing the channel', async () => {
    const seller = sellerConnection();
    const channelId = await openChannel(seller, 500_000n);
    const sentBefore = seller.spendingAuths().length;
    // The resend fails before anything is sent, as when the store refuses the write.
    vi.spyOn(manager, 'resendCurrentSpendingAuth').mockRejectedValueOnce(new Error('could not store the authorization'));
    expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST)))
      .toBe('error could not store the authorization');

    // The seller asks again, after the time a resend would have had to land.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST));

    expect({ outcome, closeRequests: seller.closeRequests(), resent: seller.spendingAuths().slice(sentBefore) }).toEqual({
      outcome: 'retry',
      closeRequests: [],
      resent: ['500000'],
    });
  });

  describe('after the connection to the seller drops', () => {
    it('resends on the new connection what it resent on the dropped one, instead of closing the channel', async () => {
      const before = sellerConnection();
      const channelId = await openChannel(before, 500_000n);
      expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, before.conn, REQUEST))).toBe('retry');
      expect(before.spendingAuths().at(-1)).toBe('500000');

      // The seller restarts: the connection drops and a new one opens some seconds later.
      before.drop();
      const after = sellerConnection();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, after.conn, REQUEST));

      expect({ outcome, closeRequests: after.closeRequests(), resent: after.spendingAuths() }).toEqual({
        outcome: 'retry',
        closeRequests: [],
        resent: ['500000'],
      });
    });

    it('does not count a resend that could not be sent on the dropped connection', async () => {
      const before = sellerConnection();
      const channelId = await openChannel(before, 500_000n);
      // The connection drops while the buyer reads the channel for this 402.
      const read = holdNextRead();
      const cutOff = outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, before.conn, REQUEST));
      await read.started;
      before.drop();
      read.release();
      expect(await cutOff).toBe('error Cannot send in state failed');

      const after = sellerConnection();
      const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, after.conn, REQUEST));

      expect({ outcome, resent: after.spendingAuths() }).toEqual({ outcome: 'retry', resent: ['500000'] });
    });

    it('fails the attempt when the connection drops before the seller answers a close, instead of reporting the channel stuck', async () => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 500_000n);
      expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST))).toBe('retry');
      // The seller asks for the same amount after the resend had time to land: the buyer asks it to close.
      seller.answerCloses = false;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      const closing = outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST));
      await vi.waitFor(() => expect(seller.closeRequests()).toHaveLength(1));

      // The seller goes down before it answers.
      seller.drop();

      expect(await closing).toBe(`error Connection to ${SELLER} failed during request ${REQUEST.requestId}`);
      expect(store.getChannel(channelId)?.status).toBe(CHANNEL_STATUS.ACTIVE);
    });

    it.each([
      { when: 'the connection drops', end: (seller: SellerConnection) => seller.drop() },
      { when: 'the buyer stops', end: () => negotiator.cleanup() },
    ])('forgets a resend, and the connection it went over, when $when', async ({ end }) => {
      const seller = sellerConnection();
      const channelId = await openChannel(seller, 500_000n);
      expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, seller.conn, REQUEST))).toBe('retry');
      const resends = (negotiator as unknown as { _resentForTarget: Map<string, unknown> })._resentForTarget;
      const before = resends.size;

      end(seller);

      expect({ before, after: resends.size }).toEqual({ before: 1, after: 0 });
    });

    describe('and a new one opens before the teardown of the old one', () => {
      it('resends on the new connection what it resent on the old one, instead of closing the channel', async () => {
        const before = sellerConnection();
        const channelId = await openChannel(before, 500_000n);
        expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, before.conn, REQUEST))).toBe('retry');

        before.drop(false);
        const after = sellerConnection();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
        const outcome = await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, after.conn, REQUEST));

        expect({ outcome, closeRequests: after.closeRequests(), resent: after.spendingAuths() }).toEqual({
          outcome: 'retry',
          closeRequests: [],
          resent: ['500000'],
        });
      });

      it('holds a close the old connection never answered until it times out (a known limit)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const before = sellerConnection();
        const channelId = await openChannel(before, 500_000n);
        expect(await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, before.conn, REQUEST))).toBe('retry');
        // The seller asks again after the resend had time to land: the buyer
        // asks it to close, and the connection fails before the answer.
        before.answerCloses = false;
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
        const closing = outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, before.conn, REQUEST));
        await vi.waitFor(() => expect(before.closeRequests()).toHaveLength(1));
        before.drop(false);
        const after = sellerConnection();

        // Nothing ends the close early, so no other close can start, while a
        // catch-up on the new connection still resends.
        const second = await negotiator.requestChannelClose(SELLER, after.conn).then(() => 'sent', (err: Error) => err.message);
        const catchUp = await outcomeOf(negotiator.handle402(catchUp402(channelId, 500_000n, 400_000n), PEER, after.conn, REQUEST));
        await vi.advanceTimersByTimeAsync(59_000);
        const stillHeld = await negotiator.requestChannelClose(SELLER, after.conn).then(() => 'sent', (err: Error) => err.message);
        await vi.advanceTimersByTimeAsync(1_000);

        expect({ second, catchUp, resent: after.spendingAuths(), stillHeld, closing: await closing, closeRequests: after.closeRequests() }).toEqual({
          second: `A channel close request is already in flight for ${SELLER.slice(0, 12)}...`,
          catchUp: 'retry',
          resent: ['500000'],
          stillHeld: `A channel close request is already in flight for ${SELLER.slice(0, 12)}...`,
          closing: `error Connection to ${SELLER} failed during request ${REQUEST.requestId}`,
          closeRequests: [],
        });
      });
    });
  });
});
