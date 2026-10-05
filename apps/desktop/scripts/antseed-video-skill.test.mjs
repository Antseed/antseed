import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertSafeHttps,
  createBody,
  isUnsafeIp,
  parseCliArgs,
  priceEstimate,
  selectedPeer,
} from '../../../skills/antseed-videos/scripts/antseed_video.mjs';

const SCRIPT = fileURLToPath(new URL('../../../skills/antseed-videos/scripts/antseed_video.mjs', import.meta.url));
const run = promisify(execFile);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

const peer = (overrides = {}) => ({
  peerId: 'aa',
  serviceId: 'seedance',
  protocols: ['venice-video'],
  reputationScore: 50,
  capabilities: { video: { durationsSeconds: [5, 10], resolutions: ['720p', '1080p'], inputs: ['first_frame'] } },
  unitBillingModels: {
    'venice-video': {
      components: [
        { unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '1080p' } },
        { unit: 'video_seconds', priceUsd: 0.05, match: { resolution: '720p' } },
        { unit: 'video_generations', priceUsd: 0.2 },
      ],
    },
  },
  ...overrides,
});

const MODEL = {
  id: 'seedance',
  peers: [
    peer(),
    peer({ peerId: 'bb', reputationScore: 90 }),
    peer({ peerId: 'cc', reputationScore: 99, protocols: ['openai-chat'] }),
    peer({ peerId: 'dd', reputationScore: 95, capabilities: { video: { durationsSeconds: [5] } } }),
  ],
};

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-video-skill-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withProxy(handler, fn) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(entry);
    const reply = handler(entry, requests);
    res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'application/json', ...(reply.headers ?? {}) });
    res.end(Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function cli(args, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, json: JSON.parse(error.stdout) };
  }
}

function catalogHandler(extra) {
  return (request, requests) => {
    if (request.url === '/v1/models?type=videos') return { body: { data: [{ id: 'seedance', aliases: ['Seedance-Pro'], peers: MODEL.peers }] } };
    if (request.url === '/v1/models/seedance') return { body: MODEL };
    return extra(request, requests);
  };
}

test('priceEstimate matches resolution-specific per-second and flat components', () => {
  assert.equal(priceEstimate(peer(), 10, '1080p'), 1.2);
  assert.equal(priceEstimate(peer(), 5, '720p'), 0.45);
  assert.equal(priceEstimate(peer(), null, '720p'), null);
  assert.equal(priceEstimate({ peerId: 'x' }, 5, '720p'), null);
});

test('selectedPeer filters incompatible sellers and ranks by reputation then price', () => {
  assert.equal(selectedPeer(MODEL, { duration: 10, prefer: 'reputation' }).peerId, 'bb');
  assert.equal(selectedPeer(MODEL, { duration: 5, prefer: 'reputation' }).peerId, 'dd');
  assert.equal(selectedPeer(MODEL, { duration: 10, prefer: 'reputation', peer: '0xAA' }).peerId, 'aa');
  assert.throws(
    () => selectedPeer(MODEL, { duration: 10, lastFrame: 'end.png', prefer: 'reputation' }),
    (error) => error.code === 'no_compatible_video_offer' && error.details.alternatives.inputs.includes('first_frame'),
  );
  assert.throws(() => selectedPeer(MODEL, { audio: true, prefer: 'reputation' }), { code: 'no_compatible_video_offer' });
});

test('createBody pins the seller and inlines frames as data URLs', async () => {
  await withTempDir(async (dir) => {
    const frame = path.join(dir, 'start.png');
    await writeFile(frame, PNG);
    const body = await createBody(peer(), { modelId: 'seedance', prompt: '  an ant surfing  ', duration: 5, resolution: '720p', audio: null, firstFrame: frame });
    assert.deepEqual(Object.keys(body).sort(), ['duration', 'image_url', 'model', 'prompt', 'resolution']);
    assert.equal(body.model, 'aa@seedance');
    assert.equal(body.prompt, 'an ant surfing');
    assert.equal(body.duration, '5s');
    assert.match(body.image_url, /^data:image\/png;base64,/);

    await writeFile(frame, 'not an image');
    await assert.rejects(createBody(peer(), { prompt: 'x', firstFrame: frame }), { code: 'invalid_frame' });
  });
});

test('download URLs must be public HTTPS hosts', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isUnsafeIp(address), true, address);
  }
  assert.equal(isUnsafeIp('8.8.8.8'), false);
  assert.equal(isUnsafeIp('2606:4700::1111'), false);
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateDns = async () => [{ address: '10.0.0.5', family: 4 }];
  await assertSafeHttps('https://cdn.example.com/v.mp4', publicDns);
  await assert.rejects(assertSafeHttps('http://cdn.example.com/v.mp4', publicDns), { code: 'unsafe_download_url' });
  await assert.rejects(assertSafeHttps('https://cdn.example.com/v.mp4', privateDns), { code: 'unsafe_download_url' });
  await assert.rejects(assertSafeHttps('https://user:pw@cdn.example.com/v.mp4', publicDns), { code: 'unsafe_download_url' });
  await assert.rejects(assertSafeHttps('https://[::1]/v.mp4', publicDns), { code: 'unsafe_download_url' });
});

