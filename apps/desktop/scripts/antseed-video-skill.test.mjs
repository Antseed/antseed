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
  incompatibilities,
  isTransientRetrieveError,
  MAX_TRANSIENT_FAILURES,
  MAX_TRANSIENT_FAILURES_AFTER_COMPLETED,
  VideoError,
  waitForVideo,
  isUnsafeIp,
  parseCliArgs,
  peerProtocol,
  priceEstimate,
  selectedPeer,
} from '../../../skills/antseed-videos/scripts/antseed_video.mjs';
import { MANUAL_MAP, SNAPSHOT, loadBoard, matchRanking, modelKey, rankingFor } from '../../../skills/antseed-videos/scripts/model_rankings.mjs';

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
    // Tests never reach the public leaderboard: rankings stay off unless a test points them at a fake.
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ANTSEED_MODEL_RANKINGS: 'off', ...env } });
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

test('incompatibilities rejects an aspect ratio the seller does not advertise', () => {
  const imageToVideo = { peerId: 'ii', protocols: ['venice-video'], capabilities: { video: { durationsSeconds: [4], inputs: ['first_frame'], requiredInputs: ['first_frame'] } } };
  assert.deepEqual(incompatibilities(imageToVideo, { duration: 4, aspectRatio: '16:9', firstFrame: 'start.png' }), ['aspect ratio']);
  assert.deepEqual(incompatibilities(imageToVideo, { duration: 4, firstFrame: 'start.png' }), []);
});

test('isTransientRetrieveError retries 429 and 5xx but not client errors', () => {
  for (const status of [429, 502, 503, 504]) assert.equal(isTransientRetrieveError(new VideoError('x', 'video_download_failed', { status })), true, String(status));
  for (const status of [400, 401, 402, 403, 404, 410, 413, 422]) assert.equal(isTransientRetrieveError(new VideoError('x', 'http', { status })), false, String(status));
  assert.equal(isTransientRetrieveError(new VideoError('x', 'proxy_unreachable')), true);
  assert.equal(isTransientRetrieveError(new VideoError('x', 'invalid_video')), false);
  assert.equal(isTransientRetrieveError(new Error('x')), false);
});

const scripted = (steps) => {
  let calls = 0;
  const retrieve = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { retrieve, calls: () => calls };
};
const transient = (extra = {}) => new VideoError('Video download unavailable', 'video_download_failed', { status: 502, ...extra });
const fast = { delays: [0] };

test('waitForVideo rides out temporary errors during rendering', async () => {
  const run = scripted([{ state: 'processing' }, transient(), transient(), { state: 'processing' }, transient(), { state: 'done', bytes: 7 }]);
  const result = await waitForVideo('http://x', 'm', 'job', 'out.mp4', null, 0, 30, { ...fast, retrieve: run.retrieve });
  assert.deepEqual(result, { state: 'done', bytes: 7 });
  assert.equal(run.calls(), 6);
});

test('waitForVideo gives up after consecutive temporary errors with a resumable job', async () => {
  const run = scripted([transient()]);
  await assert.rejects(waitForVideo('http://x', 'm', 'job-7', 'out.mp4', null, 0, 30, { ...fast, retrieve: run.retrieve }), (error) => {
    assert.equal(error.code, 'video_retrieve_unavailable');
    assert.deepEqual(error.details, { jobId: 'job-7', lastStatus: 502, lastCode: 'video_download_failed', attempts: MAX_TRANSIENT_FAILURES, resumable: true });
    return true;
  });
  assert.equal(run.calls(), MAX_TRANSIENT_FAILURES);
});

test('waitForVideo stops immediately on lasting errors', async () => {
  for (const status of [401, 404]) {
    const run = scripted([new VideoError('nope', 'video_route_not_found', { status })]);
    await assert.rejects(waitForVideo('http://x', 'm', 'job', 'out.mp4', null, 0, 30, { ...fast, retrieve: run.retrieve }), { code: 'video_route_not_found' });
    assert.equal(run.calls(), 1);
  }
});

