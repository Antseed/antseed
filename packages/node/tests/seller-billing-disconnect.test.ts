/**
 * What a seller bills, and on which channel, when the buyer's connection ends
 * before the answer does. Real SellerPaymentManager, ChannelStore and
 * SellerRequestHandler; only the chain calls and the upstream are stand-ins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { SellerPaymentManager, type SellerPaymentConfig } from '../src/payments/seller-payment-manager.js';
import { ChannelStore, CHANNEL_STATUS } from '../src/payments/channel-store.js';
import {
  computeMetadataHash,
  encodeMetadata,
  makeChannelsDomain,
  signReserveAuth,
  signSpendingAuth,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
} from '../src/payments/evm/signatures.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import type { Identity } from '../src/p2p/identity.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import { toPeerId } from '../src/types/peer.js';
import { MessageType, type SpendingAuthPayload } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/verification-mux.js';

const CHAIN_ID = 31337;
const CONTRACT = '0x' + 'dd'.repeat(20);
const CHANNEL_A = '0x' + 'a1'.repeat(32);
const CHANNEL_B = '0x' + 'b2'.repeat(32);
const PAID_MODEL = 'paid-model';
const FREE_MODEL = 'free-model';
const RESERVE = 10_000_000n;
/** 1000 input tokens at $1 per million plus 500 output tokens at $3 per million. */
const COST = 2_500n;

const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
const encoder = new TextEncoder();

type AnswerKind = 'buffered' | 'streamed';

function identity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + privateKey.toString('hex'));
  return { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), privateKey, wallet };
}

/** An upstream whose answers can be held open, so a test can act while one is being served. */
function makeUpstream(kind: AnswerKind) {
  let calls = 0;
  let held: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const serve = async (): Promise<void> => {
    calls += 1;
    if (held) await held;
  };
  const firstChunk = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const lastChunk = `data: {"choices":[],"usage":${JSON.stringify(USAGE)}}\n\ndata: [DONE]\n\n`;
  const provider: Provider = {
    name: 'openai',
    services: [PAID_MODEL, FREE_MODEL],
    pricing: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 3 },
      services: { [FREE_MODEL]: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    },
    maxConcurrency: 8,
    getCapacity: () => ({ current: 0, max: 8 }),
    handleRequest: async (request: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      await serve();
      return {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: encoder.encode(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: USAGE })),
      };
    },
    ...(kind === 'streamed' ? {
      handleRequestStream: async (request, callbacks) => {
        const headers = { 'content-type': 'text/event-stream' };
        callbacks.onResponseStart({ requestId: request.requestId, statusCode: 200, headers, body: new Uint8Array(0) });
        await callbacks.onResponseChunk({ requestId: request.requestId, data: encoder.encode(firstChunk), done: false });
        await serve();
        await callbacks.onResponseChunk({ requestId: request.requestId, data: encoder.encode(lastChunk), done: false });
        await callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
        return { requestId: request.requestId, statusCode: 200, headers, body: encoder.encode(firstChunk + lastChunk) };
      },
    } satisfies Pick<Provider, 'handleRequestStream'> : {}),
  };
  return {
    provider,
    get calls() { return calls; },
    hold() { held = new Promise<void>((resolve) => { open = resolve; }); },
    release() { open?.(); held = null; open = null; },
    /** Resolves once `count` answers have started. */
    started(count: number) { return vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(count)); },
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanups.pop()!();
});