test('parseCliArgs validates flags and reads ANTSEED_PROXY_URL', () => {
  const args = parseCliArgs(['generate', '--model', 'm', '--peer', 'p', '--prompt', 'x', '--no-audio', '--duration', '5'], { ANTSEED_PROXY_URL: 'http://127.0.0.1:9999' });
  assert.equal(args.proxyUrl, 'http://127.0.0.1:9999');
  assert.equal(args.audio, false);
  assert.equal(args.duration, 5);
  assert.equal(args.pollInterval, 5);
  assert.equal(args.output, 'generated-video.mp4');
  assert.throws(() => parseCliArgs(['generate', '--model', 'm', '--peer', 'p']), { code: 'invalid_arguments' });
  assert.throws(() => parseCliArgs(['select', '--model', 'm', '--duration', '5', '--auto-duration']), { code: 'invalid_duration' });
  assert.throws(() => parseCliArgs(['select', '--model', 'm', '--audio', '--no-audio']), { code: 'invalid_arguments' });
  assert.throws(() => parseCliArgs(['select', '--model', 'm', '--bogus']), /bogus/);
});

test('CLI select resolves aliases and returns the confirmed seller with a price', async () => {
  await withProxy(catalogHandler(() => ({ status: 404 })), async (base, requests) => {
    const { code, json } = await cli(['select', '--model', 'seedance-pro', '--duration', '10', '--resolution', '1080p'], { ANTSEED_PROXY_URL: base });
    assert.equal(code, 0);
    assert.equal(json.selected.peerId, 'bb');
    assert.equal(json.selected.estimatedPriceUsd, 1.2);
    assert.deepEqual(json.compatible.map((item) => item.peerId), ['bb', 'aa']);
    assert.ok(requests.every((request) => request.headers.authorization === 'Bearer antseed-desktop'));
    assert.ok(requests.every((request) => request.method === 'GET'));
  });
});

test('CLI generate creates exactly one pinned job, polls, and saves the MP4', async () => {
  await withTempDir(async (dir) => {
    let polls = 0;
    const handler = catalogHandler((request) => {
      if (request.url === '/api/v1/video/queue') return { body: { queue_id: 'job-1' }, headers: { 'x-antseed-seller-peer': 'bb' } };
      if (request.url === '/api/v1/video/retrieve') {
        polls += 1;
        return polls < 2 ? { body: { status: 'PROCESSING' } } : { type: 'video/mp4', body: MP4 };
      }
      return { status: 404 };
    });
    await withProxy(handler, async (base, requests) => {
      const output = path.join(dir, 'out', 'video.mp4');
      const { code, json } = await cli(['--proxy-url', base, 'generate', '--model', 'seedance', '--peer', 'bb', '--prompt', 'ants', '--duration', '10', '--poll-interval', '0', '--output', output]);
      assert.equal(code, 0, JSON.stringify(json));
      assert.deepEqual(json, { ok: true, output, bytes: MP4.length, model: 'seedance', peerId: 'bb', jobId: 'job-1' });
      assert.deepEqual(await readFile(output), MP4);
      const creates = requests.filter((request) => request.url === '/api/v1/video/queue');
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0].body, { model: 'bb@seedance', prompt: 'ants', duration: '10s' });
      const retrieve = requests.find((request) => request.url === '/api/v1/video/retrieve');
      assert.deepEqual(retrieve.body, { model: 'seedance', queue_id: 'job-1', delete_media_on_completion: false });
    });
  });
});

test('CLI generate reports create failures without retrying and rejects non-MP4 media', async () => {
  await withTempDir(async (dir) => {
    await withProxy(catalogHandler((request) => {
      if (request.url === '/api/v1/video/queue') return { status: 409, body: { error: { code: 'video_create_in_progress', message: 'busy' } } };
      return { status: 404 };
    }), async (base, requests) => {
      const { code, json } = await cli(['--proxy-url', base, 'generate', '--model', 'seedance', '--peer', 'bb', '--prompt', 'x', '--output', path.join(dir, 'a.mp4')]);
      assert.equal(code, 1);
      assert.deepEqual(json.error, { code: 'video_create_in_progress', message: 'busy', status: 409, peerId: 'bb' });
      assert.equal(requests.filter((request) => request.url === '/api/v1/video/queue').length, 1);
    });

    await withProxy(() => ({ type: 'video/mp4', body: Buffer.from('<html>nope</html>') }), async (base, requests) => {
      const output = path.join(dir, 'b.mp4');
      const { code, json } = await cli(['--proxy-url', base, 'download', '--model', 'seedance', '--job-id', 'job-9', '--output', output]);
      assert.equal(code, 1);
      assert.equal(json.error.code, 'invalid_video');
      await assert.rejects(readFile(output), { code: 'ENOENT' });
      assert.ok(requests.every((request) => request.url === '/api/v1/video/retrieve'));
    });
  });
});
