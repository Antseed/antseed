import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDist, sampleDist } from './random.mjs';

export const PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TOP_KEYS = new Set([
  'profile', 'description', 'usage', 'latencyMs', 'rttMs', 'prefillTokensPerSec', 'decodeTokensPerSec', 'jitterMs',
  'chunkTokens', 'outputTokens', 'concurrency', 'tailSpike', 'errors', 'degradation', 'adversarial', 'seed',
]);
const NESTED_KEYS = {
  tailSpike: new Set(['p', 'multiplier']),
  errors: new Set(['http5xx', 'status5xx', 'rateLimitQueue', 'retryAfterSec', 'midStreamDrop', 'timeout', 'timeoutHoldMs', 'stall', 'stallMs']),
  degradation: new Set(['everyMs', 'forMs', 'decodeMultiplier']),
  adversarial: new Set(['inflateUsage', 'stallStream']),
};
const MAX_MS = 600_000;

export const DEFAULT_ERRORS = { http5xx: 0, status5xx: 503, rateLimitQueue: 0, retryAfterSec: 1, midStreamDrop: 0, timeout: 0, timeoutHoldMs: 300_000, stall: 0, stallMs: 0 };
export const DEFAULT_ADVERSARIAL = { inflateUsage: 1, stallStream: false };

/** Reads e2e/sandbox/profiles/<name>.json. */
export function loadNamedProfile(name, dir = PROFILES_DIR) {
  if (!PROFILE_NAME.test(String(name))) throw new Error(`Invalid profile name "${name}"`);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`No mock profile "${name}" (looked for ${file})`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.profile !== undefined) throw new Error(`Profile file ${name}.json cannot reference another profile`);
  return value;
}

export function listProfiles(dir = PROFILES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
}

/** Merges a patch into a raw profile; nested objects merge by key, null removes degradation. */
export function mergeProfile(base = {}, patch = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (NESTED_KEYS[key] && value && typeof value === 'object' && !Array.isArray(value)) out[key] = { ...(base[key] ?? {}), ...value };
    else out[key] = value;
  }
  return out;
}