test('waitForVideo allows fewer retries once rendering completed', async () => {
  const run = scripted([new VideoError('Video download failed.', 'download_failed', { status: 503, completed: true })]);
  await assert.rejects(waitForVideo('http://x', 'm', 'job', 'out.mp4', 'https://cdn', 0, 30, { ...fast, retrieve: run.retrieve }), { code: 'video_retrieve_unavailable' });
  assert.equal(run.calls(), MAX_TRANSIENT_FAILURES_AFTER_COMPLETED);
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

test('CLI models summarizes advertised options so the agent can offer them up front', async () => {
  await withProxy(catalogHandler(() => ({ status: 404 })), async (base) => {
    const { code, json } = await cli(['models'], { ANTSEED_PROXY_URL: base });
    assert.equal(code, 0);
    assert.deepEqual(json.models[0].video, { durationsSeconds: [5, 10], inputs: ['first_frame'], resolutions: ['1080p', '720p'] });
  });
});

test('CLI image-models lists image models for generating start and end frames', async () => {
  await withProxy((request) => {
    if (request.url === '/v1/models?type=images') return { body: { data: [{ id: 'flux-2', name: 'Flux 2', aliases: [], peers: [{}, {}] }] } };
    return { status: 404 };
  }, async (base) => {
    const { code, json } = await cli(['image-models'], { ANTSEED_PROXY_URL: base });
    assert.equal(code, 0);
    assert.deepEqual(json.models, [{ aliases: [], arenaName: null, id: 'flux-2', match: null, name: 'Flux 2', priceUsd: null, rank: null, rating: null, sellers: 2, tier: 'unranked' }]);
    assert.equal(json.recommended, null);
    assert.equal(json.ranking.source, 'off');
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
      assert.deepEqual(json, { ok: true, output, bytes: MP4.length, model: 'seedance', protocol: 'venice-video', peerId: 'bb', jobId: 'job-1' });
      assert.deepEqual(await readFile(output), MP4);
      const creates = requests.filter((request) => request.url === '/api/v1/video/queue');
      assert.equal(creates.length, 1);
      assert.deepEqual(creates[0].body, { model: 'bb@seedance', prompt: 'ants', duration: '10s' });
      const retrieve = requests.find((request) => request.url === '/api/v1/video/retrieve');
      assert.deepEqual(retrieve.body, { model: 'seedance', queue_id: 'job-1', delete_media_on_completion: false });
    });
  });
});

