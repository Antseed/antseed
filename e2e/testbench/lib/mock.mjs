import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrng, derive } from './prng.mjs';

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pixel.png');
export const MOCK_USAGE = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 };
const FIXED_IMAGE_INPUT_TOKENS = 10;
const WORDS = 'the quick brown fox jumps over lazy dogs while seven agents argue about payment channels'.split(' ');
const TAG = /\[req:([a-z0-9-]+)\]/i;

function makeText(tokens) {
  const parts = [];
  let length = 0;
  const target = tokens * 4;
  while (length < target) {
    const word = WORDS[(length * 7 + parts.length) % WORDS.length];
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ').slice(0, target);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Micro-USDC for `usage` at a model's price: USD per million tokens is micro-USDC per token, rounded once
 * over the total like the seller's metering. Images add their unit price per image.
 */
export function usageCost(price = {}, { prompt = 0, completion = 0, images = 0 } = {}) {
  const tokens = prompt * (price.inputUsdPerMillion ?? 0) + completion * (price.outputUsdPerMillion ?? 0);
  return BigInt(Math.max(0, Math.round(tokens))) + BigInt(Math.round((price.imageUsd ?? 0) * 1_000_000)) * BigInt(images);
}

/**
 * OpenAI-compatible upstream for testbench sellers.
 *
 * `usage: 'fixed'` (default) answers 10 in + 8 out tokens after `latencyMs`, so receipts and settlement are exact.
 * `usage: 'load'` behaves like real traffic (the e2e/stress mock): prompt tokens from the request size, a random
 * completion within `outTokens`, latency within `latencyRangeMs`, streams chunked over that time.
 *
 * Both modes keep a delivery ledger keyed by the `[req:TAG]` marker in the prompt (or `untagged-N`): whether any
 * byte of the response reached the wire, how it ended (ok, 500, disconnect, client-gone) and what it cost at the
 * seller's price. That ledger is the independent judge of what the buyer owes. `fault500Rate` and
 * `disconnectRate` inject upstream errors and mid-response disconnects on tagged requests; change them with setFaults.
 *
 * `random` only seeds the mock: each request draws from its own stream keyed by tag and attempt, so what a request
 * gets does not depend on the order concurrent requests arrive in. The ledger records the drawn `latencyMs`.
 */
export async function startMock({ models, label = 'mock', latencyMs = 0, usage = 'fixed', latencyRangeMs = [50, 3000], outTokens = [100, 4000], fault500Rate = 0, disconnectRate = 0, pricing = {}, random = Math.random }) {
  const png = await readFile(FIXTURE_PNG);
  const state = { latencyMs, faults: { fault500Rate, disconnectRate }, requests: [], deliveries: new Map(), active: 0, maxActive: 0 };
  const known = new Set(models);
  const streamSeed = Math.floor(random() * 2 ** 32);
  const between = (draw, [min, max]) => min + draw() * (max - min);
  const betweenInt = (draw, [min, max]) => Math.floor(min + draw() * (max - min + 1));
  const attemptOf = (tag) => { const previous = state.deliveries.get(tag); return previous ? (previous.attempts ?? 1) + 1 : 1; };
  const requestRandom = (tag) => createPrng(derive(streamSeed, `${tag}#${attemptOf(tag)}`));
  // A tag seen again (an upstream retry) is judged by its latest attempt, as in e2e/stress/mock-upstream.mjs.
  const record = (tag, entry) => {
    const previous = state.deliveries.get(tag);
    if (previous) entry.attempts = (previous.attempts ?? 1) + 1;
    state.deliveries.set(tag, entry);
    return entry;
  };

  async function chat(request, response, body, gone) {
    const content = JSON.stringify(body.messages ?? '');
    const tagged = content.match(TAG);
    const tag = tagged ? tagged[1] : `untagged-${state.requests.length}`;
    const draw = requestRandom(tag);
    const load = usage === 'load';
    const prompt = load ? Math.max(1, Math.ceil(content.length / 4)) : MOCK_USAGE.prompt_tokens;
    const completion = load ? betweenInt(draw, outTokens) : MOCK_USAGE.completion_tokens;
    const totalMs = load ? between(draw, latencyRangeMs) : state.latencyMs;
    const stream = body.stream === true;
    const entry = record(tag, { status: 'pending', started: false, stream, model: body.model, prompt, completion, latencyMs: totalMs, cost: String(usageCost(pricing[body.model], { prompt, completion })) });
    const usageBody = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    const text = load ? makeText(completion) : `Hello from ${label} (${body.model}).`;
    const id = `chatcmpl-${tag}`;
    const created = Math.floor(Date.now() / 1000);

    if (tagged && draw() < state.faults.fault500Rate) {
      await sleep(totalMs / 3);
      entry.status = '500';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'mock upstream internal error', type: 'server_error' } }));
      return;
    }
    const disconnect = tagged && draw() < state.faults.disconnectRate;
    if (!stream) {
      await sleep(totalMs);
      if (gone()) { entry.status = 'client-gone'; return; }
      if (disconnect) { entry.status = 'disconnect'; response.socket?.destroy(); return; }
      entry.started = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: usageBody }));
      entry.status = 'ok';
      return;
    }
    // Streaming: under load the first byte comes after ~20% of the latency and the rest in chunks over the
    // remaining time; fixed usage waits the whole latency, then sends one chunk.
    await sleep(load ? totalMs * 0.2 : totalMs);
    if (gone()) { entry.status = 'client-gone'; return; }
    entry.started = true;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (choices, usageChunk = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices, usage: usageChunk })}\n\n`;
    const pieces = load ? Math.max(2, Math.min(40, Math.ceil(text.length / 400))) : 1;
    const step = Math.ceil(text.length / pieces);
    const cutAt = disconnect ? Math.max(1, betweenInt(draw, [1, Math.max(1, pieces - 1)])) : -1;
    response.write(chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]));
    for (let index = 0; index < pieces; index += 1) {
      if (gone()) { entry.status = 'client-gone'; return; }
      if (index === cutAt || (disconnect && pieces === 1)) { entry.status = 'disconnect'; response.socket?.destroy(); return; }
      response.write(chunk([{ index: 0, delta: { content: text.slice(index * step, (index + 1) * step) }, finish_reason: null }]));
      if (load) await sleep((totalMs * 0.8) / pieces);
    }
    if (gone()) { entry.status = 'client-gone'; return; }
    response.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
    response.write(chunk([], usageBody));
    response.end('data: [DONE]\n\n');
    entry.status = 'ok';
  }

  async function image(response, body) {
    const prompt = String(body.prompt ?? '');
    const tagged = prompt.match(TAG);
    const tag = tagged ? tagged[1] : `untagged-${state.requests.length}`;
    const load = usage === 'load';
    const n = load ? Math.max(1, Number(body.n ?? 1)) : 1;
    const inputTokens = load ? Math.max(1, Math.ceil(prompt.length / 4)) : FIXED_IMAGE_INPUT_TOKENS;
    const latency = load ? between(requestRandom(tag), latencyRangeMs) : 0;
    if (load) await sleep(latency);
    const entry = record(tag, { status: 'ok', started: true, image: true, n, model: body.model, prompt: inputTokens, latencyMs: latency, cost: String(usageCost(pricing[body.model], { prompt: inputTokens, images: n })) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: Array.from({ length: n }, () => ({ b64_json: png.toString('base64') })),
      usage: { input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens, ...(load ? { input_tokens_details: { text_tokens: inputTokens, image_tokens: 0 } } : {}) },
    }));
    return entry;
  }

  const server = createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    let gone = false;
    response.on('close', () => { if (!response.writableEnded) gone = true; });
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      const path = (request.url ?? '/').split('?')[0];
      state.requests.push({ method: request.method, path, model: body.model ?? null, stream: Boolean(body.stream), at: Date.now() });
      if (request.method === 'GET' && path === '/v1/models') {
        if (state.latencyMs > 0) await sleep(state.latencyMs);
        return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'antseed-testbench' })) });
      }
      if (request.method !== 'POST') return json(404, { error: { message: `No mock route for ${request.method} ${path}`, type: 'invalid_request_error' } });
      if (body.model !== undefined && !known.has(body.model)) {
        return json(404, { error: { message: `The model ${body.model} does not exist`, type: 'invalid_request_error', code: 'model_not_found' } });
      }
      if (path === '/v1/chat/completions') return await chat(request, response, body, () => gone);
      if (path === '/v1/images/generations') {
        if (usage !== 'load' && state.latencyMs > 0) await sleep(state.latencyMs);
        return await image(response, body);
      }
      return json(404, { error: { message: `No mock route for ${path}`, type: 'invalid_request_error' } });
    } catch (error) {
      if (!response.headersSent) json(500, { error: { message: error.message, type: 'server_error' } });
      else response.destroy(error);
    } finally {
      state.active -= 1;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    state,
    setLatency(ms) { state.latencyMs = ms; },
    /** Changes the fault rates for requests that arrive from now on. */
    setFaults({ fault500Rate: nextFault500 = state.faults.fault500Rate, disconnectRate: nextDisconnect = state.faults.disconnectRate } = {}) {
      state.faults = { fault500Rate: nextFault500, disconnectRate: nextDisconnect };
      return state.faults;
    },
    chatCount() { return state.requests.filter((entry) => entry.path === '/v1/chat/completions').length; },
    /** The delivery ledger as plain data: { tag: { status, started, cost, ... } } plus totals. */
    deliveries() { return summarizeDeliveries(state.deliveries, state); },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Totals over a delivery ledger. `deliveredCost` sums responses delivered in full (what a fault-free run must
 * settle exactly); `startedCost` sums every response that put any byte on the wire (the most the buyer can owe).
 */
export function summarizeDeliveries(deliveries, { active = 0, maxActive = 0 } = {}) {
  const byTag = Object.fromEntries(deliveries);
  const counts = {};
  let deliveredCost = 0n;
  let startedCost = 0n;
  for (const entry of deliveries.values()) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    if (entry.status === 'ok') deliveredCost += BigInt(entry.cost);
    if (entry.started) startedCost += BigInt(entry.cost);
  }
  return { byTag, counts, deliveredCost: String(deliveredCost), startedCost: String(startedCost), active, maxActive };
}
