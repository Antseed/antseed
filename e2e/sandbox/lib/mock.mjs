import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeProfile, normalizeProfile, planResponse, reportedUsage, requestTokens } from './profiles.mjs';
import { createRng, deriveSeed } from './random.mjs';

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pixel.png');
export const MOCK_USAGE = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 };
const MAX_RECORDED_REQUESTS = 50_000;

export const realClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  }),
};

/** Concurrency slots with a FIFO wait queue; 0 slots means unlimited. */
export function createSlots(clock = realClock) {
  const waiting = [];
  const pending = () => waiting.filter((entry) => !entry.cancelled).length;
  const slots = {
    limit: 0,
    active: 0,
    busyMs: 0,
    peakQueue: 0,
    startedAt: clock.now(),
    get queued() { return pending(); },
    setLimit(limit) { slots.limit = limit; grant(); },
    acquire(signal) {
      if (slots.limit === 0 || (slots.active < slots.limit && pending() === 0)) {
        slots.active += 1;
        return Promise.resolve(clock.now());
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve, cancelled: false };
        waiting.push(entry);
        slots.peakQueue = Math.max(slots.peakQueue, pending());
        signal?.addEventListener('abort', () => {
          if (!entry.cancelled && waiting.includes(entry)) {
            entry.cancelled = true;
            waiting.splice(waiting.indexOf(entry), 1);
            reject(new Error('aborted while queued'));
          }
        }, { once: true });
      });
    },
    release(heldMs) {
      slots.active -= 1;
      slots.busyMs += heldMs;
      grant();
    },
  };
  function grant() {
    while (waiting.length && (slots.limit === 0 || slots.active < slots.limit)) {
      const next = waiting.shift();
      if (next.cancelled) continue;
      slots.active += 1;
      next.resolve(clock.now());
    }
  }
  return slots;
}

function words(count) {
  return ' token'.repeat(count);
}

/**
 * OpenAI-compatible upstream for sandbox sellers. Without timing fields in the profile it behaves like
 * the original mock: deterministic content and fixed 10/8 usage after `latencyMs`. With a profile it
 * models queueing, TTFT and decode speed, injects errors from a seeded RNG, and reports exactly the
 * tokens it generated (unless an adversarial mode says otherwise).
 */
