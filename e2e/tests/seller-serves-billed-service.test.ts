/// <reference path="../../packages/node/src/types/bittorrent-dht.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import openaiPlugin from '../../plugins/provider-openai/src/index.js';
import { identityFromPrivateKeyHex } from '../../packages/node/src/p2p/identity.js';
import { decodeFrame } from '../../packages/node/src/p2p/message-protocol.js';
import { decodeHttpResponse, encodeHttpRequest } from '../../packages/node/src/proxy/request-codec.js';
import { SellerRequestHandler } from '../../packages/node/src/seller-request-handler.js';
import { MessageType } from '../../packages/node/src/types/protocol.js';
import { VerificationMux } from '../../packages/node/src/verification/index.js';
import type { Provider, SerializedHttpRequest } from '@antseed/node';

/**
 * The real seller handler in front of the real relay, with only the upstream faked. The buyer here
 * is a direct client: the buyer proxy would normalize most of these requests before sending them.
 */
const UPSTREAM = 'https://upstream.example';
const CONFIG = {
  OPENAI_API_KEY: 'k',
  OPENAI_BASE_URL: UPSTREAM,
  ANTSEED_ALLOWED_SERVICES: 'billed-model,other-model,aliased-model',
  ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"aliased-model":"upstream-alias"}',
};
const boundary = 'form-boundary';

type Part = [headers: string, content: string];
type UpstreamCall = { url: string; init: RequestInit };
const field = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
const json = (body: unknown, headers: Record<string, string> = {}): Omit<SerializedHttpRequest, 'requestId'> => ({
  method: 'POST',
  path: '/v1/chat/completions',
  headers: { 'content-type': 'application/json', ...headers },
  body: new TextEncoder().encode(JSON.stringify(body)),
});
const multipart = (parts: Part[], headers: Record<string, string> = {}): Omit<SerializedHttpRequest, 'requestId'> => ({
  method: 'POST',
  path: '/v1/images/edits',
  headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...headers },
  body: new TextEncoder().encode(`${parts.map(([partHeaders, content]) => `--${boundary}\r\n${partHeaders}\r\n\r\n${content}\r\n`).join('')}--${boundary}--\r\n`),
});

/** Every model field the upstream receives, read by a parser the seller's code does not share. */
async function modelFieldsSent({ url, init }: UpstreamCall): Promise<string[]> {
  const request = new Request(url, { method: 'POST', headers: init.headers, body: init.body });
  if (request.headers.get('content-type')?.startsWith('multipart/')) {
    const form = await request.formData();
    return [...form.entries()].filter(([name]) => /^\s*(model|modelid)\s*$/i.test(name)).map(([, value]) => String(value));
  }
  return Object.entries(await request.json() as Record<string, string>)
    .filter(([name]) => /^(model|modelid)$/i.test(name))
    .map(([, value]) => value);
}

async function serve(provider: Provider, sent: Omit<SerializedHttpRequest, 'requestId'>) {
  const conn = { send: vi.fn(), hasRemoteCapability: vi.fn(() => false) };
  const handler = new SellerRequestHandler({
    identity: identityFromPrivateKeyHex('11'.repeat(32)),
    providers: [provider],
    sellerPaymentManager: null,
    sessionTracker: null,
    channelsClient: null,
    announcer: null,
    emit: () => false,
  });
  const { mux } = handler.handleConnection(conn as any, '22'.repeat(20), { sendNeedAuth: vi.fn(), sendPaymentRequired: vi.fn() } as any, new VerificationMux(conn as any));
  await mux.handleFrame({ type: MessageType.HttpRequest, messageId: 1, payload: encodeHttpRequest({ requestId: 'req-1', ...sent }) });
  const frame = conn.send.mock.calls.map(([bytes]) => decodeFrame(bytes)!.message).find((message) => message.type === MessageType.HttpResponse)!;
  return decodeHttpResponse(frame.payload);
}