async function setup(kind: AnswerKind, config: Partial<SellerPaymentConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seller-billing-disconnect-'));
  const store = new ChannelStore(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const seller = identity();
  const buyer = identity();
  const upstream = makeUpstream(kind);
  const domain = makeChannelsDomain(CHAIN_ID, CONTRACT);
  const onChain = {
    buyer: buyer.wallet.address,
    seller: seller.wallet.address,
    deposit: RESERVE,
    settled: 0n,
    metadataHash: ZERO_METADATA_HASH,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    settledAt: 0n,
    closeRequestedAt: 0n,
    status: 1,
  };

  const makeManager = (): SellerPaymentManager => {
    const created = new SellerPaymentManager(seller, {
      rpcUrl: 'http://127.0.0.1:1', channelsContractAddress: CONTRACT, chainId: CHAIN_ID, dataDir: dir, ...config,
    }, store);
    vi.spyOn(created.channelsClient, 'reserve').mockResolvedValue('0xreserve');
    vi.spyOn(created.channelsClient, 'getSession').mockImplementation(async () => ({ ...onChain }));
    vi.spyOn(created.channelsClient, 'close').mockImplementation(async (_signer, _channel, amount) => {
      onChain.settled = amount;
      onChain.status = 2;
      return '0xclose';
    });
    return created;
  };
  const makeHandler = (created: SellerPaymentManager): SellerRequestHandler => new SellerRequestHandler({
    identity: seller,
    providers: [upstream.provider],
    sellerPaymentManager: created,
    sessionTracker: null,
    channelsClient: created.channelsClient,
    announcer: null,
    emit: () => false,
  });

  let manager = makeManager();
  let handler = makeHandler(manager);

  const connect = () => {
    const frames: Uint8Array[] = [];
    let open = true;
    const conn = {
      state: ConnectionState.Open,
      send(frame: Uint8Array) {
        if (!open) throw new Error('connection closed');
        frames.push(frame);
      },
      on() {},
      off() {},
      hasRemoteCapability: () => false,
      remoteAddress: '203.0.113.7',
    } as unknown as PeerConnection;
    const paymentMux = new PaymentMux(conn);
    const needAuths = vi.spyOn(paymentMux, 'sendNeedAuth');
    const { mux } = handler.handleConnection(conn, buyer.peerId, paymentMux, new VerificationMux(conn));
    return { frames, paymentMux, needAuths, mux, drop() { open = false; } };
  };
  let connection = connect();

  const spendingAuth = async (channelId: string, amount: bigint): Promise<SpendingAuthPayload> => {
    const metadataHash = computeMetadataHash(ZERO_METADATA);
    return {
      channelId,
      cumulativeAmount: amount.toString(),
      metadataHash,
      metadata: encodeMetadata(ZERO_METADATA),
      spendingAuthSig: await signSpendingAuth(buyer.wallet, domain, { channelId, cumulativeAmount: amount, metadataHash }),
    };
  };
  const reserveAuth = async (channelId: string, deadline: number): Promise<SpendingAuthPayload> => ({
    ...await spendingAuth(channelId, 0n),
    spendingAuthSig: await signReserveAuth(buyer.wallet, domain, { channelId, maxAmount: RESERVE, deadline: BigInt(deadline) }),
    reserveSalt: '0x' + '01'.repeat(32),
    reserveMaxAmount: RESERVE.toString(),
    reserveDeadline: deadline,
  });

  const send = (requestId: string, model = PAID_MODEL): Promise<void> => connection.mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] })),
    }),
  });
  const responseTo = (requestId: string): SerializedHttpResponse => connection.frames
    .map((frame) => decodeFrame(frame).message!)
    .filter((message) => message.type === MessageType.HttpResponse)
    .map((message) => decodeHttpResponse(message.payload))
    .reverse()
    .find((response) => response.requestId === requestId)!;

  const h = {
    store,
    upstream,
    onChain,
    get manager() { return manager; },
    get needAuths() { return connection.needAuths; },
    get paymentMux() { return connection.paymentMux; },
    buyerPeerId: buyer.peerId,
    send,
    responseTo,
    reserveAuth,
    spendingAuth,
    close: () => vi.mocked(manager.channelsClient.close),
    async openChannel(channelId: string, deadline = Math.floor(Date.now() / 1000) + 3600) {
      return manager.handleSpendingAuth(buyer.peerId, await reserveAuth(channelId, deadline), connection.paymentMux);
    },
    async sign(channelId: string, amount: bigint) {
      return manager.handleSpendingAuth(buyer.peerId, await spendingAuth(channelId, amount), connection.paymentMux);
    },
    async serve(requestId: string, model = PAID_MODEL) {
      await send(requestId, model);
      return responseTo(requestId);
    },
    /** The connection ends the way node.ts reports it: frames fail, then the manager is told. */
    disconnect() {
      connection.drop();
      manager.onBuyerDisconnect(buyer.peerId);
    },
    /** A new connection that proves itself by replaying its latest authorization. */
    async reconnect(channelId: string, signed: bigint) {
      connection = connect();
      expect(await manager.handleSpendingAuth(buyer.peerId, await spendingAuth(channelId, signed), connection.paymentMux)).toBe('accepted');
      expect(manager.hasSession(buyer.peerId)).toBe(true);
    },
    /** The buyer leaves while its request is being served, and the answer then finishes. */
    async disconnectDuringAnswer(requestId: string) {
      const already = upstream.calls;
      upstream.hold();
      const answered = send(requestId);
      await upstream.started(already + 1);
      h.disconnect();
      upstream.release();
      await answered;
    },
    /** A buyer that does not answer the seller's catch-up: skip the seller's wait for it. */
    ignoreCatchUps() {
      vi.spyOn(manager, 'awaitAcceptedAtLeast').mockResolvedValue(false);
    },
    /** A buyer that answers every NeedAuth with the amount asked for. */
    signCatchUps() {
      let pending: Promise<unknown> = Promise.resolve();
      const { needAuths, paymentMux } = connection;
      needAuths.mockImplementation((payload) => {
        pending = pending.then(async () => manager.handleSpendingAuth(
          buyer.peerId,
          await spendingAuth(payload.channelId, BigInt(payload.requiredCumulativeAmount)),
          paymentMux,
        ));
      });
      return () => pending;
    },
    /** The seller process restarts on the same store. */
    restart() {
      manager = makeManager();
      handler = makeHandler(manager);
      connection = connect();
    },
  };
  return h;
}

