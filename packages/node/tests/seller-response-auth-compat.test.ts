import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import {
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  MessageType,
} from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';
import { decodeResponseAuth } from '../src/verification/codec.js';
import { hashRequest } from '../src/verification/response-auth.js';

function makeProvider(): Provider {
  return {
    name: 'test-provider',
    services: ['test-model'],
    pricing: {
      defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    },
    maxConcurrency: 1,
    async handleRequest(req) {
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ ok: true })),
      };
    },
    getCapacity() {
      return { current: 0, max: 1 };
    },
  };
}

function makeHandler(): SellerRequestHandler {
  return new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [makeProvider()],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
  });
}

const REQUEST = {
  requestId: 'req-response-auth-compat',
  method: 'POST',
  path: '/v1/messages',
  headers: { 'content-type': 'application/json' } as Record<string, string>,
  body: new TextEncoder().encode(JSON.stringify({ model: 'test-model' })),
};

async function serveRequest(conn: {
  send: ReturnType<typeof vi.fn>;
  hasRemoteCapability: (capability: string) => boolean;
}, request = REQUEST): Promise<number[]> {
  const handler = makeHandler();
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const verificationMux = new VerificationMux(conn as any);
  const { mux } = handler.handleConnection(conn as any, '22'.repeat(20), paymentMux, verificationMux);

  await mux.handleFrame({
    type: MessageType.HttpRequest,
    messageId: 1,
    payload: encodeHttpRequest(request),
  });

  return conn.send.mock.calls.map(([frame]) => decodeFrame(frame)!.message.type);
}

describe('Seller response auth compatibility', () => {
  it('does not send response auth to peers without the response-auth capability', async () => {
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn(() => false),
    };

    const frameTypes = await serveRequest(conn);

    expect(frameTypes).toContain(MessageType.HttpResponse);
    expect(frameTypes).not.toContain(MessageType.VerificationResponseAuth);
  });

  it('sends response auth to peers that advertise the response-auth capability', async () => {
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn((capability: string) => capability === CONNECTION_CAPABILITY_RESPONSE_AUTH_V1),
    };

    const frameTypes = await serveRequest(conn);

    expect(frameTypes).toContain(MessageType.HttpResponse);
    expect(frameTypes).toContain(MessageType.VerificationResponseAuth);
  });

  it('signs the request as the buyer sent it, including a free-tier delegation header', async () => {
    const conn = {
      send: vi.fn(),
      hasRemoteCapability: vi.fn((capability: string) => capability === CONNECTION_CAPABILITY_RESPONSE_AUTH_V1),
    };
    const request = { ...REQUEST, headers: { ...REQUEST.headers, 'x-antseed-free-tier-delegations': 'delegations' } };

    await serveRequest(conn, request);

    const authFrame = conn.send.mock.calls
      .map(([frame]) => decodeFrame(frame)!.message)
      .find((message) => message.type === MessageType.VerificationResponseAuth)!;
    expect(decodeResponseAuth(authFrame.payload).requestHash).toBe(hashRequest(request));
  });
});