test('CLI generate retries a seller 502 during polling without a second create', async () => {
  await withTempDir(async (dir) => {
    let polls = 0;
    const handler = catalogHandler((request) => {
      if (request.url === '/api/v1/video/queue') return { body: { queue_id: 'job-2' }, headers: { 'x-antseed-seller-peer': 'bb' } };
      if (request.url === '/api/v1/video/retrieve') {
        polls += 1;
        if (polls === 1) return { body: { status: 'PROCESSING' } };
        if (polls === 2) return { status: 502, body: { error: { code: 'video_download_failed', message: 'Video download unavailable' } } };
        return { type: 'video/mp4', body: MP4 };
      }
      return { status: 404 };
    });
    await withProxy(handler, async (base, requests) => {
      const output = path.join(dir, 'video.mp4');
      const { code, json } = await cli(['--proxy-url', base, 'generate', '--model', 'seedance', '--peer', 'bb', '--prompt', 'ants', '--duration', '10', '--poll-interval', '0', '--output', output]);
      assert.equal(code, 0, JSON.stringify(json));
      assert.equal(json.jobId, 'job-2');
      assert.equal(requests.filter((request) => request.url === '/api/v1/video/queue').length, 1);
      assert.equal(polls, 3);
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

test('CLI batch creates segments one by one and renders accepted jobs in parallel', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'k0.png'), PNG);
    await writeFile(path.join(dir, 'k1.png'), PNG);
    await writeFile(path.join(dir, 'k2.png'), PNG);
    await writeFile(path.join(dir, 'segments.json'), JSON.stringify({
      segments: [
        { prompt: 'one', firstFrame: 'k0.png', output: 'seg1.mp4' },
        { prompt: 'two', firstFrame: 'k1.png', output: 'seg2.mp4' },
      ],
    }));
    let creates = 0;
    const handler = catalogHandler((request) => {
      if (request.url === '/api/v1/video/queue') {
        creates += 1;
        return { body: { queue_id: `job-${creates}` }, headers: { 'x-antseed-seller-peer': 'bb' } };
      }
      if (request.url === '/api/v1/video/retrieve') {
        if (request.body.queue_id === 'job-1' && creates < 2) return { body: { status: 'PROCESSING' } };
        return { type: 'video/mp4', body: MP4 };
      }
      return { status: 404 };
    });
    await withProxy(handler, async (base, requests) => {
      const { code, json } = await cli(['--proxy-url', base, 'batch', '--model', 'seedance', '--peer', 'bb', '--duration', '10', '--poll-interval', '0', '--plan', path.join(dir, 'segments.json')]);
      assert.equal(code, 0, JSON.stringify(json));
      assert.equal(json.created, 2);
      assert.equal(json.saved, 2);
      assert.deepEqual(json.results.map((result) => result.jobId), ['job-1', 'job-2']);
      const urls = requests.map((request) => request.url).filter((url) => url.startsWith('/api/v1/video/'));
      assert.ok(urls.indexOf('/api/v1/video/retrieve') < urls.lastIndexOf('/api/v1/video/queue'));
      assert.deepEqual(await readFile(path.join(dir, 'seg1.mp4')), MP4);
      assert.deepEqual(await readFile(path.join(dir, 'seg2.mp4')), MP4);
    });
  });
});

test('CLI batch stops creating after a create failure but keeps accepted jobs', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'segments.json'), JSON.stringify([
      { prompt: 'one', output: 'seg1.mp4' },
      { prompt: 'two', output: 'seg2.mp4' },
      { prompt: 'three', output: 'seg3.mp4' },
    ]));
    let creates = 0;
    const handler = catalogHandler((request) => {
      if (request.url === '/api/v1/video/queue') {
        creates += 1;
        return creates === 1 ? { body: { queue_id: 'job-1' } } : { status: 409, body: { error: { code: 'video_create_in_progress', message: 'busy' } } };
      }
      if (request.url === '/api/v1/video/retrieve') return { type: 'video/mp4', body: MP4 };
      return { status: 404 };
    });
    await withProxy(handler, async (base) => {
      const { code, json } = await cli(['--proxy-url', base, 'batch', '--model', 'seedance', '--peer', 'bb', '--duration', '10', '--poll-interval', '0', '--plan', path.join(dir, 'segments.json')]);
      assert.equal(code, 1);
      assert.equal(creates, 2);
      assert.deepEqual(json.results.map((result) => result.state), ['saved', 'create_failed', 'not_created']);
      assert.equal(json.results[1].error.code, 'video_create_in_progress');
      assert.deepEqual(await readFile(path.join(dir, 'seg1.mp4')), MP4);
    });
  });
});

const BOARD_ROWS = {
  text_to_image: [
    { model_name: 'gpt-image-2.5-sunburst', rating: 1425.4, vote_count: 100, category: 'overall', leaderboard_publish_date: '2026-10-07' },
    { model_name: 'gemini-3.1-flash-image (nano-banana-2) [web-search]', rating: 1262, vote_count: 90, category: 'overall', leaderboard_publish_date: '2026-10-07' },
    { model_name: 'gpt-image-2.5-sunburst', rating: 1300, vote_count: 5, category: '3d_modeling', leaderboard_publish_date: '2026-10-07' },
    { model_name: 'qwen-image', rating: 1057, vote_count: 80, category: 'overall', leaderboard_publish_date: '2026-10-07' },
  ],
  image_to_video: [
    { model_name: 'minimax-h3', rating: 1495, vote_count: 10, category: 'overall', leaderboard_publish_date: '2026-09-22' },
    { model_name: 'dreamina-seedance-2.0-720p', rating: 1475, vote_count: 10, category: 'overall', leaderboard_publish_date: '2026-09-22' },
  ],
  text_to_video: [
    { model_name: 'gemini-omni-1.1-flash', rating: 1516, vote_count: 10, category: 'overall', leaderboard_publish_date: '2026-09-22' },
  ],
};

