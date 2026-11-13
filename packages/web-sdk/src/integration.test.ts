/**
 * End-to-end: web SDK (node-datachannel polyfill standing in for the browser)
 * → relay WS bridge → REAL @antseed/node seller-side code (ConnectionManager
 * listener + ProxyMux), including the payment handshake.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Wallet, keccak256, verifyTypedData } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import {
  ConnectionManager,
  FrameDecoder as NodeFrameDecoder,
  encodeFrame as nodeEncodeFrame,
} from '@antseed/node/p2p';
import { ProxyMux, toPeerId } from '@antseed/node';
import { RelayServer } from '../../../apps/relay/src/server.js';
import { SellerCache } from '../../../apps/relay/src/seller-cache.js';
import { AntseedWebClient, type SellerSession } from './client.js';
import {
  MessageType,
  decodeSpendingAuth,
  encodeAuthAck,
  encodeNeedAuth,
  encodePaymentRequired,
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  makeChannelsDomain,
  type SpendingAuthPayload,
} from '@antseed/protocol';

const CHAIN_ID = 31337;
const CHANNELS_ADDRESS = '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853';
const PRICE_402_BODY = JSON.stringify({
  error: 'payment_required',
  minBudgetPerRequest: '1000',
  suggestedAmount: '500000',
  inputUsdPerMillion: 3000,
  outputUsdPerMillion: 15000,
});

const sellerWallet = Wallet.createRandom();
const buyerWallet = Wallet.createRandom();
const sellerPeerId = sellerWallet.address.slice(2).toLowerCase();

interface SellerState {
  reserveAuths: SpendingAuthPayload[];
  spendingAuths: SpendingAuthPayload[];
  uploadedBodies: number[];
  hasChannel: boolean;
  channelId: string | null;
  cumulativeAccepted: bigint;
}

const sellerState: SellerState = {
  reserveAuths: [],
  spendingAuths: [],
  uploadedBodies: [],
  hasChannel: false,
  channelId: null,
  cumulativeAccepted: 0n,
};

let manager: ConnectionManager;
let relay: RelayServer;
let session: SellerSession;

function wireSellerConnection(conn: InstanceType<typeof ConnectionManager>['prototype'] | any): void {
  const decoder = new NodeFrameDecoder();
  const mux = new ProxyMux(conn);
  let messageId = 0;
  const nextId = () => ++messageId;

  const sendPaymentFrame = (type: number, payload: Uint8Array) => {
    conn.send(nodeEncodeFrame({ type, messageId: nextId(), payload }));
  };

  mux.onProxyRequest((request: any) => {
    const body = request.body as Uint8Array;
    if (request.headers['x-upload-echo'] === '1') {
      sellerState.uploadedBodies.push(body.length);
      mux.sendProxyResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ received: body.length })),
      });
      return;
    }

    if (!sellerState.hasChannel) {
      mux.sendProxyResponse({
        requestId: request.requestId,
        statusCode: 402,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(PRICE_402_BODY),
      });
      sendPaymentFrame(MessageType.PaymentRequired, encodePaymentRequired({
        minBudgetPerRequest: '1000',
        suggestedAmount: '500000',
        requestId: request.requestId,
        inputUsdPerMillion: 3000,
        outputUsdPerMillion: 15000,
      }));
      return;
    }

    const wantsStream = request.headers['accept'] === 'text/event-stream';
    if (wantsStream) {
      mux.sendProxyResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' },
        body: new Uint8Array(0),
      });
      mux.sendProxyChunk({
        requestId: request.requestId,
        done: false,
        data: new TextEncoder().encode('data: {"delta":"hel"}\n\n'),
      });
      mux.sendProxyChunk({
        requestId: request.requestId,
        done: false,
        data: new TextEncoder().encode('data: {"delta":"lo"}\n\n'),
      });
      mux.sendProxyChunk({
        requestId: request.requestId,
        done: true,
        data: new TextEncoder().encode('data: [DONE]\n\n'),
      });
    } else {
      mux.sendProxyResponse({
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, echo: body.length })),
      });
    }

    // 250k fresh * $3/M + 50k cached * $3/M + 20k out * $15/M = 1200 base units
    sellerState.cumulativeAccepted += 1200n;
    sendPaymentFrame(MessageType.NeedAuth, encodeNeedAuth({
      channelId: sellerState.channelId!,
      requiredCumulativeAmount: sellerState.cumulativeAccepted.toString(),
      currentAcceptedCumulative: (sellerState.cumulativeAccepted - 1200n).toString(),
      deposit: '500000',
      requestId: request.requestId,
      lastRequestCost: '1200',
      inputTokens: '300000',
      cachedInputTokens: '50000',
      freshInputTokens: '250000',
      outputTokens: '20000',
      service: 'test-model',
    }));
  });

  conn.on('message', (bytes: Uint8Array) => {
    for (const frame of decoder.feed(bytes)) {
      if (frame.type === 0x10) {
        conn.send(nodeEncodeFrame({ type: 0x11, messageId: frame.messageId, payload: frame.payload }));
      } else if (frame.type === MessageType.SpendingAuth) {
        const auth: SpendingAuthPayload = decodeSpendingAuth(frame.payload);
        const domain = makeChannelsDomain(CHAIN_ID, CHANNELS_ADDRESS);
        if (auth.reserveSalt) {
          const signer = verifyTypedData(domain, RESERVE_AUTH_TYPES, {
            channelId: auth.channelId,
            maxAmount: BigInt(auth.reserveMaxAmount!),
            deadline: BigInt(auth.reserveDeadline!),
          }, auth.spendingAuthSig);
          if (signer.toLowerCase() !== buyerWallet.address.toLowerCase()) return;
          sellerState.reserveAuths.push(auth);
          sellerState.hasChannel = true;
          sellerState.channelId = auth.channelId;
          sendPaymentFrame(MessageType.AuthAck, encodeAuthAck({ channelId: auth.channelId }));
        } else {
          const signer = verifyTypedData(domain, SPENDING_AUTH_TYPES, {
            channelId: auth.channelId,
            cumulativeAmount: BigInt(auth.cumulativeAmount),
            metadataHash: auth.metadataHash,
          }, auth.spendingAuthSig);
          if (signer.toLowerCase() !== buyerWallet.address.toLowerCase()) return;
          if (keccak256(auth.metadata) !== auth.metadataHash) return;
          sellerState.spendingAuths.push(auth);
        }
      } else {
        void mux.handleFrame(frame);
      }
    }
  });
}

beforeAll(async () => {
  manager = await ConnectionManager.init();
  manager.setLocalIdentity({ peerId: toPeerId(sellerPeerId), wallet: sellerWallet as any });
  manager.on('connection', (conn: any) => wireSellerConnection(conn));
  await manager.startListening({ peerId: toPeerId(sellerPeerId), port: 0, host: '127.0.0.1' });
  const sellerPort = manager.getListeningPort();
  if (!sellerPort) throw new Error('seller failed to bind');

  const cache = new SellerCache({
    dht: false,
    pollIntervalMs: 60_000,
    staticSellers: [{ peerId: sellerPeerId, host: '127.0.0.1', port: sellerPort }],
  });
  relay = new RelayServer(cache, {
    port: 0,
    maxBridgesPerIp: 8,
    tcpConnectTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
  });
  await relay.start();

  const client = AntseedWebClient.ephemeral({
    relayUrl: `http://127.0.0.1:${relay.address().port}`,
    privateKey: buyerWallet.privateKey,
    payment: { chainId: CHAIN_ID, channelsContractAddress: CHANNELS_ADDRESS, rpcUrl: '' },
    // Offline test: stub the read-only deposits check the negotiator requires.
    depositsClient: {
      getBuyerBalance: async () => ({ available: 10_000_000n, reserved: 0n, lastActivityAt: 0n }),
    } as any,
    channelsClient: null,
    env: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, WebSocket: WebSocket as any },
  });

  const sellers = await client.sellers();
  expect(sellers.map((s) => s.peerId)).toContain(sellerPeerId);
  session = await client.connect(sellerPeerId);
}, 60_000);

afterAll(async () => {
  session?.close();
  await relay?.stop();
  await manager?.stopListening();
});

describe('web-sdk ↔ unmodified seller stack', () => {
  it('negotiates payment on 402 and gets a 200', async () => {
    const response = await session.request({
      path: '/v1/messages',
      provider: 'test',
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.body)).ok).toBe(true);
    expect(sellerState.reserveAuths).toHaveLength(1);
    expect(sellerState.reserveAuths[0]!.cumulativeAmount).toBe('0');
    expect(sellerState.reserveAuths[0]!.reserveMaxAmount).toBe('500000');
  }, 30_000);

  it('answers NeedAuth with a valid cumulative SpendingAuth', async () => {
    await waitFor(() => sellerState.spendingAuths.length >= 1);
    const auth = sellerState.spendingAuths[0]!;
    expect(auth.channelId).toBe(sellerState.channelId);
    expect(auth.cumulativeAmount).toBe('1200');
    expect(keccak256(auth.metadata)).toBe(auth.metadataHash);
  }, 15_000);

  it('streams SSE responses chunk by chunk', async () => {
    const chunks: string[] = [];
    let sawDone = false;
    const response = await session.request(
      {
        path: '/v1/messages',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'test-model', stream: true }),
      },
      {
        onChunk: (data, done) => {
          chunks.push(new TextDecoder().decode(data));
          if (done) sawDone = true;
        },
      },
    );
    expect(response.statusCode).toBe(200);
    expect(sawDone).toBe(true);
    expect(chunks.join('')).toContain('data: {"delta":"hel"}');
    expect(chunks.join('')).toContain('[DONE]');
    await waitFor(() => sellerState.spendingAuths.length >= 2);
    expect(sellerState.spendingAuths[1]!.cumulativeAmount).toBe('2400');
  }, 30_000);

  it('delivers large bodies via chunked upload', async () => {
    const body = new Uint8Array(300 * 1024).fill(0x61);
    const response = await session.request({
      path: '/v1/upload',
      headers: { 'x-upload-echo': '1' },
      body,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(response.body)).received).toBe(body.length);
    expect(sellerState.uploadedBodies).toEqual([body.length]);
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
