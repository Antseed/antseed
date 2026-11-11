import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { VerificationMux } from '../src/verification/index.js';

const FREE = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
const PAID = { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
const boundary = 'form-boundary';

function provider(pricing = FREE, extra: Partial<Provider> = {}): Provider & { received: SerializedHttpRequest[] } {
  const received: SerializedHttpRequest[] = [];
  return {
    name: 'test-provider',
    services: ['billed-model', 'other-model'],
    pricing,
    maxConcurrency: 1,
    received,
    handleRequest: async (request) => {
      received.push(request);
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{}') };
    },
    getCapacity: () => ({ current: 0, max: 1 }),
    ...extra,
  };
}

function handlerFor(target: Provider, payments: object = { sellerPaymentManager: null, channelsClient: null }) {
  return new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [target],
    sessionTracker: null,
    announcer: null,
    emit: () => false,
    ...payments,
  } as ConstructorParameters<typeof SellerRequestHandler>[0]);
}

function request(headers: Record<string, string>, body: Uint8Array, path = '/v1/chat/completions'): SerializedHttpRequest {
  return { requestId: 'req-1', method: 'POST', path, headers, body };
}

const jsonRequest = (fields: unknown, headers: Record<string, string> = {}) =>
  request({ 'content-type': 'application/json', ...headers }, new TextEncoder().encode(JSON.stringify(fields)));

const multipartRequest = (parts: Array<[string, string]>, headers: Record<string, string> = {}) => request(
  { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
  new TextEncoder().encode(`${parts.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')}--${boundary}--\r\n`),
  '/v1/images/edits',
);

async function serve(target: Provider, sent: SerializedHttpRequest, payments?: object) {
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const paymentMux = { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() };
  const { mux } = handlerFor(target, payments).handleConnection(conn as any, '22'.repeat(20), paymentMux as any, new VerificationMux(conn as any));
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest(sent) });
  const frame = conn.send.mock.calls.map(([bytes]) => decodeFrame(bytes)!.message).find((message) => message.type === MessageType.HttpResponse)!;
  const response = decodeHttpResponse(frame.payload);
  return { response, error: JSON.parse(new TextDecoder().decode(response.body))?.error, paymentMux };
}

const serviceHeaders = (received: SerializedHttpRequest) =>
  Object.entries(received.headers).filter(([name]) => name.toLowerCase() === 'x-antseed-service');

describe('the seller serves the service it bills', () => {
  it('refuses a request that could read as another service, before the provider and any payment', async () => {
    const payments = {
      channelsClient: {},
      sellerPaymentManager: {
        hasSession: () => false,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      },
    };
    const honest = provider(PAID);
    const paid = await serve(honest, jsonRequest({ model: 'billed-model' }), payments);
    expect(paid.response.statusCode).toBe(402);
    expect(paid.paymentMux.sendPaymentRequired).toHaveBeenCalledTimes(1);

    const target = provider(PAID);
    const refused = await serve(target, jsonRequest({ service: 'billed-model', model: 'other-model' }), payments);
    expect(refused.response.statusCode).toBe(400);
    expect(refused.error.code).toBe('model_required');
    expect(refused.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });

  it.each<[string, SerializedHttpRequest]>([
    ['JSON service and model', jsonRequest({ service: 'billed-model', model: 'other-model' })],
    ['JSON modelId', jsonRequest({ model: 'billed-model', modelId: 'other-model' })],
    ['multipart service and model', multipartRequest([['service', 'billed-model'], ['model', 'other-model']])],
    ['multipart repeated model', multipartRequest([['model', 'billed-model'], ['model', 'other-model']])],
  ])('never hands a provider %s that disagree', async (_name, sent) => {
    const target = provider();
    const { response } = await serve(target, sent);
    expect(response.statusCode).toBe(400);
    expect(target.received).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['lower case', { 'x-antseed-service': 'other-model' }],
    ['another case', { 'X-Antseed-Service': 'other-model' }],
    ['two spellings', { 'x-antseed-service': 'other-model', 'X-ANTSEED-SERVICE': 'other-model' }],
    ['absent', {}],
  ])('tells the provider the billed service with a buyer header in %s', async (_name, headers) => {
    for (const sent of [
      jsonRequest({ model: 'billed-model' }, headers),
      multipartRequest([['model', 'billed-model']], headers),
    ]) {
      const target = provider();
      const { response } = await serve(target, sent);
      expect(response.statusCode).toBe(200);
      expect(serviceHeaders(target.received[0]!)).toEqual([['x-antseed-service', 'billed-model']]);
      expect(target.received[0]!.body).toEqual(sent.body);
    }
  });

  it('leaves services not read from the body to their own readers', () => {
    const video = provider(FREE, { services: ['wan-2.5'], serviceApiProtocols: { 'wan-2.5': ['venice-video'] } });
    const create = { ...jsonRequest({ model: 'wan-2.5', service: 'extension' }), path: '/api/v1/video/queue' };
    expect(handlerFor(video).matchProvider(create)).toBe(video);

    const router = provider(FREE, { services: ['router'], serviceApiProtocols: { router: ['irp-suggest'] } });
    const rank = { ...jsonRequest({ model: 'a', service: 'b', request: {}, routing: { candidates: [] } }), path: '/v1/routing/rank' };
    expect(handlerFor(router).matchProvider(rank)).toBe(router);
  });
});