function fakeLeaderboard(board) {
  return { ok: true, status: 200, json: async () => ({ rows: (BOARD_ROWS[board] ?? []).map((row) => ({ row })) }) };
}

test('modelKey lines up network ids with leaderboard names', () => {
  assert.equal(modelKey('gpt-image-2-5-sunburst'), modelKey('gpt-image-2.5-sunburst'));
  assert.equal(modelKey('wan-3-0-image-to-video'), modelKey('wan3.0'));
  assert.equal(modelKey('flux-3-image-to-video'), modelKey('flux-3-video-20260811'));
  assert.notEqual(modelKey('seedance-2-0'), modelKey('seedance-2-5'));
});

test('matchRanking uses aliases, exact keys, and family prefixes without crossing versions', () => {
  const entries = [
    { name: 'gemini-3.1-flash-image (nano-banana-2) [web-search]', rating: 1262, rank: 1 },
    { name: 'dreamina-seedance-2.0-720p', rating: 1475, rank: 2 },
    { name: 'gpt-image-2 (medium)', rating: 1383, rank: 3 },
  ];
  assert.equal(matchRanking(['nano-banana-2'], entries)?.rank, 1);
  assert.deepEqual([matchRanking(['seedance-2-0-image-to-video-basic'], entries)?.rank, matchRanking(['seedance-2-0-image-to-video-basic'], entries)?.match], [2, 'exact']);
  assert.equal(matchRanking(['seedance-2-0-fast-image-to-video-basic'], entries)?.match, 'family');
  assert.equal(matchRanking(['seedance-2-5-image-to-video-basic'], entries), null);
  assert.equal(matchRanking(['gpt-image-2'], entries)?.rank, 3);
  assert.equal(matchRanking(['gpt-image-2-5-flare'], entries), null);
  assert.deepEqual(rankingFor(null, { board: 'text_to_image' }), { arenaName: null, match: null, rank: null, rating: null, tier: 'unranked' });
});

test('loadBoard fetches overall ratings, caches them for a day, and falls back to the cache and snapshot', async () => {
  await withTempDir(async (dir) => {
    const env = { ANTSEED_MODEL_RANKINGS_CACHE: path.join(dir, 'rankings.json') };
    let calls = 0;
    const fetchImpl = async (url) => { calls += 1; return fakeLeaderboard(new URL(url).searchParams.get('config')); };
    const live = await loadBoard('text_to_image', { fetchImpl, env, now: 1000 });
    assert.equal(live.source, 'live');
    assert.equal(live.publishedAt, '2026-10-07');
    assert.deepEqual(live.entries.map((entry) => [entry.rank, entry.name, entry.rating]), [
      [1, 'gpt-image-2.5-sunburst', 1425],
      [2, 'gemini-3.1-flash-image (nano-banana-2) [web-search]', 1262],
      [3, 'qwen-image', 1057],
    ]);
    assert.equal((await loadBoard('text_to_image', { fetchImpl, env, now: 2000 })).source, 'cache');
    assert.equal(calls, 1);
    const failing = async () => { throw new Error('offline'); };
    const stale = await loadBoard('text_to_image', { fetchImpl: failing, env, now: 1000 + 2 * 24 * 60 * 60 * 1000 });
    assert.deepEqual([stale.source, stale.stale, stale.entries.length], ['cache', true, 3]);
    const snapshot = await loadBoard('image_to_video', { fetchImpl: failing, env, now: 1000 });
    assert.equal(snapshot.source, 'snapshot');
    assert.ok(snapshot.entries.length > 0);
    assert.equal((await loadBoard('text_to_image', { fetchImpl, env: { ...env, ANTSEED_MODEL_RANKINGS: 'off' } })).entries.length, 0);
  });
});

