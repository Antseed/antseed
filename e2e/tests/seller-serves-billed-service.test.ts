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
 * The real seller handler in front of the real relay, with only the upstream faked. The services are image
 * services, so JSON and multipart requests both reach the images API the plugin declares for them. The buyer here
 * is a direct client: the buyer proxy would normalize most of these requests before sending them.
 */
const UPSTREAM = 'https://upstream.example';
const CONFIG = {
  OPENAI_API_KEY: 'k',
  OPENAI_BASE_URL: UPSTREAM,
  ANTSEED_ALLOWED_SERVICES: 'gpt-image-billed,gpt-image-other,gpt-image-aliased',
  ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"gpt-image-aliased":"gpt-image-upstream"}',
};
const boundary = 'form-boundary';

type Part = [headers: string, content: string];
type UpstreamCall = { url: string; init: RequestInit };
const field = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
const json = (body: unknown, headers: Record<string, string> = {}): Omit<SerializedHttpRequest, 'requestId'> => ({
  method: 'POST',
  path: '/v1/images/generations',
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
    ['JSON with only model', json({ model: 'gpt-image-billed' }), 'gpt-image-billed'],
    ['JSON with only service', json({ service: 'gpt-image-billed' }), 'gpt-image-billed'],
    ['JSON with both the same', json({ service: 'gpt-image-billed', model: 'gpt-image-billed' }), 'gpt-image-billed'],
    ['JSON through an alias', json({ model: 'gpt-image-aliased' }), 'gpt-image-upstream'],
    ['JSON with a buyer header', json({ model: 'gpt-image-billed' }, { 'x-antseed-service': 'gpt-image-other' }), 'gpt-image-billed'],
    ['multipart with only model', multipart([field('model', 'gpt-image-billed')]), 'gpt-image-billed'],
    ['multipart with only service', multipart([field('service', 'gpt-image-billed')]), 'gpt-image-billed'],
    ['multipart through an alias', multipart([field('model', 'gpt-image-aliased')]), 'gpt-image-upstream'],
    ['multipart with a buyer header', multipart([field('model', 'gpt-image-billed')], { 'x-antseed-service': 'gpt-image-other' }), 'gpt-image-billed'],
    ['multipart with a buyer header in another case', multipart([field('model', 'gpt-image-billed')], { 'X-Antseed-Service': 'gpt-image-other' }), 'gpt-image-billed'],
    ['multipart through an alias with a buyer header', multipart([field('model', 'gpt-image-aliased')], { 'x-antseed-service': 'gpt-image-other' }), 'gpt-image-upstream'],
    // The seller writes the body again from what it read, so these reach the upstream as what was billed.
    ['a multipart boundary with a leading space', {
      ...multipart([]),
      headers: { 'content-type': 'multipart/form-data; boundary=" abc"' },
      body: new TextEncoder().encode('--abc\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-billed\r\n--abc\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nx\r\n-- abc\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-other\r\n-- abc--\r\n--abc--\r\n'),
    }, 'gpt-image-other'],
    ['a repeated JSON model', { ...json({}), body: new TextEncoder().encode('{"model":"gpt-image-other","model":"gpt-image-billed"}') }, 'gpt-image-billed'],
    ['a repeated JSON n', { ...json({}), body: new TextEncoder().encode('{"model":"gpt-image-billed","n":1,"n":10}') }, 'gpt-image-billed'],
    ['a multipart part that billing would read under another name', multipart([
      field('model', 'gpt-image-billed'),
      ['Content-Disposition: form-data; filenamename="size"; name="user"', '1024x1024'],
      field('size', '1792x1024'),
    ]), 'gpt-image-billed'],
    ['a multipart part that a relay would read as the model', multipart([
      ['Content-Disposition: form-data; filenamename="model"; name="user"', 'gpt-image-other'],
      field('model', 'gpt-image-aliased'),
    ]), 'gpt-image-upstream'],
    ['a multipart body with text before its first part', {
      ...multipart([]),
      body: new TextEncoder().encode(`--other\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-other\r\n--other--\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-billed\r\n--${boundary}--\r\n`),
    }, 'gpt-image-billed'],
    ['a multipart file part whose other header quotes a disposition line', multipart([
      ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG'],
      field('model', 'gpt-image-aliased'),
    ]), 'gpt-image-upstream'],
    ['a multipart prompt part whose other header quotes a disposition line', multipart([
      ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="prompt"', 'keep this prompt'],
      field('model', 'gpt-image-aliased'),
    ]), 'gpt-image-upstream'],
  ])('%s reaches the upstream as one model field', async (_name, sent, upstreamModel) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, sent);
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await modelFieldsSent(calls[0]!), 'the upstream serves only the billed service').toEqual([upstreamModel]);
  });

  it.each<[string, Omit<SerializedHttpRequest, 'requestId'>]>([
    ['JSON service and model that differ', json({ service: 'gpt-image-billed', model: 'gpt-image-other' })],
    ['JSON service with an alias and another model', json({ service: 'gpt-image-aliased', model: 'gpt-image-other' })],
    ['JSON model in another case', json({ model: 'gpt-image-billed', MODEL: 'gpt-image-other' })],
    ['JSON modelId', json({ model: 'gpt-image-billed', modelId: 'gpt-image-other' })],
    ['multipart service and model that differ', multipart([field('service', 'gpt-image-billed'), field('model', 'gpt-image-other')])],
    ['a padded multipart service', multipart([field('model', 'gpt-image-billed'), field('service', `${' '.repeat(5000)}gpt-image-other`)])],
    ['an upper-case multipart service parameter', multipart([field('model', 'gpt-image-billed'), ['Content-Disposition: form-data; NAME="service"', 'gpt-image-other']])],
    ['an upper-case multipart model parameter', multipart([field('model', 'gpt-image-billed'), ['Content-Disposition: form-data; NAME="model"', 'gpt-image-other']])],
    ['a repeated multipart model', multipart([field('model', 'gpt-image-billed'), field('model', 'gpt-image-other')])],
    ['multipart modelId next to model', multipart([field('model', 'gpt-image-billed'), field('modelId', 'gpt-image-other')])],
    ['a multipart name in continuations', multipart([['Content-Disposition: form-data; name*0="mod"; name*1="el"', 'gpt-image-other'], field('model', 'gpt-image-billed')])],
    ['JSON with a null model beside a service', json({ service: 'gpt-image-billed', model: null })],
    ['multipart service with modelId', multipart([field('service', 'gpt-image-billed'), field('modelId', 'gpt-image-billed')])],
    ['a BOM before a multipart model', multipart([field('model', '\uFEFFgpt-image-billed')])],
    ['a padded JSON model', json({ model: ' gpt-image-billed ' })],
    ['a padded multipart model', multipart([field('model', ' gpt-image-billed ')])],
    ['a JSON n in two letter cases', json({ model: 'gpt-image-billed', n: 1, N: 10 })],
    ['a JSON size only in another letter case', json({ model: 'gpt-image-billed', Size: '1792x1024' })],
    ['a repeated multipart quality', multipart([field('model', 'gpt-image-billed'), field('quality', 'low'), field('quality', 'high')])],
    ['a repeated multipart n', multipart([field('model', 'gpt-image-billed'), field('n', '1'), field('n', '10')])],
    ['a multipart size sent as a file', multipart([field('model', 'gpt-image-billed'), ['Content-Disposition: form-data; name="size"; filename=""', '1024x1024']])],
    ['a form sent as a form, not JSON', { ...json({}, { 'content-type': 'application/x-www-form-urlencoded' }), body: new TextEncoder().encode('model=gpt-image-billed&prompt=x') }],
  ])('%s never reaches the upstream', async (_name, sent) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, sent);
    expect(await Promise.all(calls.map(modelFieldsSent)), 'the upstream serves only the billed service').toEqual([]);
    expect(response.statusCode).toBe(400);
  });

  it.each<[string, Record<string, string>, string]>([
    ['a form, as curl -d sends', { 'content-type': 'application/x-www-form-urlencoded' }, 'gpt-image-billed'],
    ['text, as a browser fetch sends', { 'content-type': 'text/plain;charset=UTF-8' }, 'gpt-image-billed'],
    ['text under a capitalized header', { 'Content-Type': 'text/plain' }, 'gpt-image-billed'],
    ['JSON in another charset', { 'content-type': 'application/json; charset=utf-7' }, 'gpt-image-billed'],
    ['JSON followed by a form', { 'content-type': 'application/json, application/x-www-form-urlencoded' }, 'gpt-image-billed'],
    ['a form, through an alias', { 'content-type': 'application/x-www-form-urlencoded' }, 'gpt-image-aliased'],
    ['no content type', {}, 'gpt-image-billed'],
  ])('a JSON body labelled %s reaches the upstream labelled JSON, as the one billed model', async (_name, headers, model) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    // Read as a form, the same bytes would name another model.
    const sent = { ...json({ model, prompt: '&model=gpt-image-other&' }), headers };
    const response = await serve(provider, sent);
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const upstream = new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body });
    expect(upstream.headers.get('content-type')).toBe('application/json');
    expect(await upstream.json()).toEqual({ model: model === 'gpt-image-aliased' ? 'gpt-image-upstream' : model, prompt: '&model=gpt-image-other&' });
  });

  it('sends the upstream the one value of each priced multipart field, and a file part named like a billing input', async () => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const form = new FormData();
    form.append('model', 'gpt-image-aliased');
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
      .toEqual({ model: ['gpt-image-upstream'], quality: ['high'], size: ['1024x1024'], n: ['2'] });
    const audio = sent.get('audio') as File;
    expect(audio.name).toBe('voice.wav');
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([4, 5, 6]);
  });

  it('sends the upstream the values billing read, not those a decoy part names', async () => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, multipart([
      field('model', 'gpt-image-aliased'),
      ['Content-Disposition: form-data; filenamename="size"; name="user"', '1024x1024'],
      field('size', '1792x1024'),
      field('quality', 'low'),
      ['Content-Disposition: form-data; name="decoy"; foo="a\\\\"; bar="x; name=quality; y"', 'high'],
      ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="prompt"', 'keep this prompt'],
    ]));
    expect(response.statusCode).toBe(200);
    const sent = await new Request(calls[0]!.url, { method: 'POST', headers: calls[0]!.init.headers, body: calls[0]!.init.body }).formData();
    expect([...sent.entries()]).toEqual([
      ['model', 'gpt-image-upstream'], ['user', '1024x1024'], ['size', '1792x1024'], ['quality', 'low'], ['decoy', 'high'], ['prompt', 'keep this prompt'],
    ]);
  });

  it('forwards the rest of a multipart request unchanged', async () => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const form = new FormData();
    form.append('model', 'gpt-image-aliased');
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
    expect(sent.getAll('model')).toEqual(['gpt-image-upstream']);
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
