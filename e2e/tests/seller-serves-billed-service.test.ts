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

/** Every value an upstream could take the model from, in any spelling of the field. */
function modelFieldsSent(init: RequestInit): string[] {
  const body = Buffer.from(init.body as Uint8Array).toString('latin1');
  const contentType = new Headers(init.headers).get('content-type') ?? '';
  const multipartBoundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!multipartBoundary) {
    return Object.entries(JSON.parse(body) as Record<string, string>)
      .filter(([name]) => /^(model|modelid)$/i.test(name))
      .map(([, value]) => value);
  }
  return body.split(`--${multipartBoundary}`)
    .filter((part) => /name\*?=\s*"?(model|modelid)"?/i.test(part.split('\r\n\r\n')[0]!))
    .map((part) => part.split('\r\n\r\n')[1]!.trim());
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
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return answer();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

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
    expect(modelFieldsSent(calls[0]!.init), 'the upstream serves only the billed service').toEqual([upstreamModel]);
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
  ])('%s never reaches the upstream', async (_name, sent) => {
    const calls = stubUpstream();
    const provider = await openaiPlugin.createProvider(CONFIG);
    const response = await serve(provider, sent);
    expect(calls.map(({ init }) => modelFieldsSent(init)), 'the upstream serves only the billed service').toEqual([]);
    expect(response.statusCode).toBe(400);
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
    expect(sent.get('modelId')).toBe('nano-banana-pro-edit');
    expect(sent.has('model')).toBe(false);
  });
});
