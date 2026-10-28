import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { ANTSEED_UPLOAD_THRESHOLD_BYTES } from '../../packages/protocol/src/http.js';
import { MockOpenAIChatProvider, MockOpenAIImageProvider } from './helpers/mock-openai-provider.js';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { usePaymentNetwork } from './helpers/payment-network.js';
import veniceVideoPlugin from '../../plugins/provider-venice-video/src/index.js';
import falVideoPlugin from '../../plugins/provider-fal-video/src/index.js';
import { readFileSync } from 'node:fs';

const liveVeniceKey = process.env.VENICE_INFERENCE_KEY?.trim();

/** Minimal MP4 (ftyp, a movie and one video track of `durationMs`, mdat padding) that passes the delivery and source checks. */
function mp4Video(durationMs: number, mediaBytes: number): Buffer {
  const box = (type: string, ...children: Buffer[]) => {
    const body = Buffer.concat(children);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const u32 = (...values: number[]) => Buffer.concat(values.map(value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }));
  // mvhd and mdhd: version/flags, times, timescale 1000, duration.
  const header = u32(0, 0, 0, 1000, durationMs);
  const trak = box('trak', box('mdia', box('mdhd', header), box('hdlr', u32(0, 0), Buffer.from('vide'), u32(0, 0, 0), Buffer.alloc(1)),
    box('minf', box('stbl', box('stts', u32(0, 1, 1, durationMs)), box('stsz', u32(0, 0, 1))))));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', header), trak), box('mdat', Buffer.alloc(mediaBytes, 9))]);
}

