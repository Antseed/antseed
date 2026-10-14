import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { ANTSEED_UPLOAD_THRESHOLD_BYTES } from '../../packages/protocol/src/http.js';
import { MockOpenAIImageProvider } from './helpers/mock-openai-provider.js';
import { usePaymentNetwork } from './helpers/payment-network.js';
import veniceVideoPlugin from '../../plugins/provider-venice-video/src/index.js';
import falVideoPlugin from '../../plugins/provider-fal-video/src/index.js';

const liveVeniceKey = process.env.VENICE_INFERENCE_KEY?.trim();

/** Minimal MP4 (ftyp, mvhd duration, mdat padding) that passes the delivery check. */
function mp4Video(durationMs: number, mediaBytes: number): Buffer {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(durationMs, 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(mediaBytes, 9))]);
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
      expect((await pending.json()).status).toBe('PROCESSING');
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
      expect((await pending.json()).status).toBe('IN_PROGRESS');
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
      const status = await response.json() as { status?: unknown; error?: unknown };
      expect(response.status, JSON.stringify(status)).toBe(200);
      expect(status.status).toBe('PROCESSING');
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
});