function rate(value, label, { min = 0, max = 1 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number in ${min}..${max}`);
  return value;
}

function int(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return value;
}

function checkKeys(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`Unknown ${label} key "${key}"`);
}

/**
 * Validates a seller mock profile (plain data from topology `sellers[].mock`, a profile file or a
 * control patch) and fills defaults. `{ profile: 'name', ...overrides }` starts from profiles/<name>.json.
 * Without timing fields the result is the legacy mock: fixed 10/8 usage after `latencyMs`.
 */
export function normalizeProfile(input = {}, { label = 'mock', dir = PROFILES_DIR } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be an object`);
  checkKeys(input, TOP_KEYS, label);
  const raw = input.profile !== undefined ? mergeProfile(loadNamedProfile(input.profile, dir), input) : input;
  checkKeys(raw, TOP_KEYS, label);
  for (const [key, allowed] of Object.entries(NESTED_KEYS)) {
    if (raw[key] !== undefined && raw[key] !== null) checkKeys(raw[key], allowed, `${label}.${key}`);
  }
  const timed = ['prefillTokensPerSec', 'decodeTokensPerSec', 'outputTokens'].some((key) => raw[key] !== undefined);
  const usage = raw.usage ?? (timed ? 'modeled' : 'fixed');
  if (!['fixed', 'modeled'].includes(usage)) throw new Error(`${label}.usage must be fixed or modeled`);
  const latencyMs = raw.latencyMs ?? 0;
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) throw new Error(`${label}.latencyMs must be 0-60000`);
  const errors = { ...DEFAULT_ERRORS, ...(raw.errors ?? {}) };
  for (const key of ['http5xx', 'midStreamDrop', 'timeout', 'stall']) rate(errors[key], `${label}.errors.${key}`);
  if (errors.http5xx + errors.midStreamDrop + errors.timeout > 1) throw new Error(`${label}.errors http5xx + midStreamDrop + timeout must be <= 1`);
  int(errors.status5xx, `${label}.errors.status5xx`, 500, 599);
  int(errors.rateLimitQueue, `${label}.errors.rateLimitQueue`, 0, 100_000);
  int(errors.retryAfterSec, `${label}.errors.retryAfterSec`, 0, 3600);
  int(errors.timeoutHoldMs, `${label}.errors.timeoutHoldMs`, 0, MAX_MS);
  int(errors.stallMs, `${label}.errors.stallMs`, 0, MAX_MS);
  const adversarial = { ...DEFAULT_ADVERSARIAL, ...(raw.adversarial ?? {}) };
  rate(adversarial.inflateUsage, `${label}.adversarial.inflateUsage`, { min: 1, max: 1000 });
  if (typeof adversarial.stallStream !== 'boolean') throw new Error(`${label}.adversarial.stallStream must be a boolean`);
  let tailSpike = null;
  if (raw.tailSpike) {
    tailSpike = { p: rate(raw.tailSpike.p ?? 0, `${label}.tailSpike.p`), multiplier: rate(raw.tailSpike.multiplier ?? 1, `${label}.tailSpike.multiplier`, { min: 1, max: 1000 }) };
  }
  let degradation = null;
  if (raw.degradation) {
    degradation = {
      everyMs: int(raw.degradation.everyMs, `${label}.degradation.everyMs`, 1, 86_400_000),
      forMs: int(raw.degradation.forMs, `${label}.degradation.forMs`, 0, 86_400_000),
      decodeMultiplier: rate(raw.degradation.decodeMultiplier ?? 1, `${label}.degradation.decodeMultiplier`, { min: 0.001, max: 1000 }),
    };
    if (degradation.forMs > degradation.everyMs) throw new Error(`${label}.degradation.forMs must be <= everyMs`);
  }
  const seed = raw.seed ?? 1;
  int(seed, `${label}.seed`, 0, 0xffffffff);
  return {
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(raw.description ? { description: String(raw.description) } : {}),
    usage,
    latencyMs,
    rttMs: normalizeDist(raw.rttMs ?? 0, `${label}.rttMs`, { max: MAX_MS }),
    prefillTokensPerSec: raw.prefillTokensPerSec === undefined ? null : normalizeDist(raw.prefillTokensPerSec, `${label}.prefillTokensPerSec`, { min: 0.001 }),
    decodeTokensPerSec: raw.decodeTokensPerSec === undefined ? null : normalizeDist(raw.decodeTokensPerSec, `${label}.decodeTokensPerSec`, { min: 0.001 }),
    jitterMs: normalizeDist(raw.jitterMs ?? 0, `${label}.jitterMs`, { max: MAX_MS }),
    chunkTokens: int(raw.chunkTokens ?? 4, `${label}.chunkTokens`, 1, 1000),
    outputTokens: normalizeDist(raw.outputTokens ?? 8, `${label}.outputTokens`, { min: 1, max: 1_000_000, integer: true }),
    concurrency: int(raw.concurrency ?? 0, `${label}.concurrency`, 0, 10_000),
    tailSpike,
    errors,
    degradation,
    adversarial,
    seed,
  };
}

/** Degradation window: active during the last `forMs` of every `everyMs` period since the mock epoch. */
export function degradationActive(degradation, elapsedMs) {
  if (!degradation || degradation.forMs === 0) return false;
  return elapsedMs % degradation.everyMs >= degradation.everyMs - degradation.forMs;
}

/** Deterministic input token estimate: ~4 characters per token plus 4 per message. */
export function estimateInputTokens(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let chars = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) for (const part of content) chars += typeof part?.text === 'string' ? part.text.length : 0;
  }
  if (typeof body?.prompt === 'string') chars += body.prompt.length;
  return Math.max(1, Math.ceil(chars / 4) + 4 * messages.length);
}

function hint(headers, name) {
  const value = headers?.[name];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000_000 ? parsed : null;
}

/**
 * Token counts for one request. Modeled usage honours x-sandbox-input-tokens / x-sandbox-output-tokens
 * hints, otherwise estimates input from the messages and samples output; max_tokens caps output.
 */
