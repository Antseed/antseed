import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realClock } from './mock.mjs';
import { createRng, deriveSeed, normalizeDist, sampleDist, zipfWeights } from './random.mjs';

export const WORKLOADS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'workloads');
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PERSONA_KEYS = new Set([
  'name', 'description', 'assumptions', 'share', 'arrival', 'turns', 'thinkTimeMs', 'systemTokens', 'inputTokens',
  'carryContext', 'outputTokens', 'models', 'streamRatio', 'abandonAfterMs',
]);
const WORKLOAD_KEYS = new Set(['normalized', 'name', 'description', 'sessionsPerMinute', 'personas', 'maxInFlight', 'maxPromptChars']);
const PROCESSES = new Set(['poisson', 'uniform']);

function readNamed(kind, name, dir) {
  if (!NAME.test(String(name))) throw new Error(`Invalid ${kind} name "${name}"`);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`No ${kind} "${name}" (looked for ${file})`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number in ${min}..${max}`);
  return value;
}

/** Validates a persona (plain data or workloads/personas/<name>.json) and fills defaults. */
export function normalizePersona(input, { dir = join(WORKLOADS_DIR, 'personas') } = {}) {
  const raw = typeof input === 'string' ? { name: input, ...readNamed('persona', input, dir) } : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('persona must be an object or a persona name');
  const name = raw.name;
  if (!NAME.test(String(name ?? ''))) throw new Error(`persona needs a valid name (got "${name}")`);
  const label = `persona ${name}`;
  for (const key of Object.keys(raw)) if (!PERSONA_KEYS.has(key)) throw new Error(`Unknown ${label} key "${key}"`);
  const arrival = raw.arrival ?? { process: 'poisson', perMinute: 1 };
  if (!PROCESSES.has(arrival.process ?? 'poisson')) throw new Error(`${label}.arrival.process must be poisson or uniform`);
  const models = raw.models ?? { zipf: 1 };
  if (models.zipf === undefined && !Array.isArray(models.weights)) throw new Error(`${label}.models needs zipf or weights`);
  return {
    name,
    ...(raw.description ? { description: raw.description } : {}),
    share: number(raw.share ?? 1, `${label}.share`, 0, 1_000_000),
    arrival: { process: arrival.process ?? 'poisson', perMinute: number(arrival.perMinute ?? 1, `${label}.arrival.perMinute`, 0, 1_000_000) },
    turns: normalizeDist(raw.turns ?? 1, `${label}.turns`, { min: 1, max: 10_000, integer: true }),
    thinkTimeMs: normalizeDist(raw.thinkTimeMs ?? 0, `${label}.thinkTimeMs`, { max: 3_600_000 }),
    systemTokens: Math.round(number(raw.systemTokens ?? 0, `${label}.systemTokens`, 0, 1_000_000)),
    inputTokens: normalizeDist(raw.inputTokens ?? 50, `${label}.inputTokens`, { min: 1, max: 2_000_000, integer: true }),
    carryContext: Boolean(raw.carryContext),
    outputTokens: normalizeDist(raw.outputTokens ?? 100, `${label}.outputTokens`, { min: 1, max: 1_000_000, integer: true }),
    models: models.zipf !== undefined ? { zipf: number(models.zipf, `${label}.models.zipf`, 0, 10) } : { weights: models.weights.map((weight, index) => number(weight, `${label}.models.weights[${index}]`, 0, 1e9)) },
    streamRatio: number(raw.streamRatio ?? 1, `${label}.streamRatio`, 0, 1),
    abandonAfterMs: Math.round(number(raw.abandonAfterMs ?? 120_000, `${label}.abandonAfterMs`, 1, 3_600_000)),
  };
}

/**
 * Validates a workload (plain data or workloads/<name>.json). With `sessionsPerMinute` the total is
 * split across personas by share; otherwise each persona uses its own arrival.perMinute.
 */
export function normalizeWorkload(input, { dir = WORKLOADS_DIR } = {}) {
  const raw = typeof input === 'string' ? { name: input, ...readNamed('workload', input, dir) } : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workload must be an object or a workload name');
  for (const key of Object.keys(raw)) if (!WORKLOAD_KEYS.has(key)) throw new Error(`Unknown workload key "${key}"`);
  if (!Array.isArray(raw.personas) || raw.personas.length === 0) throw new Error('workload.personas must list at least one persona');
  const personas = raw.personas.map((persona) => normalizePersona(persona, { dir: join(dir, 'personas') }));
  const names = new Set();
  for (const persona of personas) {
    if (names.has(persona.name)) throw new Error(`Duplicate persona ${persona.name}`);
    names.add(persona.name);
  }
  const totalShare = personas.reduce((sum, persona) => sum + persona.share, 0);
  const sessionsPerMinute = raw.sessionsPerMinute === undefined ? null : number(raw.sessionsPerMinute, 'workload.sessionsPerMinute', 0, 1_000_000);
  if (sessionsPerMinute !== null && totalShare <= 0) throw new Error('workload personas need a positive total share');
  for (const persona of personas) {
    persona.sessionsPerMinute = sessionsPerMinute === null ? persona.arrival.perMinute : (sessionsPerMinute * persona.share) / totalShare;
  }
  const maxInFlight = raw.maxInFlight ?? 64;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 10_000) throw new Error('workload.maxInFlight must be 1..10000');
  const maxPromptChars = raw.maxPromptChars ?? 16_000;
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 16 || maxPromptChars > 4_000_000) throw new Error('workload.maxPromptChars must be 16..4000000');
  return { normalized: true, name: raw.name ?? 'inline', ...(raw.description ? { description: raw.description } : {}), sessionsPerMinute, personas, maxInFlight, maxPromptChars };
}

/** Session start times in [0, durationMs) for a rate in sessions/minute. Independent of response times. */
export function arrivalTimes({ process = 'poisson', perMinute, durationMs, rng }) {
  const times = [];
  if (!(perMinute > 0)) return times;
  const meanGapMs = 60_000 / perMinute;
  if (process === 'uniform') {
    for (let at = meanGapMs / 2; at < durationMs; at += meanGapMs) times.push(at);
    return times;
  }
  let at = rng.exponential(1 / meanGapMs);
  while (at < durationMs) {
    times.push(at);
    at += rng.exponential(1 / meanGapMs);
  }
  return times;
}

/**
 * Deterministic workload plan: sessions with their start times and per-turn request shapes.
 * Same workload + models + seed + multiplier + duration always yields the same plan.
 */
export function planWorkload({ workload, models, durationMs, seed = 1, rateMultiplier = 1 }) {
  const spec = workload?.normalized ? workload : normalizeWorkload(workload);
  if (!Array.isArray(models) || models.length === 0) throw new Error('planWorkload needs at least one model');
  number(durationMs, 'durationMs', 1, 86_400_000);
  number(rateMultiplier, 'rateMultiplier', 0, 10_000);
  const sessions = [];
  for (const persona of spec.personas) {
    const rng = createRng(deriveSeed(seed, 'arrivals', persona.name));
    const starts = arrivalTimes({ process: persona.arrival.process, perMinute: persona.sessionsPerMinute * rateMultiplier, durationMs, rng });
    const weights = persona.models.weights ? models.map((_, index) => persona.models.weights[index] ?? 0) : zipfWeights(models.length, persona.models.zipf);
    starts.forEach((startMs, index) => {
      const sessionRng = createRng(deriveSeed(seed, 'session', persona.name, index));
      const model = models[sessionRng.pick(weights)];
      const turnCount = Math.max(1, sampleDist(persona.turns, sessionRng));
      const turns = [];
      let context = persona.systemTokens;
      for (let turn = 0; turn < turnCount; turn += 1) {
        const fresh = sampleDist(persona.inputTokens, sessionRng);
        const outputTokens = Math.max(1, sampleDist(persona.outputTokens, sessionRng));
        const inputTokens = persona.carryContext ? context + fresh : persona.systemTokens + fresh;
        turns.push({
          turn,
          inputTokens,
          outputTokens,
          stream: sessionRng.chance(persona.streamRatio) || persona.streamRatio === 1,
          thinkMs: turn === 0 ? 0 : sampleDist(persona.thinkTimeMs, sessionRng),
        });
        if (persona.carryContext) context = inputTokens + outputTokens;
      }
      sessions.push({ id: `${persona.name}-${index}`, persona: persona.name, startMs, model, abandonAfterMs: persona.abandonAfterMs, turns });
    });
  }
  sessions.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return { workload: spec.name, seed, rateMultiplier, durationMs, models, maxInFlight: spec.maxInFlight, maxPromptChars: spec.maxPromptChars, sessions };
}

/** Deterministic prompt text of about `tokens` tokens (4 chars each), capped at maxChars. */
export function promptText(tokens, maxChars, tag) {
  const head = `[${tag}] `;
  const length = Math.max(head.length, Math.min(maxChars, tokens * 4));
  return (head + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(length / 27))).slice(0, length);
}

/**
 * Executes a plan open-loop: every session starts at its scheduled time no matter how slow earlier
 * responses were; turns within a session follow the previous answer plus think time (like a person).
 * At most `maxInFlight` requests run at once; a request that would exceed it is recorded as dropped
 * (errorClass "overload") and ends its session. Turns that would start after `durationMs` are skipped
 * (counted, not recorded), so a run drains in about durationMs plus the slowest response.
 * `send(request, signal)` performs one request.
 * `timeline` entries `{ atMs, name, action }` run at their offsets (e.g. stop a seller) and are timed.
 * `requestPrefix` keeps request ids unique when the same plan runs twice against one sandbox.
 */
export async function executePlan(plan, { send, clock = realClock, maxInFlight = plan.maxInFlight, timeline = [], onRecord = () => {}, requestPrefix = '' }) {
  const startedAt = clock.now();
  const records = [];
  const events = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let sequence = 0;
  let skippedTurns = 0;
  const since = () => clock.now() - startedAt;

  async function runTurn(session, turn, scheduledMs) {
    const drawKey = `${plan.seed}-${session.id}-${turn.turn}`;
    const requestId = `${requestPrefix}${drawKey}`;
    const base = {
      requestId, drawKey, sequence: sequence++, persona: session.persona, sessionId: session.id, turn: turn.turn, model: session.model,
      stream: turn.stream, inputTokens: turn.inputTokens, plannedOutputTokens: turn.outputTokens, scheduledMs,
    };
    if (inFlight >= maxInFlight) {
      const record = { ...base, startMs: since(), status: 0, ok: false, errorClass: 'overload', error: `maxInFlight ${maxInFlight} reached`, latencyMs: 0 };
      records.push(record);
      onRecord(record);
      return false;
    }
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const startMs = since();
    const abort = new AbortController();
    let abandoned = false;
    const timer = clock.sleep(session.abandonAfterMs, abort.signal).then(() => {
      if (!abort.signal.aborted) { abandoned = true; abort.abort(); }
    });
    let result;
    try {
      // The prompt carries the deterministic draw key (not the run-unique request id) so content-keyed
      // randomness (sandbox router rankings) is the same for the same seed.
      result = await send({ ...base, prompt: promptText(turn.inputTokens, plan.maxPromptChars, drawKey) }, abort.signal);
    } catch (error) {
      result = { status: 0, ok: false, errorClass: 'buyer', error: error.message };
    } finally {
      inFlight -= 1;
    }
    if (abandoned) result = { ...result, ok: false, errorClass: 'timeout', error: `abandoned after ${session.abandonAfterMs} ms` };
    if (!abort.signal.aborted) abort.abort();
    await timer;
    const latencyMs = result.latencyMs ?? since() - startMs;
    const record = { ...base, startMs, schedulingLagMs: Math.max(0, startMs - scheduledMs), latencyMs, ...result };
    records.push(record);
    onRecord(record);
    return record.ok;
  }

  async function runSession(session) {
    await clock.sleep(session.startMs - since());
    let readyMs = session.startMs;
    for (const turn of session.turns) {
      const scheduledMs = readyMs + turn.thinkMs;
      if (scheduledMs >= plan.durationMs) { skippedTurns += 1; continue; }
      await clock.sleep(scheduledMs - since());
      const ok = await runTurn(session, turn, scheduledMs);
      if (!ok) return;
      readyMs = since();
    }
  }

  async function runTimeline(entry) {
    await clock.sleep(entry.atMs - since());
    const event = { name: entry.name, scheduledMs: entry.atMs, startMs: since() };
    events.push(event);
    try {
      event.result = await entry.action();
      event.ok = true;
    } catch (error) {
      event.ok = false;
      event.error = error.message;
    }
    event.endMs = since();
  }

  await Promise.all([...plan.sessions.map(runSession), ...timeline.map(runTimeline)]);
  records.sort((a, b) => a.sequence - b.sequence);
  return { records, events, wallMs: since(), peakInFlight, skippedTurns };
}

/** Classifies a failed proxy response. Peer-attributed 429/5xx and truncated streams blame the seller side. */
export function classifyFailure({ status, headers = {}, body = '', truncated = false, networkError = false }) {
  if (networkError) return 'buyer';
  if (truncated) return 'network';
  if (status === 499 || status === 408 || status === 504) return 'timeout';
  const peer = headers['x-antseed-peer-id'];
  const fault = headers['x-antseed-fault-attribution'];
  if (fault === 'buyer') return 'buyer';
  if (peer && (status === 429 || status >= 500)) return 'seller';
  if (/peer|seller|upstream|provider/i.test(body) && (status === 429 || status >= 500)) return 'seller';
  return 'buyer';
}

/** Sends one workload request through the buyer proxy like a real client and times it. */
export function proxySender({ proxyUrl, sellersByPeerId = new Map(), now = () => performance.now() }) {
  return async (request, signal) => {
    const started = now();
    const body = {
      model: request.model,
      messages: [{ role: 'user', content: request.prompt }],
      stream: request.stream,
      ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    };
    let response;
    try {
      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sandbox-request-id': request.requestId,
          ...(request.drawKey ? { 'x-sandbox-draw-key': request.drawKey } : {}),
          'x-sandbox-input-tokens': String(request.inputTokens),
          'x-sandbox-output-tokens': String(request.plannedOutputTokens),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return { status: 0, ok: false, errorClass: signal.aborted ? 'timeout' : 'buyer', error: error.message, latencyMs: now() - started };
    }
    const headers = Object.fromEntries(response.headers.entries());
    const peerId = headers['x-antseed-peer-id'] ?? null;
    const sellerId = peerId ? (sellersByPeerId.get(peerId) ?? `unknown:${peerId}`) : null;
    let firstByteMs = null;
    let text = '';
    let truncated = false;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        if (firstByteMs === null) firstByteMs = now() - started;
        text += decoder.decode(chunk, { stream: true });
      }
    } catch (error) {
      truncated = true;
      if (signal.aborted) return { status: response.status, ok: false, peerId, sellerId, errorClass: 'timeout', error: error.message, firstByteMs, latencyMs: now() - started };
    }
    const latencyMs = now() - started;
    const servedModel = headers['x-antseed-service'] ?? null;
    const base = { status: response.status, peerId, sellerId, ...(servedModel ? { servedModel } : {}), firstByteMs, latencyMs };
    if (response.status !== 200) {
      return { ...base, ok: false, errorClass: classifyFailure({ status: response.status, headers, body: text }), error: text.slice(0, 300) };
    }
    let usage = null;
    if (request.stream) {
      let done = false;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { done = true; continue; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) usage = parsed.usage;
        } catch { truncated = true; }
      }
      if (!done) truncated = true;
    } else {
      try { usage = JSON.parse(text).usage ?? null; } catch { truncated = true; }
    }
    if (truncated) return { ...base, ok: false, errorClass: 'network', error: 'response ended before completion', usage };
    return { ...base, ok: true, ttftMs: request.stream ? firstByteMs : latencyMs, usage, outputTokens: usage?.completion_tokens ?? null };
  };
}
