import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { VerificationMux } from '../src/verification/index.js';

const BUYER = '33'.repeat(20);
const NONCE = 'ab'.repeat(32);
const ATTESTATION = { nonce: NONCE, signing_key: '04aa' };

function makeProvider() {
  const handleRequest = vi.fn();
  const getE2eeAttestation = vi.fn(async (_service: string, _nonce: string) => ({
    statusCode: 200,
    body: new TextEncoder().encode(JSON.stringify(ATTESTATION)),
  }));
  const provider: Provider = {
    name: 'test-provider',
    services: ['private-model', 'plain-model'],
    serviceCategories: { 'private-model': ['chat', 'e2ee'], 'plain-model': ['chat'] },
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    handleRequest,
    getCapacity: () => ({ current: 0, max: 1 }),
    getE2eeAttestation,
  };
  return { provider, handleRequest, getE2eeAttestation };
}

async function send(path: string, method = 'GET', count = 1) {
  const { provider, handleRequest, getE2eeAttestation } = makeProvider();
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: vi.fn(() => true),
  });
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any;
  const { mux } = handler.handleConnection(conn as any, BUYER, paymentMux, new VerificationMux(conn as any));
  for (let i = 0; i < count; i += 1) {
    await mux.handleFrame({
      type: MessageType.HttpRequest,
      messageId: i + 1,
      payload: encodeHttpRequest({ requestId: `req-${i}`, method, path, headers: {}, body: new Uint8Array(0) }),
    });
  }
  const responses = conn.send.mock.calls
    .map(([raw]) => decodeFrame(raw)!.message)
    .filter((message) => message.type === MessageType.HttpResponse)
    .map((frame) => decodeHttpResponse(frame.payload));
  const json = (index: number) => JSON.parse(new TextDecoder().decode(responses[index]!.body));
  return { responses, json, handleRequest, getE2eeAttestation, paymentMux };
}

describe('Seller end-to-end encryption attestation route', () => {
  it('relays the provider attestation for an e2ee service, free of charge', async () => {
    const { responses, json, handleRequest, getE2eeAttestation, paymentMux } =
      await send(`/_antseed/e2ee/attestation?service=private-model&nonce=${NONCE}`);
    expect(responses[0]!.statusCode).toBe(200);
    expect(json(0)).toEqual(ATTESTATION);
    expect(getE2eeAttestation).toHaveBeenCalledWith('private-model', NONCE);
    expect(handleRequest).not.toHaveBeenCalled();
    expect(paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
  });

  it('refuses a service not announced as e2ee', async () => {
    const { responses, json, getE2eeAttestation } = await send(`/_antseed/e2ee/attestation?service=plain-model&nonce=${NONCE}`);
    expect(responses[0]!.statusCode).toBe(404);
    expect(json(0).error.code).toBe('e2ee_not_supported');
    expect(getE2eeAttestation).not.toHaveBeenCalled();
  });

  it.each([
    ['a short nonce', `/_antseed/e2ee/attestation?service=private-model&nonce=abcd`, 'GET'],
    ['no service', `/_antseed/e2ee/attestation?nonce=${NONCE}`, 'GET'],
    ['POST', `/_antseed/e2ee/attestation?service=private-model&nonce=${NONCE}`, 'POST'],
  ])('rejects %s', async (_label, path, method) => {
    const { responses, getE2eeAttestation } = await send(path, method);
    expect(responses[0]!.statusCode).toBe(400);
    expect(getE2eeAttestation).not.toHaveBeenCalled();
  });

  it('shares the attestation rate limit', async () => {
    const { responses, getE2eeAttestation } = await send(`/_antseed/e2ee/attestation?service=private-model&nonce=${NONCE}`, 'GET', 11);
    expect(responses.map((r) => r.statusCode).filter((s) => s === 429)).toHaveLength(1);
    expect(getE2eeAttestation).toHaveBeenCalledTimes(10);
  });
});
