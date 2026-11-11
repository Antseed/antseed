import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { MessageType } from '../src/types/protocol.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import { ResourceOwnershipStore } from '../src/resources/resource-ownership-store.js';
import { VerificationMux } from '../src/verification/index.js';
import { relayMultipartBody } from './helpers/frozen-relay-multipart.js';

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
    expect(refused.error.code).toBe('ambiguous_service');
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

  it.each<[string, SerializedHttpRequest]>([
    ['JSON model list and route', jsonRequest({ model: 'billed-model', models: ['other-model'], route: 'fallback' })],
    ['JSON fallback list', jsonRequest({ model: 'billed-model', fallbacks: ['other-model'], mock_testing_fallbacks: true })],
    ['multipart fallback list', multipartRequest([['model', 'billed-model'], ['fallbacks', 'other-model']])],
  ])('refuses upstream model selection before payment: %s', async (_name, sent) => {
    const target = provider(PAID);
    const result = await serve(target, sent, {
      channelsClient: {},
      sellerPaymentManager: {
        hasSession: () => false,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      },
    });
    expect(result.response.statusCode).toBe(400);
    expect(result.error.code).toBe('unsupported_model_selector');
    expect(result.error.message).toMatch(/^Field "(models|fallbacks)" selects an upstream model/);
    expect(result.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(result.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });

  it.each(['quality', 'n', 'size', 'resolution'])('refuses repeated %s before calling a paid provider', async (name) => {
    const target = provider(PAID);
    const sent = multipartRequest([['model', 'billed-model'], [name, 'first'], [name, 'second']]);
    const result = await serve(target, sent, {
      channelsClient: {},
      sellerPaymentManager: {
        hasSession: () => false,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      },
    });
    expect(result.response.statusCode).toBe(400);
    expect(result.error).toEqual({ type: 'invalid_request_error', code: 'repeated_field', message: `Field "${name}" must appear once.` });
    expect(result.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });

  it.each<[string, SerializedHttpRequest, string]>([
    ['a body naming no service', jsonRequest({ messages: [] }), 'model_required'],
    ['a service this seller does not publish', jsonRequest({ model: 'unpublished-model' }), 'model_not_found'],
    ['a JSON modelId', jsonRequest({ model: 'billed-model', modelId: 'billed-model' }), 'ambiguous_service'],
    ['a repeated JSON n', request({ 'content-type': 'application/json' }, new TextEncoder().encode('{"model":"billed-model","n":1,"n":10}')), 'repeated_field'],
    ['a multipart quality in another case', multipartRequest([['model', 'billed-model'], ['QUALITY', 'high']]), 'invalid_billing_field'],
    ['a multipart body with a preamble', { ...multipartRequest([['model', 'billed-model']]), body: new TextEncoder().encode(`preamble\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nbilled-model\r\n--${boundary}--\r\n`) }, 'unsupported_multipart_body'],
    ['two Content-Type headers', jsonRequest({ model: 'billed-model' }, { 'Content-Type': 'text/plain' }), 'ambiguous_content_type'],
  ])('answers %s with its own error code, before payment', async (_name, sent, code) => {
    const target = provider(PAID);
    const result = await serve(target, sent, {
      channelsClient: {},
      sellerPaymentManager: {
        hasSession: () => false,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      },
    });
    expect(result.response.statusCode).toBe(400);
    expect(result.error.code).toBe(code);
    expect(result.error.type).toBe('invalid_request_error');
    expect(result.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
    expect(result.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
    expect(target.received).toEqual([]);
  });

  const contentTypes = (received: SerializedHttpRequest) =>
    Object.entries(received.headers).filter(([name]) => name.toLowerCase() === 'content-type');

  it.each<[string, Record<string, string>]>([
    ['a form, as curl -d sends', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['text, as a browser fetch sends', { 'content-type': 'text/plain;charset=UTF-8' }],
    ['text under a capitalized header', { 'Content-Type': 'text/plain' }],
    ['another multipart', { 'content-type': 'multipart/mixed; boundary=x' }],
    ['JSON followed by a form', { 'content-type': 'application/json, application/x-www-form-urlencoded' }],
    ['JSON in UTF-7', { 'content-type': 'application/json; charset=utf-7' }],
    ['JSON in UTF-16', { 'content-type': 'application/json; charset=utf-16' }],
    ['JSON with a charset', { 'Content-Type': 'application/json; charset=utf-8' }],
    ['a JSON suffix type', { 'content-type': 'application/vnd.api+json' }],
    ['nothing', {}],
  ])('hands a provider a JSON body the buyer labelled %s as JSON, bytes unchanged', async (_name, headers) => {
    // The same bytes read as a form would name another model, so the label must not survive.
    const sent = request(headers, new TextEncoder().encode(JSON.stringify({ model: 'billed-model', prompt: '&model=other-model&' })));
    const target = provider();
    expect((await serve(target, sent)).response.statusCode).toBe(200);
    const received = target.received[0]!;
    expect(contentTypes(received)).toEqual([['content-type', 'application/json']]);
    expect(received.body).toEqual(sent.body);
    expect(serviceHeaders(received)).toEqual([['x-antseed-service', 'billed-model']]);
  });

  it('refuses a body under such a label that is not JSON, and leaves a form\'s content type as the buyer sent it', async () => {
    const form = provider();
    const refused = await serve(form, request({ 'content-type': 'application/x-www-form-urlencoded' }, new TextEncoder().encode('model=billed-model&prompt=x')));
    expect(refused.response.statusCode).toBe(400);
    expect(refused.error.code).toBe('model_required');
    expect(form.received).toEqual([]);

    const target = provider();
    const sent = multipartRequest([['model', 'billed-model']], {});
    expect((await serve(target, { ...sent, headers: { 'Content-Type': sent.headers['content-type']! } })).response.statusCode).toBe(200);
    expect(contentTypes(target.received[0]!)).toEqual([['Content-Type', `multipart/form-data; boundary=${boundary}`]]);
    expect(target.received[0]!.body).toEqual(sent.body);
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

  // No relay here: this is what a plugin that forwards the bytes as they are hands its upstream.
  it.each<[string, SerializedHttpRequest, Record<string, string[]>]>([
    ['JSON with only model', jsonRequest({ model: 'billed-model' }), { model: ['billed-model'] }],
    ['JSON with only service', jsonRequest({ service: 'billed-model' }), { service: ['billed-model'] }],
    ['JSON with both fields', jsonRequest({ service: 'billed-model', model: 'billed-model' }), { service: ['billed-model'], model: ['billed-model'] }],
    ['multipart with only model', multipartRequest([['model', 'billed-model'], ['prompt', 'x']]), { model: ['billed-model'] }],
    ['multipart with only service', multipartRequest([['service', 'billed-model'], ['prompt', 'x']]), { service: ['billed-model'] }],
    ['multipart with both fields', multipartRequest([['service', 'billed-model'], ['model', 'billed-model']]), { service: ['billed-model'], model: ['billed-model'] }],
    ['multipart with a buyer header', multipartRequest([['model', 'billed-model']], { 'x-antseed-service': 'other-model' }), { model: ['billed-model'] }],
  ])('hands a provider only the billed service, to a reader sharing none of the seller code: %s', async (_name, sent, expected) => {
    const target = provider();
    expect((await serve(target, sent)).response.statusCode).toBe(200);
    const received = target.received[0]!;
    const contentType = received.headers['content-type']!;
    const entries: Array<[string, unknown]> = contentType.startsWith('multipart/')
      ? [...(await new Response(received.body, { headers: { 'content-type': contentType } }).formData()).entries()]
      : Object.entries(JSON.parse(new TextDecoder().decode(received.body)) as Record<string, unknown>);
    const read: Record<string, unknown[]> = {};
    for (const [name, value] of entries) {
      if (/^(service|model|modelid)$/i.test(name)) (read[name] ??= []).push(value);
    }
    expect(read).toEqual(expected);
    expect(serviceHeaders(received)).toEqual([['x-antseed-service', 'billed-model']]);
  });

  // Installed plugins pin their own relay, so these run a copy frozen before this change (see the helper).
  describe('in front of a relay installed before this change', () => {
    type Part = [headers: string, content: string];
    const ALIASES = { 'billed-model': 'upstream-model' };
    const text = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
    const image: Part = ['Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG'];
    const form = (parts: Part[]) => request(
      { 'content-type': `multipart/form-data; boundary=${boundary}` },
      new TextEncoder().encode(`${parts.map(([headers, content]) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`).join('')}--${boundary}--\r\n`),
      '/v1/images/edits',
    );
    /** What an upstream reads from the body that relay sends it, by a parser sharing none of the seller's or the relay's code. */
    const upstreamReads = async (handed: Pick<SerializedHttpRequest, 'headers' | 'body'>) => {
      const sent = relayMultipartBody(handed, ALIASES);
      const read = await new Response(sent, { headers: { 'content-type': handed.headers['content-type']! } }).formData();
      return Promise.all([...read.entries()].map(async ([name, value]) => [name, typeof value === 'string' ? value : `file:${await value.text()}`]));
    };
    const payments = {
      channelsClient: {},
      sellerPaymentManager: {
        hasSession: () => false,
        getPaymentRequirements: () => ({ minBudgetPerRequest: '10000', suggestedAmount: '1000000' }),
      },
    };
    const quoted = 'content-disposition: form-data; name="model"';

    it.each<[string, Part[]]>([
      ['on a file part', [[`X-Note: ${quoted}\r\n${image[0]}`, 'PNG'], text('model', 'billed-model')]],
      ['on a prompt part', [[`X-Note: ${quoted}\r\n${text('prompt', '')[0]}`, 'keep this prompt'], text('model', 'billed-model')]],
      ['in upper case', [[`X-Note: ${quoted.toUpperCase().replace('"MODEL"', '"model"')}\r\n${image[0]}`, 'PNG'], text('model', 'billed-model')]],
      ['in a Content-Type parameter', [[`Content-Type: image/png; ${quoted}\r\nContent-Disposition: form-data; name="image"; filename="a.png"`, 'PNG'], text('model', 'billed-model')]],
      ['naming modelId beside a service field', [[`X-Note: ${quoted.replace('model', 'modelId')}\r\n${image[0]}`, 'PNG'], text('service', 'billed-model')]],
    ])('refuses a part whose other header quotes a disposition line, before that relay could rewrite it: %s', async (_name, parts) => {
      const sent = form(parts);
      // Why it is refused: that relay takes the quoting part for the model field and writes the upstream model into it.
      const rewritten = await upstreamReads({ headers: { ...sent.headers, 'x-antseed-service': 'billed-model' }, body: sent.body });
      expect(rewritten.some(([name, value]) => /^(image|prompt)$/.test(name!) && String(value).includes('upstream-model'))).toBe(true);

      const target = provider(PAID);
      const result = await serve(target, sent, payments);
      expect(result.response.statusCode).toBe(400);
      expect(result.error.code).toBe('unsupported_multipart_body');
      expect(result.paymentMux.sendNeedAuth).not.toHaveBeenCalled();
      expect(result.paymentMux.sendPaymentRequired).not.toHaveBeenCalled();
      expect(target.received).toEqual([]);
    });

    it.each<[string, Part[], Array<[string, string]>]>([
      ['a model, a prompt and a file', [text('model', 'billed-model'), text('prompt', 'make it blue'), image],
        [['model', 'upstream-model'], ['prompt', 'make it blue'], ['image', 'file:PNG']]],
      ['a file before the model', [image, text('model', 'billed-model')],
        [['image', 'file:PNG'], ['model', 'upstream-model']]],
      ['a prompt quoting a disposition line in its text', [text('prompt', quoted), text('model', 'billed-model')],
        [['prompt', quoted], ['model', 'upstream-model']]],
      ['a file with the type before the disposition', [['Content-Type: image/png\r\nContent-Disposition: form-data; name="image"; filename="model"', 'PNG'], text('model', 'billed-model')],
        [['image', 'file:PNG'], ['model', 'upstream-model']]],
      ['a file with another header', [[`${image[0]}\r\nX-Note: taken today`, 'PNG'], text('model', 'billed-model')],
        [['image', 'file:PNG'], ['model', 'upstream-model']]],
      ['lower-case part headers', [['content-disposition: form-data; name="model"', 'billed-model'], image],
        [['model', 'upstream-model'], ['image', 'file:PNG']]],
    ])('hands that relay a body it rewrites only in the model part: %s', async (_name, parts, expected) => {
      const target = provider();
      expect((await serve(target, form(parts))).response.statusCode).toBe(200);
      expect(await upstreamReads(target.received[0]!)).toEqual(expected);
    });
  });

  it('serves a video by the model it bills and passes its body through unchanged', async () => {
    const video = provider(FREE, {
      name: 'venice',
      services: ['video'],
      serviceApiProtocols: { video: ['venice-video'] },
      serviceUnitBillingModels: { video: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0 }] } } },
      handleRequest: async (request) => {
        video.received.push(request);
        return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ queue_id: 'job' })) };
      },
    });
    const store = new ResourceOwnershipStore(join(mkdtempSync(join(tmpdir(), 'antseed-billed-video-')), 'metering.db'));
    try {
      const sent = { ...jsonRequest({ model: 'video', service: 'video', prompt: 'x', duration: 5 }, { 'x-antseed-service': 'other' }), path: '/api/v1/video/queue' };
      const { response } = await serve(video, sent, { sellerPaymentManager: null, channelsClient: null, resourceOwnershipStore: store });
      expect(response.statusCode).toBe(200);
      expect(serviceHeaders(video.received[0]!)).toEqual([['x-antseed-service', 'video']]);
      expect(video.received[0]!.body).toEqual(sent.body);
    } finally { store.close(); }
  });

  it('refuses a video create whose service field names another service', () => {
    const video = provider(FREE, { services: ['wan-2.5', 'other-video'], serviceApiProtocols: { 'wan-2.5': ['venice-video'], 'other-video': ['venice-video'] } });
    const create = (fields: unknown) => ({ ...jsonRequest(fields), path: '/api/v1/video/queue' });
    expect(handlerFor(video).matchProvider(create({ model: 'wan-2.5', service: 'other-video' }))).toBeUndefined();
    expect(handlerFor(video).matchProvider(create({ service: 'wan-2.5' }))).toBeUndefined();
    expect(handlerFor(video).matchProvider(create({ model: 'wan-2.5' }))).toBe(video);
    expect(handlerFor(video).matchProvider(create({ model: 'wan-2.5', service: 'wan-2.5' }))).toBe(video);
  });

  it('leaves services not read from the body to their own readers', () => {
    const video = provider(FREE, { services: ['wan-2.5'], serviceApiProtocols: { 'wan-2.5': ['venice-video'] } });
    const retrieve = { ...jsonRequest({ model: 'other', queue_id: 'job' }, { 'x-antseed-service': 'wan-2.5' }), path: '/api/v1/video/retrieve' };
    expect(handlerFor(video).matchProvider(retrieve)).toBe(video);

    const router = provider(FREE, { services: ['router'], serviceApiProtocols: { router: ['irp-suggest'] } });
    const rank = { ...jsonRequest({ model: 'a', service: 'b', request: {}, routing: { candidates: [] } }), path: '/v1/routing/rank' };
    expect(handlerFor(router).matchProvider(rank)).toBe(router);
  });
});