test('CLI image-models ranks network image models by leaderboard rating and recommends the best', async () => {
  await withTempDir(async (dir) => {
    await withProxy((request) => {
      if (request.url === '/v1/models?type=images') {
        return { body: { data: [
          { id: 'chroma', peers: [{ minImageUsdPerImage: 0.004 }] },
          { id: 'qwen-image', peers: [{ minImageUsdPerImage: 0.01 }] },
          { id: 'gpt-image-2-5-sunburst', peers: [{ minImageUsdPerImage: 0.05 }, { minImageUsdPerImage: 0.035 }] },
          { id: 'nano-banana-2', peers: [{ minImageUsdPerImage: 0.05 }] },
        ] } };
      }
      const leaderboard = request.url.match(/^\/rankings\?config=(\w+)$/);
      if (leaderboard) return { body: { rows: (BOARD_ROWS[leaderboard[1]] ?? []).map((row) => ({ row })) } };
      return { status: 404 };
    }, async (base) => {
      const { code, json } = await cli(['image-models'], {
        ANTSEED_PROXY_URL: base,
        ANTSEED_MODEL_RANKINGS: 'on',
        ANTSEED_MODEL_RANKINGS_URL: `${base}/rankings?config=`,
        ANTSEED_MODEL_RANKINGS_CACHE: path.join(dir, 'rankings.json'),
      });
      assert.equal(code, 0);
      assert.equal(json.recommended, 'gpt-image-2-5-sunburst');
      assert.deepEqual(json.models.map((model) => [model.id, model.rank, model.tier, model.priceUsd]), [
        ['gpt-image-2-5-sunburst', 1, 'top', 0.035],
        ['nano-banana-2', 2, 'top', 0.05],
        ['qwen-image', 3, 'top', 0.01],
        ['chroma', null, 'unranked', 0.004],
      ]);
      assert.equal(json.ranking.source, 'live');
      assert.match(json.ranking.attribution, /LMArena/);
    });
  });
});

test('CLI models recommends the best-ranked video model that takes frames', async () => {
  await withTempDir(async (dir) => {
    const textOnly = { ...peer(), capabilities: { video: { durationsSeconds: [5] } } };
    await withProxy((request) => {
      if (request.url === '/v1/models?type=videos') {
        return { body: { data: [
          { id: 'gemini-omni-flash-1-1-text-to-video', peers: [textOnly] },
          { id: 'seedance-2-0-image-to-video-basic', peers: [peer()] },
          { id: 'minimax-h3-image-to-video', peers: [peer()] },
        ] } };
      }
      const leaderboard = request.url.match(/^\/rankings\?config=(\w+)$/);
      if (leaderboard) return { body: { rows: (BOARD_ROWS[leaderboard[1]] ?? []).map((row) => ({ row })) } };
      return { status: 404 };
    }, async (base) => {
      const { code, json } = await cli(['models'], {
        ANTSEED_PROXY_URL: base,
        ANTSEED_MODEL_RANKINGS: 'on',
        ANTSEED_MODEL_RANKINGS_URL: `${base}/rankings?config=`,
        ANTSEED_MODEL_RANKINGS_CACHE: path.join(dir, 'rankings.json'),
      });
      assert.equal(code, 0);
      assert.equal(json.recommended, 'minimax-h3-image-to-video');
      assert.deepEqual(json.models.map((model) => [model.id, model.rankedOn, model.rank, model.takesFrames]), [
        ['minimax-h3-image-to-video', 'image_to_video', 1, true],
        ['seedance-2-0-image-to-video-basic', 'image_to_video', 2, true],
        ['gemini-omni-flash-1-1-text-to-video', 'text_to_video', 1, false],
      ]);
    });
  });
});