function stubUpstream(answer: () => Response = () => Response.json({ created: 1, data: [{ b64_json: 'aGk=' }] })) {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return answer();
  });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the seller serves exactly the service it bills', () => {
  it.each<[string, Omit<SerializedHttpRequest, 'requestId'>, string]>([
    ['JSON with only model', json({ model: 'billed-model' }), 'billed-model'],
    ['JSON with only service', json({ service: 'billed-model' }), 'billed-model'],
    ['JSON with both the same', json({ service: 'billed-model', model: 'billed-model' }), 'billed-model'],
    ['JSON through an alias', json({ model: 'aliased-model' }), 'upstream-alias'],
    ['JSON with a buyer header', json({ model: 'billed-model' }, { 'x-antseed-service': 'other-model' }), 'billed-model'],
    ['multipart with only model', multipart([field('model', 'billed-model')]), 'billed-model'],
    ['multipart with only service', multipart([field('service', 'billed-model')]), 'billed-model'],
    ['multipart through an alias', multipart([field('model', 'aliased-model')]), 'upstream-alias'],
    ['multipart with a buyer header', multipart([field('model', 'billed-model')], { 'x-antseed-service': 'other-model' }), 'billed-model'],
    ['multipart with a buyer header in another case', multipart([field('model', 'billed-model')], { 'X-Antseed-Service': 'other-model' }), 'billed-model'],
    ['multipart through an alias with a buyer header', multipart([field('model', 'aliased-model')], { 'x-antseed-service': 'other-model' }), 'upstream-alias'],
  ])('%s reaches the upstream as one model field', async (_name, sent, upstreamModel) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, sent);
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await modelFieldsSent(calls[0]!), 'the upstream serves only the billed service').toEqual([upstreamModel]);
  });

  it.each<[string, Omit<SerializedHttpRequest, 'requestId'>]>([
    ['JSON service and model that differ', json({ service: 'billed-model', model: 'other-model' })],
    ['JSON service with an alias and another model', json({ service: 'aliased-model', model: 'other-model' })],
    ['JSON model in another case', json({ model: 'billed-model', MODEL: 'other-model' })],
    ['JSON modelId', json({ model: 'billed-model', modelId: 'other-model' })],
    ['multipart service and model that differ', multipart([field('service', 'billed-model'), field('model', 'other-model')])],
    ['a padded multipart service', multipart([field('model', 'billed-model'), field('service', `${' '.repeat(5000)}other-model`)])],
    ['an upper-case multipart service parameter', multipart([field('model', 'billed-model'), ['Content-Disposition: form-data; NAME="service"', 'other-model']])],
    ['an upper-case multipart model parameter', multipart([field('model', 'billed-model'), ['Content-Disposition: form-data; NAME="model"', 'other-model']])],
    ['a repeated multipart model', multipart([field('model', 'billed-model'), field('model', 'other-model')])],
    ['multipart modelId next to model', multipart([field('model', 'billed-model'), field('modelId', 'other-model')])],
    ['a multipart boundary with a leading space', {
      ...multipart([]),
      headers: { 'content-type': 'multipart/form-data; boundary=" abc"' },
      body: new TextEncoder().encode('--abc\r\nContent-Disposition: form-data; name="model"\r\n\r\nbilled-model\r\n--abc\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nx\r\n-- abc\r\nContent-Disposition: form-data; name="model"\r\n\r\nother-model\r\n-- abc--\r\n--abc--\r\n'),
    }],
    ['a multipart name in continuations', multipart([['Content-Disposition: form-data; name*0="mod"; name*1="el"', 'other-model'], field('model', 'billed-model')])],
    ['JSON with a null model beside a service', json({ service: 'billed-model', model: null })],
    ['multipart service with modelId', multipart([field('service', 'billed-model'), field('modelId', 'billed-model')])],
    ['a BOM before a multipart model', multipart([field('model', '\uFEFFbilled-model')])],
    ['a padded JSON model', json({ model: ' billed-model ' })],
    ['a padded multipart model', multipart([field('model', ' billed-model ')])],
    ['a repeated JSON model', { ...json({}), body: new TextEncoder().encode('{"model":"other-model","model":"billed-model"}') }],
    ['a repeated JSON n', { ...json({}), body: new TextEncoder().encode('{"model":"billed-model","n":1,"n":10}') }],
    ['a JSON model list', json({ model: 'billed-model', models: ['other-model'], route: 'fallback' })],
    ['a JSON fallback list', json({ model: 'billed-model', fallbacks: ['other-model'] })],
    ['a multipart fallback list', multipart([field('model', 'billed-model'), field('fallbacks', 'other-model')])],
    ['a repeated multipart quality', multipart([field('model', 'billed-model'), field('quality', 'low'), field('quality', 'high')])],
    ['a repeated multipart n', multipart([field('model', 'billed-model'), field('n', '1'), field('n', '10')])],
    ['a multipart size sent as a file', multipart([field('model', 'billed-model'), ['Content-Disposition: form-data; name="size"; filename=""', '1024x1024']])],
    ['a multipart body with text before its first part', {
      ...multipart([]),
      body: new TextEncoder().encode(`--other\r\nContent-Disposition: form-data; name="model"\r\n\r\nother-model\r\n--other--\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nbilled-model\r\n--${boundary}--\r\n`),
    }],
    ['a multipart file part whose other header quotes a disposition line', multipart([
      ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG'],
      field('model', 'aliased-model'),
    ])],
    ['a multipart prompt part whose other header quotes a disposition line', multipart([
      ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="prompt"', 'keep this prompt'],
      field('model', 'aliased-model'),
    ])],
    ['a form sent as a form, not JSON', { ...json({}, { 'content-type': 'application/x-www-form-urlencoded' }), body: new TextEncoder().encode('model=billed-model&prompt=x') }],
  ])('%s never reaches the upstream', async (_name, sent) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, sent);
    expect(await Promise.all(calls.map(modelFieldsSent)), 'the upstream serves only the billed service').toEqual([]);
    expect(response.statusCode).toBe(400);
  });

  it.each<[string, Record<string, string>, string]>([
    ['a form, as curl -d sends', { 'content-type': 'application/x-www-form-urlencoded' }, 'billed-model'],
    ['text, as a browser fetch sends', { 'content-type': 'text/plain;charset=UTF-8' }, 'billed-model'],
    ['text under a capitalized header', { 'Content-Type': 'text/plain' }, 'billed-model'],
    ['JSON in another charset', { 'content-type': 'application/json; charset=utf-7' }, 'billed-model'],
    ['JSON followed by a form', { 'content-type': 'application/json, application/x-www-form-urlencoded' }, 'billed-model'],
    ['a form, through an alias', { 'content-type': 'application/x-www-form-urlencoded' }, 'aliased-model'],
    ['no content type', {}, 'billed-model'],
  ])('a JSON body labelled %s reaches the upstream labelled JSON, as the one billed model', async (_name, headers, model) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    // Read as a form, the same bytes would name another model.
    const sent = { ...json({ model, prompt: '&model=other-model&' }), headers };
    const response = await serve(provider, sent);
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const upstream = new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body });
    expect(upstream.headers.get('content-type')).toBe('application/json');
    expect(await upstream.json()).toEqual({ model: model === 'aliased-model' ? 'upstream-alias' : model, prompt: '&model=other-model&' });
  });

  it('sends the upstream the one value of each priced multipart field, and a file part named like a billing input', async () => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const form = new FormData();
    form.append('model', 'aliased-model');
    form.append('quality', 'high');
    form.append('size', '1024x1024');
    form.append('n', '2');
    form.append('audio', new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/wav' }), 'voice.wav');
    const encoded = new Response(form);
    const response = await serve(provider, {
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.headers.get('content-type')! },
      body: new Uint8Array(await encoded.arrayBuffer()),
    });
    expect(response.statusCode).toBe(200);
    const sent = await new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body }).formData();
    expect(Object.fromEntries(['model', 'quality', 'size', 'n'].map((name) => [name, sent.getAll(name)])))
      .toEqual({ model: ['upstream-alias'], quality: ['high'], size: ['1024x1024'], n: ['2'] });
    const audio = sent.get('audio') as File;
    expect(audio.name).toBe('voice.wav');
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([4, 5, 6]);
  });

  it('forwards the rest of a multipart request unchanged', async () => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const form = new FormData();
    form.append('model', 'aliased-model');
    form.append('prompt', 'make it blue');
    form.append('n', '2');
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    const encoded = new Response(form);
    const response = await serve(provider, {
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.headers.get('content-type')! },
      body: new Uint8Array(await encoded.arrayBuffer()),
    });
    expect(response.statusCode).toBe(200);
    const sent = await new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body }).formData();
    expect(sent.getAll('model')).toEqual(['upstream-alias']);
    expect(sent.get('prompt')).toBe('make it blue');
    expect(sent.get('n')).toBe('2');
    const image = sent.get('image') as File;
    expect(image.name).toBe('a.png');
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('keeps a Venice multi-image edit on its native edit model and modelId field', async () => {
    const calls = stubUpstream(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
    const provider = await openaiPlugin.createProvider({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'https://api.venice.ai/api',
      ANTSEED_ALLOWED_SERVICES: 'nano-banana-pro',
      ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON: '{"nano-banana-pro":"nano-banana-pro-edit"}',
    });
    const form = new FormData();
    form.append('model', 'nano-banana-pro');
    form.append('prompt', 'merge them');
    form.append('image[]', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'model.png');
    form.append('image[]', new Blob([new Uint8Array([2])], { type: 'image/png' }), 'service.png');
    const encoded = new Response(form);
    const response = await serve(provider, {
      method: 'POST',
      path: '/v1/images/edits',
      headers: { 'content-type': encoded.headers.get('content-type')! },
      body: new Uint8Array(await encoded.arrayBuffer()),
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]!.url).toBe('https://api.venice.ai/api/v1/image/multi-edit');
    const sent = await new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body }).formData();
    expect(sent.getAll('modelId')).toEqual(['nano-banana-pro-edit']);
    expect(sent.has('model')).toBe(false);
    expect(sent.get('prompt')).toBe('merge them');
    const images = sent.getAll('images') as File[];
    expect(await Promise.all(images.map(async (image) => [...new Uint8Array(await image.arrayBuffer())]))).toEqual([[1], [2]]);
  });
});
