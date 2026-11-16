import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';

const LIMIT_BYTES = 1024;

/** A seller that holds at most LIMIT_BYTES of request bodies, with an upstream that answers when released. */
function seller() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const provider: Provider = {
    name: 'codex',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 8,
    handleRequest: vi.fn(async (req) => {
      await held;
      return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"ok":true}') };
    }),
    getCapacity: () => ({ current: 0, max: 8 }),
  };
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
    maxUploadBodyBytes: LIMIT_BYTES,
    maxInFlightRequestBytes: LIMIT_BYTES,
  });

  /** A buyer's connection: `send` starts a request of about `bodyBytes`, `response` reads what came back for it. */
  const connect = (buyer: string) => {
    const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
    const { mux } = handler.handleConnection(conn as any, buyer.repeat(20), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
    return {
      send: (requestId: string, bodyBytes: number) => mux.handleFrame({
        type: MessageType.HttpRequest,
        messageId: 1,
        payload: encodeHttpRequest({
          requestId, method: 'POST', path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'x'.repeat(bodyBytes) }] })),
        }),
      }),
      response: (requestId: string) => conn.send.mock.calls
        .map(([raw]) => decodeFrame(raw)!.message)
        .filter((message) => message.type === MessageType.HttpResponse)
        .map((message) => decodeHttpResponse(message.payload))
        .find((response) => response.requestId === requestId),
    };
  };
  return { connect, release: () => release() };
}

describe('seller request bytes in flight', () => {
  it('turns away a request that would pass the limit while others are being served, on any connection', async () => {
    const { connect, release } = seller();
    const first = connect('22');
    const second = connect('33');

    const serving = first.send('a', 600);
    await second.send('b', 600);

    const refused = second.response('b')!;
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');
    expect(JSON.parse(new TextDecoder().decode(refused.body)).error.code).toBe('seller_busy');
    expect(first.response('a')).toBeUndefined();

    release();
    await serving;
    expect(first.response('a')!.statusCode).toBe(200);
  });

  it('frees a request\'s bytes once it has been answered', async () => {
    const { connect, release } = seller();
    const buyer = connect('22');
    release();

    await buyer.send('a', 600);
    await buyer.send('b', 600);

    expect(buyer.response('a')!.statusCode).toBe(200);
    expect(buyer.response('b')!.statusCode).toBe(200);
  });
});