const falPeer = (overrides = {}) => peer({
  peerId: 'ff',
  serviceId: 'fal-ai/kling-video/v3/pro/image-to-video',
  protocols: ['fal-video'],
  unitBillingModels: { 'fal-video': { components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } },
  ...overrides,
});

test('fal sellers use the fal protocol, a plain-number duration, and fal pricing', async () => {
  assert.equal(peerProtocol(falPeer()), 'fal-video');
  assert.equal(peerProtocol(peer({ protocols: ['openai-chat'] })), null);
  assert.equal(priceEstimate(falPeer(), 10, '1080p'), 1);
  const body = await createBody(falPeer(), { prompt: 'waves', duration: 5, audio: null });
  assert.deepEqual(body, { duration: '5', model: 'ff@fal-ai/kling-video/v3/pro/image-to-video', prompt: 'waves' });
  await assert.rejects(createBody(falPeer(), { prompt: 'waves', autoDuration: true }), { code: 'invalid_duration' });
});

test('sellers priced above the buyer video cap are incompatible', () => {
  const pricey = falPeer({ unitBillingModels: { 'fal-video': { components: [{ unit: 'video_seconds', priceUsd: 0.6 }] } } });
  assert.deepEqual(incompatibilities(pricey, { duration: 10 }), ['price above $5.00']);
  assert.deepEqual(incompatibilities(pricey, { duration: 5 }), []);
});

test('CLI generate queues and retrieves fal jobs on the fal routes', async () => {
  await withTempDir(async (dir) => {
    const fal = falPeer({ capabilities: { video: { durationsSeconds: [5] } } });
    const model = { id: 'fal-ai/kling-video/v3/pro/image-to-video', peers: [fal] };
    await withProxy((request) => {
      if (request.url === '/v1/models?type=videos') return { body: { data: [{ id: model.id, peers: [fal] }] } };
      if (request.url === `/v1/models/${encodeURIComponent(model.id)}`) return { body: model };
      if (request.url === '/fal/v1/video/queue') return { body: { request_id: 'req-1', status: 'IN_QUEUE' } };
      if (request.url === '/fal/v1/video/retrieve') return { body: MP4, type: 'video/mp4' };
      return { status: 404 };
    }, async (base, requests) => {
      const output = path.join(dir, 'fal.mp4');
      const { code, json } = await cli(['generate', '--model', model.id, '--peer', 'ff', '--prompt', 'waves', '--duration', '5', '--output', output, '--poll-interval', '0'], { ANTSEED_PROXY_URL: base });
      assert.equal(code, 0, JSON.stringify(json));
      assert.deepEqual([json.protocol, json.jobId], ['fal-video', 'req-1']);
      const queue = requests.find((item) => item.url === '/fal/v1/video/queue');
      assert.deepEqual(queue.body, { duration: '5', model: `ff@${model.id}`, prompt: 'waves' });
      const retrieve = requests.find((item) => item.url === '/fal/v1/video/retrieve');
      assert.deepEqual(retrieve.body, { model: model.id, request_id: 'req-1' });
    });
  });
});

test('every hand-mapped model resolves against the offline snapshot', () => {
  const names = new Set(['text_to_image', 'image_to_video', 'text_to_video'].flatMap((board) => SNAPSHOT[board].map(([name]) => name)));
  const missing = Object.entries(MANUAL_MAP).filter(([, mapped]) => mapped && !names.has(mapped.name)).map(([id]) => id);
  assert.deepEqual(missing, []);
});

test('matchRanking never guesses for models checked as unranked', () => {
  const entries = SNAPSHOT.image_to_video.map(([name, rating], index) => ({ name, rating, rank: index + 1 }));
  for (const [id, mapped] of Object.entries(MANUAL_MAP)) {
    if (mapped === null) assert.equal(matchRanking([id], entries), null, id);
  }
});
