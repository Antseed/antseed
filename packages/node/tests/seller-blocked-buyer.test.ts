import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';

const BLOCKED = '22'.repeat(20);
const OTHER = '33'.repeat(20);

function makeProvider(handleRequest: Provider['handleRequest']): Provider {
  return {
    name: 'test-provider',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 1,
    handleRequest,
    getCapacity: () => ({ current: 0, max: 1 }),
  };
}

async function send(buyerPeerId: string, path: string, method = 'POST') {
  const handleRequest = vi.fn(async (req) => ({
    requestId: req.requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ ok: true })),
  }));
  const emit = vi.fn(() => true);
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [makeProvider(handleRequest)],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    isBuyerBlocked: (peerId) => peerId === BLOCKED,
    emit,
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const { mux } = handler.handleConnection(conn as any, buyerPeerId, paymentMux, new VerificationMux(conn as any));
  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest({
      requestId: 'req-blocked-buyer',
      method,
      path,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify({ model: 'test-model' })),
    }),
  });
  const frame = conn.send.mock.calls
    .map(([raw]) => decodeFrame(raw)!.message)
    .find((message) => message.type === MessageType.HttpResponse)!;
  return { response: decodeHttpResponse(frame.payload), handleRequest, emit };
}

describe('Seller blocked buyers', () => {
  it('refuses a blocked buyer before the provider runs', async () => {
    const { response, handleRequest, emit } = await send(BLOCKED, '/v1/messages');
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(new TextDecoder().decode(response.body)).error.code).toBe('buyer_blocked');
    expect(handleRequest).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('request:blocked', { buyerPeerId: BLOCKED, requestId: 'req-blocked-buyer', path: '/v1/messages' });
  });

  it('serves other buyers', async () => {
    const { response, handleRequest } = await send(OTHER, '/v1/messages');
    expect(response.statusCode).toBe(200);
    expect(handleRequest).toHaveBeenCalledOnce();
  });

  it('keeps the free model listing open to a blocked buyer', async () => {
    const { response } = await send(BLOCKED, '/v1/models', 'GET');
    expect(response.statusCode).toBe(200);
  });
});