const paymentBody = (response: SerializedHttpResponse): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;

describe.each<AnswerKind>(['buffered', 'streamed'])('seller billing across a disconnect, %s answer', (kind) => {
  it.each([
    { name: 'nothing signed', config: {}, signed: 0n },
    { name: 'already signed, settle-on-disconnect off', config: { settleOnDisconnect: false }, signed: COST },
  ])('records an answer that ends after the buyer left and asks for it before serving more ($name)', async ({ config, signed }) => {
    const h = await setup(kind, config);
    expect(await h.openChannel(CHANNEL_A)).toBe('reserved');
    if (signed > 0n) {
      await h.serve('paid');
      expect(await h.sign(CHANNEL_A, signed)).toBe('accepted');
    }
    const calledBefore = h.upstream.calls;

    await h.disconnectDuringAnswer('cut-off');

    const owed = signed + COST;
    expect(h.manager.getCumulativeSpend(CHANNEL_A), 'spend recorded for the answer that ended after the disconnect').toBe(owed);
    expect(h.store.getChannel(CHANNEL_A)?.tokensDelivered).toBe(owed.toString());
    expect(h.manager.getAcceptedCumulative(CHANNEL_A)).toBe(signed);

    await h.reconnect(CHANNEL_A, signed);
    h.ignoreCatchUps();
    const response = await h.serve('next');

    expect(response.statusCode, 'the next request waits for the delivered answer to be paid').toBe(402);
    expect(paymentBody(response).requiredCumulativeAmount).toBe(owed.toString());
    expect(paymentBody(response).channelId).toBe(CHANNEL_A);
    expect(h.upstream.calls).toBe(calledBefore + 1);
  });

  it('serves at most the one answer however often the buyer reconnects without paying', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    await h.disconnectDuringAnswer('round-0');

    for (const round of [1, 2, 3]) {
      await h.reconnect(CHANNEL_A, 0n);
      h.ignoreCatchUps();
      const response = await h.serve(`round-${round}`);
      expect(response.statusCode, `round ${round} is refused until the first answer is paid`).toBe(402);
      h.disconnect();
    }

    expect(h.upstream.calls).toBe(1);
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(COST);
    expect(h.close()).not.toHaveBeenCalled();
  });

  it('lets a buyer that comes back pay for the answer and carry on with the same channel', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    await h.disconnectDuringAnswer('cut-off');

    await h.reconnect(CHANNEL_A, 0n);
    const signing = h.signCatchUps();
    const response = await h.serve('after-paying');
    await signing();

    expect(response.statusCode, 'served once the catch-up is signed').toBe(200);
    expect(h.upstream.calls).toBe(2);
    expect(h.manager.getChannelByPeer(h.buyerPeerId)?.sessionId).toBe(CHANNEL_A);
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(2n * COST);
    expect(h.manager.getAcceptedCumulative(CHANNEL_A)).toBe(2n * COST);
    expect(h.close()).not.toHaveBeenCalled();
  });

  it('keeps asking for the answer after the seller restarts', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    await h.disconnectDuringAnswer('cut-off');

    h.restart();
    expect(h.manager.getCumulativeSpend(CHANNEL_A), 'spend survives the restart').toBe(COST);
    h.ignoreCatchUps();
    const response = await h.serve('after-restart');

    expect(response.statusCode).toBe(402);
    expect(paymentBody(response).requiredCumulativeAmount).toBe(COST.toString());
    expect(h.upstream.calls).toBe(1);
  });

  it('closes at the latest signed amount only once the running answer is recorded', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    await h.serve('paid');
    await h.sign(CHANNEL_A, COST);

    h.upstream.hold();
    const answered = h.send('cut-off');
    await h.upstream.started(2);
    h.disconnect();
    expect(h.close(), 'no close under a running answer').not.toHaveBeenCalled();
    expect(h.manager.hasSession(h.buyerPeerId)).toBe(false);
    await h.manager.checkTimeouts();
    expect(h.close(), 'the timeout check leaves a running answer alone').not.toHaveBeenCalled();

    h.upstream.release();
    await answered;
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(2n * COST);

    await h.manager.checkTimeouts();
    expect(h.close()).toHaveBeenCalledOnce();
    expect(h.close().mock.calls[0]![2]).toBe(COST);
    expect(h.store.getChannel(CHANNEL_A)?.status).toBe(CHANNEL_STATUS.SETTLED);
  });

  it('keeps the channel for a buyer that comes back before the running answer ends', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    await h.serve('paid');
    await h.sign(CHANNEL_A, COST);

    h.upstream.hold();
    const answered = h.send('cut-off');
    await h.upstream.started(2);
    h.disconnect();
    await h.reconnect(CHANNEL_A, COST);
    h.upstream.release();
    await answered;

    await h.manager.checkTimeouts();
    expect(h.close()).not.toHaveBeenCalled();
    const signing = h.signCatchUps();
    const response = await h.serve('after-paying');
    await signing();
    expect(response.statusCode).toBe(200);
    expect(h.manager.getAcceptedCumulative(CHANNEL_A)).toBe(3n * COST);
  });

  it('does not close an unsigned channel past its deadline while an answer is running', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A, Math.floor(Date.now() / 1000) - 60);

    h.upstream.hold();
    const answered = h.send('cut-off');
    await h.upstream.started(1);
    h.disconnect();
    await h.manager.checkTimeouts();
    expect(h.close(), 'no close under a running answer').not.toHaveBeenCalled();

    h.upstream.release();
    await answered;
    await h.manager.checkTimeouts();
    expect(h.close()).toHaveBeenCalledOnce();
    expect(h.close().mock.calls[0]![2]).toBe(0n);
  });

  it('never charges a channel that replaced the one that admitted the request', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);

    h.upstream.hold();
    const answered = h.send('admitted-on-a');
    await h.upstream.started(1);
    await h.manager.handleCloseRequested(CHANNEL_A);
    expect(await h.openChannel(CHANNEL_B)).toBe('reserved');
    h.upstream.release();
    await answered;

    expect(h.manager.getCumulativeSpend(CHANNEL_B), 'spend charged to the replacement channel').toBe(0n);
    expect(h.needAuths).not.toHaveBeenCalled();
  });

  it('records nothing and asks for nothing when the admitting channel ended during the answer', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);

    h.upstream.hold();
    const answered = h.send('admitted-on-a');
    await h.upstream.started(1);
    await h.manager.handleCloseRequested(CHANNEL_A);
    h.upstream.release();
    await answered;

    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(0n);
    expect(h.needAuths).not.toHaveBeenCalled();
  });

  it('does not start a paid request whose buyer left while it waited', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);
    vi.spyOn(h.manager, 'waitForPendingAuths').mockImplementation(async () => {
      h.manager.onBuyerDisconnect(h.buyerPeerId);
    });

    const response = await h.serve('left-while-waiting');

    expect(h.upstream.calls, 'upstream calls for a buyer that is gone').toBe(0);
    expect(response.statusCode).toBe(402);
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(0n);
  });

  it('holds the channel against a close or a replacement while the answer runs after the buyer came back', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);

    h.upstream.hold();
    const answered = h.send('cut-off');
    await h.upstream.started(1);
    h.disconnect();
    await h.reconnect(CHANNEL_A, 0n);

    const closing = await h.manager.handleCloseChannelRequest(h.buyerPeerId, { version: 1, channelId: CHANNEL_A }, h.paymentMux);
    expect(closing.status).toBe('rejected');
    expect(closing.code).toBe('busy');
    expect(await h.openChannel(CHANNEL_B)).toBe('rejected');

    h.upstream.release();
    await answered;
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(COST);
  });

  it('bills nothing for a free answer when the buyer disconnects before it ends', async () => {
    const h = await setup(kind);
    await h.openChannel(CHANNEL_A);

    h.upstream.hold();
    const answered = h.send('free', FREE_MODEL);
    await h.upstream.started(1);
    h.disconnect();
    h.upstream.release();
    await answered;

    expect(h.upstream.calls).toBe(1);
    expect(h.manager.getCumulativeSpend(CHANNEL_A)).toBe(0n);
    expect(h.needAuths).not.toHaveBeenCalled();
  });
});