export function requestTokens(profile, { body, headers, rng }) {
  if (profile.usage === 'fixed') return { inputTokens: 10, outputTokens: 8 };
  const inputTokens = hint(headers, 'x-sandbox-input-tokens') ?? estimateInputTokens(body);
  let outputTokens = hint(headers, 'x-sandbox-output-tokens') ?? sampleDist(profile.outputTokens, rng);
  const cap = Number(body?.max_completion_tokens ?? body?.max_tokens);
  if (Number.isInteger(cap) && cap > 0) outputTokens = Math.min(outputTokens, cap);
  return { inputTokens, outputTokens: Math.max(1, outputTokens) };
}

/**
 * Pure timing/outcome plan for one request once it holds a slot. Random draws happen in a fixed
 * order so a given rng seed always yields the same plan.
 * Times are milliseconds relative to slot acquisition; chunk `atMs` values are cumulative.
 */
export function planResponse(profile, { inputTokens, outputTokens, stream, rng, elapsedMs = 0 }) {
  const roll = rng.next();
  const errors = profile.errors;
  let outcome = 'ok';
  if (roll < errors.http5xx) outcome = 'error';
  else if (roll < errors.http5xx + errors.timeout) outcome = 'timeout';
  else if (roll < errors.http5xx + errors.timeout + errors.midStreamDrop) outcome = 'drop';
  const spike = profile.tailSpike && rng.chance(profile.tailSpike.p) ? profile.tailSpike.multiplier : 1;
  const rttMs = sampleDist(profile.rttMs, rng);
  const jitterMs = sampleDist(profile.jitterMs, rng);
  const prefillRate = profile.prefillTokensPerSec ? sampleDist(profile.prefillTokensPerSec, rng) : null;
  const prefillMs = prefillRate ? (inputTokens / prefillRate) * 1000 : 0;
  const degraded = degradationActive(profile.degradation, elapsedMs);
  const baseDecode = profile.decodeTokensPerSec ? sampleDist(profile.decodeTokensPerSec, rng) : null;
  const decodeTokensPerSec = baseDecode === null ? null : (baseDecode * (degraded ? profile.degradation.decodeMultiplier : 1)) / spike;
  const dropFraction = rng.next();
  const stall = errors.stall > 0 && errors.stallMs > 0 && rng.chance(errors.stall);
  const ttftMs = profile.latencyMs + rttMs + (prefillMs + jitterMs) * spike;
  const plan = { outcome, spike, degraded, rttMs, jitterMs, prefillMs, ttftMs, decodeTokensPerSec, inputTokens, outputTokens, stream: Boolean(stream) };
  if (outcome === 'error') return { ...plan, status: errors.status5xx, chunks: [], totalMs: ttftMs };
  if (outcome === 'timeout') return { ...plan, chunks: [], totalMs: ttftMs + errors.timeoutHoldMs, holdMs: errors.timeoutHoldMs };
  const chunks = [];
  let emitted = 0;
  const perTokenMs = decodeTokensPerSec ? 1000 / decodeTokensPerSec : 0;
  const chunkSize = profile.usage === 'fixed' ? outputTokens : profile.chunkTokens;
  while (emitted < outputTokens) {
    const tokens = Math.min(chunkSize, outputTokens - emitted);
    emitted += tokens;
    chunks.push({ tokens, atMs: ttftMs + (emitted - tokens) * perTokenMs });
  }
  const decodeMs = outputTokens * perTokenMs;
  const out = { ...plan, status: 200, chunks, totalMs: ttftMs + decodeMs };
  if (outcome === 'drop') out.dropAfterChunks = Math.min(chunks.length - 1, Math.floor(dropFraction * chunks.length));
  if (stall && chunks.length > 1) {
    out.stallAtChunk = 1 + Math.floor(dropFraction * (chunks.length - 1));
    out.stallMs = errors.stallMs;
    for (let index = out.stallAtChunk; index < chunks.length; index += 1) chunks[index].atMs += errors.stallMs;
    out.totalMs += errors.stallMs;
  }
  return out;
}

/** Usage the mock reports: exact generated tokens unless adversarial inflation is on. */
export function reportedUsage(profile, inputTokens, generatedTokens) {
  const factor = profile.adversarial.inflateUsage;
  const prompt = Math.round(inputTokens * factor);
  const completion = Math.round(generatedTokens * factor);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