export async function startMock({ models, label = 'mock', latencyMs = 0, profile, clock = realClock, seed }) {
  const png = await readFile(FIXTURE_PNG);
  let raw = profile ?? { latencyMs };
  let current = normalizeProfile(raw, { label: `${label} mock` });
  const epoch = clock.now();
  const slots = createSlots(clock);
  slots.setLimit(current.concurrency);
  const state = {
    get latencyMs() { return current.latencyMs; },
    get profile() { return current; },
    requests: [],
    dropped: 0,
    counters: { chat: 0, served: 0, ok: 0, error5xx: 0, rateLimited: 0, timeout: 0, drop: 0, aborted: 0, outputTokens: 0, inputTokens: 0 },
  };
  const known = new Set(models);
  let sequence = 0;
  const tagAttempts = new Map();

  const record = (entry) => {
    state.requests.push(entry);
    if (state.requests.length > MAX_RECORDED_REQUESTS) { state.requests.shift(); state.dropped += 1; }
    return entry;
  };

  async function chat(request, response, body, entry) {
    const abort = new AbortController();
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    const json = (status, payload, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    const profileNow = current;
    const index = sequence;
    sequence += 1;
    state.counters.chat += 1;
    // Draws are keyed by the workload request tag (and the attempt number for proxy retries) when present,
    // so concurrency and arrival order do not change which request gets which latency or error.
    const tag = entry.drawKey ?? entry.requestTag;
    const attempt = tag ? (tagAttempts.get(tag) ?? 0) : 0;
    if (tag) tagAttempts.set(tag, attempt + 1);
    if (tagAttempts.size > MAX_RECORDED_REQUESTS * 4) tagAttempts.clear();
    const rng = createRng(tag ? deriveSeed(seed ?? profileNow.seed, label, 'tag', tag, attempt) : deriveSeed(seed ?? profileNow.seed, label, index));
    if (tag) entry.attempt = attempt;
    const { inputTokens, outputTokens } = requestTokens(profileNow, { body, headers: request.headers, rng });
    Object.assign(entry, { index, inputTokens });
    const queueLimit = profileNow.errors.rateLimitQueue;
    if (queueLimit > 0 && slots.limit > 0 && slots.active >= slots.limit && slots.queued >= queueLimit) {
      state.counters.rateLimited += 1;
      Object.assign(entry, { status: 429, outcome: 'rate-limited', outputTokens: 0, finishedAt: clock.now() });
      return json(429, { error: { message: `${label} is over capacity, retry later`, type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': String(profileNow.errors.retryAfterSec) });
    }
    let acquiredAt;
    try {
      acquiredAt = await slots.acquire(abort.signal);
    } catch {
      state.counters.aborted += 1;
      Object.assign(entry, { outcome: 'aborted', outputTokens: 0, finishedAt: clock.now() });
      return undefined;
    }
    entry.queueMs = acquiredAt - entry.at;
    const plan = planResponse(profileNow, { inputTokens, outputTokens, stream: body.stream, rng, elapsedMs: acquiredAt - epoch });
    Object.assign(entry, { plannedTtftMs: Math.round(plan.ttftMs), degraded: plan.degraded, spike: plan.spike > 1 });
    let generated = 0;
    const content = `Hello from ${label} (${body.model}).`;
    const id = `chatcmpl-${index + 1}`;
    const created = Math.floor(clock.now() / 1000);
    const elapsed = () => clock.now() - acquiredAt;
    const waitUntil = (atMs) => clock.sleep(atMs - elapsed(), abort.signal);
    try {
      if (plan.outcome === 'error') {
        await waitUntil(plan.ttftMs);
        if (abort.signal.aborted) throw new Error('aborted');
        state.counters.error5xx += 1;
        Object.assign(entry, { status: plan.status, outcome: 'error' });
        return json(plan.status, { error: { message: `${label} upstream failure (injected)`, type: 'server_error' } });
      }
      if (plan.outcome === 'timeout') {
        state.counters.timeout += 1;
        Object.assign(entry, { outcome: 'timeout' });
        await waitUntil(plan.totalMs);
        response.destroy();
        return undefined;
      }
      const fixed = profileNow.usage === 'fixed';
      const fullText = (tokens) => (fixed ? content : `${content}${words(Math.max(0, tokens))}`);
      if (!body.stream) {
        if (plan.outcome === 'drop') {
          await waitUntil(plan.chunks[plan.dropAfterChunks].atMs);
          state.counters.drop += 1;
          Object.assign(entry, { outcome: 'drop' });
          response.destroy();
          return undefined;
        }
        await waitUntil(plan.totalMs);
        if (abort.signal.aborted) throw new Error('aborted');
        generated = outputTokens;
        const usage = fixed ? MOCK_USAGE : reportedUsage(profileNow, inputTokens, generated);
        Object.assign(entry, { status: 200, outcome: 'ok', usage });
        state.counters.ok += 1;
        return json(200, {
          id, object: 'chat.completion', created, model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: fullText(generated) } }],
          usage,
        });
      }
      const sse = (choices, usage = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices, usage })}\n\n`;
      for (let chunkIndex = 0; chunkIndex < plan.chunks.length; chunkIndex += 1) {
        const chunk = plan.chunks[chunkIndex];
        await waitUntil(chunk.atMs);
        if (abort.signal.aborted) throw new Error('aborted');
        if (chunkIndex === 0) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          entry.ttftMs = clock.now() - entry.at;
        }
        const text = fixed ? (chunkIndex === 0 ? content : '') : `${chunkIndex === 0 ? content : ''}${words(chunk.tokens)}`;
        const flushed = new Promise((resolve) => response.write(sse([{ index: 0, delta: { ...(chunkIndex === 0 ? { role: 'assistant' } : {}), content: text }, finish_reason: null }]), resolve));
        generated += chunk.tokens;
        if (plan.dropAfterChunks === chunkIndex) {
          state.counters.drop += 1;
          Object.assign(entry, { outcome: 'drop' });
          await flushed;
          response.destroy();
          return undefined;
        }
        if (profileNow.adversarial.stallStream && chunkIndex === 0) {
          Object.assign(entry, { outcome: 'stall-stream' });
          await clock.sleep(profileNow.errors.timeoutHoldMs, abort.signal);
          response.destroy();
          return undefined;
        }
      }
      if (fixed) generated = MOCK_USAGE.completion_tokens;
      const usage = fixed ? MOCK_USAGE : reportedUsage(profileNow, inputTokens, generated);
      response.write(sse([{ index: 0, delta: {}, finish_reason: 'stop' }]));
      response.write(sse([], usage));
      response.end('data: [DONE]\n\n');
      Object.assign(entry, { status: 200, outcome: 'ok', usage });
      state.counters.ok += 1;
      return undefined;
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      state.counters.aborted += 1;
      if (!entry.outcome) entry.outcome = 'aborted';
      return undefined;
    } finally {
      const heldMs = clock.now() - acquiredAt;
      slots.release(heldMs);
      state.counters.served += 1;
      state.counters.inputTokens += inputTokens;
      state.counters.outputTokens += generated;
      Object.assign(entry, { outputTokens: generated, heldMs, finishedAt: clock.now() });
    }
  }

  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      const path = (request.url ?? '/').split('?')[0];
      const tag = request.headers['x-sandbox-request-id'];
      const drawKey = request.headers['x-sandbox-draw-key'];
      const entry = record({ method: request.method, path, model: body.model ?? null, stream: Boolean(body.stream), at: clock.now(), ...(tag ? { requestTag: String(tag).slice(0, 128) } : {}), ...(drawKey ? { drawKey: String(drawKey).slice(0, 128) } : {}) });
      const isChat = request.method === 'POST' && path === '/v1/chat/completions' && (body.model === undefined || known.has(body.model));
      if (!isChat && current.latencyMs > 0) await clock.sleep(current.latencyMs);
      if (request.method === 'GET' && path === '/v1/models') {
        return json(200, { object: 'list', data: models.map((modelId) => ({ id: modelId, object: 'model', owned_by: 'antseed-sandbox' })) });
      }
      if (request.method !== 'POST') return json(404, { error: { message: `No mock route for ${request.method} ${path}`, type: 'invalid_request_error' } });
      if (body.model !== undefined && !known.has(body.model)) {
        entry.status = 404;
        return json(404, { error: { message: `The model ${body.model} does not exist`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      if (path === '/v1/chat/completions') return await chat(request, response, body, entry);
      if (path === '/v1/images/generations') {
        return json(200, { created: Math.floor(clock.now() / 1000), data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } });
      }
      return json(404, { error: { message: `No mock route for ${path}`, type: 'invalid_request_error' } });
    } catch (error) {
      if (!response.headersSent) json(500, { error: { message: error.message, type: 'server_error' } });
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const mock = {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    state,
    profile: () => current,
    rawProfile: () => structuredClone(raw),
    /** Merges (or with replace, swaps in) a profile patch shaped like topology `sellers[].mock`; applies to new requests. */
    setProfile(patch, { replace = false } = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('mock profile patch must be an object');
      const next = replace ? patch : mergeProfile(raw, patch);
      const updated = normalizeProfile(next, { label: `${label} mock` });
      if (updated.seed !== current.seed) { sequence = 0; tagAttempts.clear(); }
      current = updated;
      raw = next;
      slots.setLimit(current.concurrency);
      return current;
    },
    /** Starts a fresh draw sequence (scenario run start): same seed + same requests give the same draws. */
    resetDraws() { sequence = 0; tagAttempts.clear(); },
    setLatency(ms) { return mock.setProfile({ latencyMs: ms }); },
    chatCount() { return state.requests.filter((entry) => entry.path === '/v1/chat/completions').length; },
    stats() {
      const wallMs = Math.max(1, clock.now() - slots.startedAt);
      return {
        ...state.counters,
        slots: slots.limit,
        active: slots.active,
        queued: slots.queued,
        peakQueue: slots.peakQueue,
        busySlotMs: slots.busyMs,
        wallMs,
        utilisation: slots.limit > 0 ? slots.busyMs / (slots.limit * wallMs) : null,
        recordedRequestsDropped: state.dropped,
      };
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return mock;
}