function largeVideoInputImage(): string {
  const chunk = (type: string, data: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(contents));
    return Buffer.concat([length, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512, 0);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = randomBytes(512 * (512 * 3 + 1));
  for (let row = 0; row < 512; row += 1) pixels[row * (512 * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenAI SDK integration: Images API payment flow over buyer proxy', () => {
  const network = usePaymentNetwork('images');
  const { setupRpc, setupProxyNetwork } = network;

  it.each([
    ['tcp-encrypted', true, 'text'], ['webrtc', true, 'image'], ['tcp-encrypted', false, 'image'], ['webrtc', false, 'text'],
  ] as const)('runs a Venice queue, streamed retrieve and complete over %s with content length %s and %s input and one charge', async (transport, hasContentLength, inputKind) => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const origin = 'https://api.venice.ai';
    const video = mp4Video(5_000, 3 * 1024 * 1024 + 17);
    const calls: Array<{ path: string; body: any }> = [];
    const createBody = JSON.stringify({ model: 'wan-2.5', prompt: 'boat', duration: '5s', ...(inputKind === 'image' ? { image_url: `data:image/png;base64,${largeVideoInputImage()}` } : {}) });
    if (inputKind === 'image') expect(Buffer.byteLength(createBody)).toBeGreaterThan(ANTSEED_UPLOAD_THRESHOLD_BYTES);
    let ready = false;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${origin}/`)) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer seller-secret');
      const path = new URL(url).pathname;
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString());
      calls.push({ path, body });
      if (path === '/api/v1/video/queue') {
        expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(createBody);
        return Response.json({ model: body.model, queue_id: 'queue-1' });
      }
      if (!ready) return Response.json({ status: 'PROCESSING', average_execution_time: 1000, execution_duration: 10 });
      return new Response(video, { headers: { 'content-type': 'video/mp4', ...(hasContentLength ? { 'content-length': String(video.length) } : {}) } });
    });
    try {
      const provider = await veniceVideoPlugin.createProvider({ VENICE_VIDEO_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'wan-2.5', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"wan-2.5":{"venice-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.01}]}}}' });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const manager = (network.buyerNode as any)._connectionManager;
      if (transport === 'webrtc') {
        const createConnection = manager.createConnection.bind(manager);
        manager.createConnection = (config: any) => createConnection({ ...config, remoteCapabilities: config.remoteCapabilities.filter((capability: string) => capability !== 'transport.tcp-enc.v1') });
      }
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const created = await fetch(`${base}/api/v1/video/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: createBody });
      expect(created.status).toBe(200);
      expect((await created.json()).queue_id).toBe('queue-1');
      expect(network.buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
      const pending = await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'queue-1' });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({ status: 'processing', upstream_status: 'PROCESSING' });
      ready = true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const download = await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'queue-1' });
        expect(download.status).toBe(200);
        expect(download.headers.get('content-type')).toBe('video/mp4');
        expect(Buffer.from(await download.arrayBuffer())).toEqual(video);
      }
      expect((await post('/api/v1/video/complete', { model: 'wan-2.5', queue_id: 'queue-1' })).status).toBe(404);
      expect((await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'unknown' })).status).toBe(404);
      expect((await post('/api/v1/video/retrieve', { model: 'wan-2.5' })).status).toBe(404);
      const callsBefore = calls.length;
      (network.sellerNode as any)._resourceOwnership.recordAcceptedCreate('venice-video', 'someone-elses', '11'.repeat(20));
      const denied = await network.buyerNode!.sendRequest(discoveredSeller, { requestId: 'non-owner', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json', 'x-antseed-service': 'wan-2.5', 'x-antseed-provider': 'venice-video', 'x-antseed-video-download': 'video-stream-v1' }, body: Buffer.from('{"queue_id":"someone-elses"}') }, { pinned: true });
      expect(denied.statusCode).toBe(404);
      expect(calls.length).toBe(callsBefore);
      expect(calls.filter(call => call.path === '/api/v1/video/queue')).toHaveLength(1);
      expect(manager.getConnection(discoveredSeller.peerId).transportDescription).toBe(transport);
      // The video is paid on its own one-off channel, never on the chat session channel.
      expect(network.buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
      await vi.waitFor(() => {
        const videoChannels = (network.buyerNode as any)._channelStore.listAllChannels(100, 'one_off');
        expect(videoChannels).toHaveLength(1);
        expect(videoChannels[0]).toMatchObject({ peerId: discoveredSeller.peerId, authMax: '50000', status: 'settled' });
      });
      await vi.waitFor(() => {
        const auths = (network.buyerNode as any)._verificationStorage.listResponseAuthsBySeller(discoveredSeller.peerId);
        expect(auths.filter((auth: any) => !auth.verified).map((auth: any) => auth.verificationError)).toEqual([]);
      });
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);

  it('runs a fal queue, status poll and streamed download through the buyer proxy with one charge', async () => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const model = 'fal-ai/kling-video/v2.1/standard/text-to-video';
    const video = mp4Video(5_000, 512 * 1024);
    const falCalls: string[] = [];
    let ready = false;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://v3.fal.media/files/out.mp4') {
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        falCalls.push('media');
        return new Response(video, { headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) } });
      }
      if (!url.startsWith('https://queue.fal.run/')) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Key seller-secret');
      const path = new URL(url).pathname;
      falCalls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === `/${model}`) {
        expect(JSON.parse(Buffer.from(init!.body as Uint8Array).toString())).toEqual({ prompt: 'boat', duration: '5' });
        return Response.json({ request_id: 'fal-req-1', status_url: 'https://queue.fal.run/x', queue_position: 0 });
      }
      if (path.endsWith('/status')) return Response.json({ status: ready ? 'COMPLETED' : 'IN_PROGRESS' }, { status: ready ? 200 : 202 });
      return Response.json({ video: { url: 'https://v3.fal.media/files/out.mp4' } });
    });
    try {
      const provider = await falVideoPlugin.createProvider({
        FAL_VIDEO_API_KEY: 'seller-secret',
        ANTSEED_ALLOWED_SERVICES: model,
        ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [model]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] } } }),
      });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const created = await post('/fal/v1/video/queue', { model, prompt: 'boat', duration: '5' });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ model, request_id: 'fal-req-1', status: 'IN_QUEUE' });
      const pending = await post('/fal/v1/video/retrieve', { model, request_id: 'fal-req-1' });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({ status: 'processing', upstream_status: 'IN_PROGRESS' });
      ready = true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const download = await post('/fal/v1/video/retrieve', { model, request_id: 'fal-req-1' });
        expect(download.status).toBe(200);
        expect(download.headers.get('content-type')).toBe('video/mp4');
        expect(Buffer.from(await download.arrayBuffer())).toEqual(video);
      }
      expect((await post('/fal/v1/video/retrieve', { model, request_id: 'unknown' })).status).toBe(404);
      expect(falCalls.filter(call => call === `POST /${model}`)).toHaveLength(1);
      expect(network.buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
      await vi.waitFor(() => {
        const videoChannels = (network.buyerNode as any)._channelStore.listAllChannels(100, 'one_off');
        expect(videoChannels).toHaveLength(1);
        expect(videoChannels[0]).toMatchObject({ peerId: discoveredSeller.peerId, authMax: '50000', status: 'settled' });
      });
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);

  it('runs a fal Recast edit from an inline source, paid once for the source length', async () => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const model = 'minimax/h3-max/recast';
    const schema = JSON.parse(readFileSync(new URL('../../plugins/provider-fal-video/src/fixtures/minimax_h3-max_recast.json', import.meta.url), 'utf8'));
    const sourceVideo = `data:video/mp4;base64,${mp4Video(12_700, 64 * 1024).toString('base64')}`;
    const output = mp4Video(12_700, 256 * 1024);
    const queued: any[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://fal.ai/api/openapi/')) return Response.json(schema);
      if (url.startsWith('https://api.fal.ai/')) return new Response(null, { status: 403 });
      if (url === 'https://v3.fal.media/files/out.mp4') return new Response(output, { headers: { 'content-type': 'video/mp4', 'content-length': String(output.length) } });
      if (url.startsWith('https://rest.fal.ai/storage/')) return Response.json({ upload_url: 'https://upload.fal.media/put', file_url: 'https://v3.fal.media/files/source.mp4' });
      if (url === 'https://upload.fal.media/put') return new Response(null, { status: 200 });
      if (!url.startsWith('https://queue.fal.run/')) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      const path = new URL(url).pathname;
      if (path === `/${model}`) {
        queued.push(JSON.parse(Buffer.from(init!.body as Uint8Array).toString()));
        return Response.json({ request_id: 'fal-edit-1' });
      }
      if (path.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ video: { url: 'https://v3.fal.media/files/out.mp4' } });
    });
    try {
      const provider = falVideoPlugin.createProvider({
        FAL_VIDEO_API_KEY: 'seller-secret',
        ANTSEED_ALLOWED_SERVICES: model,
        ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [model]: { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] } } }),
      }) as Provider;
      await provider.init!();
      expect(provider.serviceCapabilities?.[model]?.video).toMatchObject({ inputs: ['video', 'reference_image'], requiredInputs: ['video', 'reference_image'] });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const edit = { model, video_url: sourceVideo, reference_image_urls: ['https://example.com/me.png'], resolution: '768P' };

      const created = await post('/fal/v1/video/queue', { ...edit, duration: 12 });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ model, request_id: 'fal-edit-1' });
      // fal takes no duration for Recast, and gets the uploaded source's URL.
      expect(queued).toEqual([{ video_url: 'https://v3.fal.media/files/source.mp4', reference_image_urls: ['https://example.com/me.png'], resolution: '768P' }]);
      const download = await post('/fal/v1/video/retrieve', { model, request_id: 'fal-edit-1' });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(output);
      await vi.waitFor(() => {
        const videoChannels = (network.buyerNode as any)._channelStore.listAllChannels(100, 'one_off');
        expect(videoChannels).toHaveLength(1);
        expect(videoChannels[0]).toMatchObject({ peerId: discoveredSeller.peerId, authMax: '120000', status: 'settled' });
      });
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);

  it.each(['tcp-encrypted', 'webrtc'] as const)('runs a Venice Recast edit over %s with a large inline source', async (transport) => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const origin = 'https://api.venice.ai';
    const model = 'minimax-h3-max-recast';
    const source = mp4Video(10_400, 6 * 1024 * 1024);
    const output = mp4Video(10_400, 128 * 1024);
    const queued: string[] = [];
    let probes = 0;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${origin}/`)) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      const path = new URL(url).pathname;
      if (path === '/api/v1/models') {
        return Response.json({ data: [{ id: model, model_spec: { constraints: { model_type: 'video', aspect_ratios: [], resolutions: ['768P', '1080P'], durations: ['Auto'], audio_configurable: false, video_input: true } } }] });
      }
      const body = Buffer.from(init!.body as Uint8Array).toString();
      if (path === '/api/v1/video/queue' && JSON.parse(body).duration === '999s') {
        probes += 1;
        return Response.json({ error: 'Invalid request parameters', details: { _errors: [], duration: { _errors: ['too long'] }, reference_image_urls: { _errors: ['At least one reference is required for this model'] } } }, { status: 400 });
      }
      if (path === '/api/v1/video/queue') {
        queued.push(body);
        return Response.json({ model, queue_id: 'queue-edit-1' });
      }
      return new Response(output, { headers: { 'content-type': 'video/mp4', 'content-length': String(output.length) } });
    });
    try {
      const provider = veniceVideoPlugin.createProvider({
        VENICE_VIDEO_API_KEY: 'seller-secret',
        ANTSEED_ALLOWED_SERVICES: model,
        ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ [model]: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] } } }),
      }) as Provider;
      await provider.init!();
      expect(probes).toBe(1);
      expect(provider.serviceCapabilities?.[model]?.video).toMatchObject({ inputs: ['video', 'reference_image'], requiredInputs: ['video', 'reference_image'] });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const manager = (network.buyerNode as any)._connectionManager;
      if (transport === 'webrtc') {
        const createConnection = manager.createConnection.bind(manager);
        manager.createConnection = (config: any) => createConnection({ ...config, remoteCapabilities: config.remoteCapabilities.filter((capability: string) => capability !== 'transport.tcp-enc.v1') });
      }
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const edit = { model, video_url: `data:video/mp4;base64,${source.toString('base64')}`, reference_image_urls: ['https://example.com/me.png'], resolution: '768P' };

      const createBody = JSON.stringify({ ...edit, duration: '10s' });
      expect(Buffer.byteLength(createBody)).toBeGreaterThan(ANTSEED_UPLOAD_THRESHOLD_BYTES);
      const created = await post('/api/v1/video/queue', createBody);
      expect(created.status).toBe(200);
      expect((await created.json()).queue_id).toBe('queue-edit-1');
      // Venice wants the source length as the duration, so it is passed through as sent.
      expect(queued).toEqual([createBody]);
      const download = await post('/api/v1/video/retrieve', JSON.stringify({ model, queue_id: 'queue-edit-1' }));
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(output);
      expect(manager.getConnection(discoveredSeller.peerId).transportDescription).toBe(transport);
      await vi.waitFor(() => {
        const videoChannels = (network.buyerNode as any)._channelStore.listAllChannels(100, 'one_off');
        expect(videoChannels).toHaveLength(1);
        expect(videoChannels[0]).toMatchObject({ peerId: discoveredSeller.peerId, authMax: '100000', status: 'settled' });
      });
    } finally { vi.unstubAllGlobals(); }
  }, 120_000);

  it.skipIf(!liveVeniceKey)('runs a real Venice video request through the buyer proxy', async () => {
    await setupRpc();
    const model = 'wan-2.5-preview-text-to-video';
    const provider = await veniceVideoPlugin.createProvider({
      VENICE_VIDEO_API_KEY: liveVeniceKey!,
      ANTSEED_ALLOWED_SERVICES: model,
      ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({
        [model]: { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] } },
      }),
    });
    const { port, discoveredSeller } = await setupProxyNetwork(provider);
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      'content-type': 'application/json',
      'x-antseed-pin-peer': discoveredSeller.peerId,
    };
    const createBody = {
      model,
      prompt: 'A small sailboat crossing calm blue water at sunrise',
      duration: '5s',
      resolution: '720p',
      aspect_ratio: '16:9',
    };

    const created = await fetch(`${base}/api/v1/video/queue`, {
      method: 'POST', headers, body: JSON.stringify(createBody),
    });
    const accepted = await created.json() as { queue_id?: unknown; error?: unknown };
    expect(created.status, JSON.stringify(accepted)).toBe(200);
    expect(typeof accepted.queue_id).toBe('string');

    let download: Response | undefined;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const response = await fetch(`${base}/api/v1/video/retrieve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, queue_id: accepted.queue_id }),
      });
      if (response.headers.get('content-type')?.startsWith('video/mp4')) {
        download = response;
        break;
      }
      const status = await response.json() as { status?: unknown; upstream_status?: unknown; error?: unknown };
      expect(response.status, JSON.stringify(status)).toBe(200);
      expect(status).toMatchObject({ status: 'processing', upstream_status: 'PROCESSING' });
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }

    expect(download).toBeDefined();
    expect(download!.status).toBe(200);
    expect(download!.headers.get('content-type')).toBe('video/mp4');
    expect((await download!.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await vi.waitFor(() => expect(network.buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(50_000n));
  }, 240_000);

  it('negotiates payment and records image usage for images.generate', async () => {
    await setupRpc();
    const { provider, port, discoveredSeller } = await setupProxyNetwork();

    const paymentEvents: string[] = [];
    network.buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    network.buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: `http://127.0.0.1:${port}/v1`,
      defaultHeaders: { 'x-antseed-pin-peer': discoveredSeller.peerId },
    });

    const response = await client.images.generate({
      model: 'gpt-image-2',
      prompt: 'A tiny purple cube',
      size: '1024x1024',
      quality: 'low',
      n: 2,
    } as any);

    // The request should succeed through the buyer proxy and hit the image seller.
    expect(response.created).toBeTypeOf('number');
    expect(response.data?.[0]?.b64_json).toBe(Buffer.from('mock-image-bytes').toString('base64'));
    expect(response.data).toHaveLength(2);
    expect(provider.requestCount).toBe(1);
    expect(provider.lastRequest?.path).toBe('/v1/images/generations');

    // Discovery should carry the signed v12 billing model all the way into buyer peer info.
    expect(discoveredSeller.metadata?.version).toBe(12);
    const billingComponent = discoveredSeller
      .providerServiceUnitBillingModels?.openai?.services['gpt-image-2']?.['openai-images']?.components[0];
    expect(billingComponent).toMatchObject({
      unit: 'output_images',
      match: { size: '1024x1024' },
    });
    expect(billingComponent?.priceUsd).toBeCloseTo(0.04, 5);

    // The first paid request should negotiate automatically: 402 -> auth -> retry -> 200.
    expect(paymentEvents).toContain('required');
    expect(paymentEvents).toContain('signed');

    // Verify on-chain calls were attempted against the mocked RPC.
    const sendRawTxCalls = network.rpcCallLog.filter((call) => call.method === 'eth_sendRawTransaction');
    expect(sendRawTxCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the buyer recorded the exact image unit-billing cost. Legacy token pricing
    // and response token usage are both zero, so this fails if billing silently
    // falls back to token pricing or treats the image service as free.
    const bpm = network.buyerNode!.buyerPaymentManager;
    expect(bpm).not.toBeNull();
    expect(bpm!.getActiveSession(discoveredSeller.peerId)).not.toBeNull();
    expect(bpm!.getVerifiedCost(discoveredSeller.peerId)).toBe(80_000n);
    // Prompt estimate as input; 2 images x 1290-token equivalent as output.
    expect(bpm!.getCumulativeTokens(discoveredSeller.peerId)).toEqual({
      inputTokens: 4n,
      outputTokens: 2_580n,
    });
    expect(bpm!.getResponseTokenTotals(discoveredSeller.peerId)).toEqual({
      input: 0,
      output: 0,
      requests: 1,
    });
    expect(bpm!.getCumulativeAmount(discoveredSeller.peerId)).toBe(80_000n);
  }, 30_000);

  it('treats image services without explicit unit billing as free', async () => {
    await setupRpc();
    const { provider, port, discoveredSeller } = await setupProxyNetwork(
      new MockOpenAIImageProvider({ serviceUnitBillingModels: null }),
    );

    const paymentEvents: string[] = [];
    network.buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    network.buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: `http://127.0.0.1:${port}/v1`,
      defaultHeaders: { 'x-antseed-pin-peer': discoveredSeller.peerId },
    });

    const response = await client.images.generate({
      model: 'gpt-image-2',
      prompt: 'A tiny purple cube',
      size: '1024x1024',
      quality: 'low',
      n: 2,
    } as any);

    expect(response.data).toHaveLength(2);
    expect(provider.requestCount).toBe(1);
    expect(discoveredSeller.providerServiceUnitBillingModels).toBeUndefined();
    expect(paymentEvents).toEqual([]);
    expect(network.rpcCallLog.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
    expect(network.buyerNode!.buyerPaymentManager?.getActiveSession(discoveredSeller.peerId)).toBeNull();
    expect(network.buyerNode!.buyerPaymentManager?.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
  }, 30_000);

  it('pins a routing service as the model for a gateway key and attributes the rank and inference spend to it', async () => {
    await setupRpc();
    const rankBodies: any[] = [];
    const routing: Provider = {
      name: 'alpha',
      services: ['alpha-route'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { 'alpha-route': ['irp-suggest'] },
      serviceUnitBillingModels: { 'alpha-route': { 'irp-suggest': {
        version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
      } } },
      maxConcurrency: 5,
      getCapacity: () => ({ current: 0, max: 5 }),
      async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
        const json = (value: unknown) => ({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) });
        if (req.method === 'GET' && req.path === '/v1/routing/models') {
          return json({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model' }] });
        }
        const body = JSON.parse(Buffer.from(req.body).toString());
        rankBodies.push(body);
        return json({ id: 'rank-1', object: 'routing.ranking', created: 1, router: { id: 'alpha', version: '1' },
          ranked: [{ candidate_id: body.routing.candidates[0].id }] });
      },
    };
    const chatProvider = new MockOpenAIChatProvider();
    const { port, discoveredSeller } = await setupProxyNetwork(routing, [chatProvider]);
    const { SPEND_ATTRIBUTION_HEADER } = await import('../../apps/cli/src/proxy/spend-attribution.js');
    const base = `http://127.0.0.1:${port}`;

    const routers = await (await fetch(`${base}/v1/models?type=router`)).json() as any;
    expect(routers.data.map((entry: any) => entry.peers[0].model)).toEqual([`${discoveredSeller.peerId}@alpha-route`]);

    const chat = (body: Record<string, unknown>) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SPEND_ATTRIBUTION_HEADER]: 'gw_key1' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Summarise the contract.' }], ...body }),
    });
    const response = await chat({ model: `${discoveredSeller.peerId}@alpha-route`, routing: { cost_quality_tradeoff: 7 } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as any).choices[0].message.content).toBe('Hello from OpenAI mock!');
    expect(rankBodies).toHaveLength(1);
    expect(rankBodies[0].routing.cost_quality_tradeoff).toBe(7);
    expect(chatProvider.requestCount).toBe(1);
    expect(JSON.parse(Buffer.from(chatProvider.lastRequest!.body).toString())).not.toHaveProperty('routing');

    const offline = await chat({ model: `${'e'.repeat(40)}@alpha-route` });
    expect(offline.status).toBe(502);
    expect(await offline.text()).toContain('(seller or routing service) is not reachable right now');
    expect((await chat({ model: `${discoveredSeller.peerId}@alpha-route`, routing: { unknown: 1 } })).status).toBe(400);
    expect(rankBodies).toHaveLength(1);

    const bpm = network.buyerNode!.buyerPaymentManager!;
    await vi.waitFor(() => expect(bpm.getCumulativeAmount(discoveredSeller.peerId)).toBeGreaterThan(1_000n));
    const cumulative = bpm.getCumulativeAmount(discoveredSeller.peerId);
    await vi.waitFor(async () => {
      const page = await (await fetch(`${base}/_antseed/attributed-spend?after=0`)).json() as any;
      expect(page.events.every((event: any) => event.tag === 'gw_key1')).toBe(true);
      expect(page.events.reduce((sum: bigint, event: any) => sum + BigInt(event.amountUsdc), 0n)).toBe(cumulative);
    });
  }, 60_000);
});
