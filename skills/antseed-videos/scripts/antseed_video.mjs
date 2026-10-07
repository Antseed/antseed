#!/usr/bin/env node
// Discover, select, generate, and download Antseed videos without leaking media or secrets.
// Uses only Node.js built-ins (Node 18+), so it runs anywhere Antseed runs, including
// the Node runtime bundled with Antseed Desktop.

import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:8377';
const AUTHORIZATION = 'Bearer antseed-desktop';
const MAX_FRAME_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const JSON_LIMIT = 1024 * 1024;
const MIN_NODE_MAJOR = 18;
const INPUT_FIELDS = { first_frame: 'image_url', last_frame: 'end_image_url' };

export class VideoError extends Error {
  constructor(message, code = 'video_error', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(sortKeys(value), null, 2)}\n`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function expandPath(raw) {
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

export function proxyUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VideoError('Proxy URL must be a loopback http URL.', 'unsafe_proxy_url');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || parsed.username || parsed.password) {
    throw new VideoError('Proxy URL must be a loopback http URL.', 'unsafe_proxy_url');
  }
  return raw.replace(/\/+$/, '');
}

async function readLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) {
      await response.body.cancel().catch(() => {});
      throw new VideoError('Response was too large to inspect safely.', 'response_too_large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  if (!raw.length) return {};
  try {
    const value = JSON.parse(raw.toString('utf8'));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

async function proxyFetch(url, init, timeoutSeconds) {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new VideoError('The local Antseed buyer proxy timed out.', 'proxy_timeout');
    throw new VideoError('Could not reach the local Antseed buyer proxy.', 'proxy_unreachable', {
      reason: String(error?.cause?.code || error?.cause?.message || error?.message || error),
    });
  }
}

async function requestJson(method, url, body, timeoutSeconds = 120) {
  const headers = { authorization: AUTHORIZATION };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await proxyFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutSeconds);
  return { status: response.status, headers: response.headers, body: parseJson(await readLimited(response, JSON_LIMIT)) };
}

export function errorFrom(status, body, fallback) {
  const error = body.error;
  if (isObject(error)) {
    return new VideoError(String(error.message || fallback), String(error.code || error.type || `http_${status}`), { status });
  }
  return new VideoError(String(error || body.message || fallback), `http_${status}`, { status });
}

async function catalog(base) {
  const { status, body } = await requestJson('GET', `${base}/v1/models?type=videos`);
  if (status !== 200) throw errorFrom(status, body, 'Could not list video models.');
  return Array.isArray(body.data) ? body.data.filter(isObject) : [];
}

async function resolveModel(base, requested) {
  const needle = requested.trim().toLowerCase();
  for (const entry of await catalog(base)) {
    const names = [entry.id, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    if (names.some((name) => typeof name === 'string' && name.toLowerCase() === needle)) {
      const { status, body } = await requestJson('GET', `${base}/v1/models/${encodeURIComponent(String(entry.id))}`);
      if (status !== 200) throw errorFrom(status, body, 'Could not inspect the video model.');
      return body;
    }
  }
  throw new VideoError(`Video model '${requested}' was not found.`, 'model_not_found');
}

function peerOptions(peer) {
  const video = isObject(peer.capabilities) ? peer.capabilities.video : undefined;
  return isObject(video) ? video : {};
}

function reputationOf(peer) {
  return 'effectiveReputationScore' in peer ? peer.effectiveReputationScore : peer.reputationScore;
}

export function priceEstimate(peer, duration, resolution) {
  const models = peer.unitBillingModels;
  const model = isObject(models) ? models['venice-video'] : undefined;
  const components = isObject(model) ? model.components : undefined;
  if (!Array.isArray(components)) return null;
  let total = 0;
  for (const component of components) {
    if (!isObject(component)) continue;
    const match = component.match;
    if (isObject(match)) {
      if (match.model != null && match.model !== peer.serviceId) continue;
      if (match.resolution != null && match.resolution !== resolution) continue;
    }
    const price = component.priceUsd;
    if (!isNumber(price)) continue;
    if (component.unit === 'video_generations') {
      total += price;
    } else if (component.unit === 'video_seconds') {
      if (duration == null) return null;
      total += price * duration;
    }
  }
  return Math.round(total * 1e6) / 1e6;
}

function peerSummary(peer, args) {
  return {
    peerId: peer.peerId ?? null,
    displayName: peer.displayName ?? null,
    serviceId: peer.serviceId ?? null,
    reputationScore: reputationOf(peer) ?? null,
    estimatedPriceUsd: priceEstimate(peer, args.duration, args.resolution),
    video: peerOptions(peer),
  };
}

function requestedInputs(args) {
  return [['first_frame', args.firstFrame], ['last_frame', args.lastFrame]].filter(([, value]) => value).map(([kind]) => kind);
}

export function incompatibilities(peer, args) {
  if (!(Array.isArray(peer.protocols) && peer.protocols.includes('venice-video'))) return ['venice-video protocol'];
  const video = peerOptions(peer);
  const reasons = [];
  for (const [label, value, key] of [
    ['duration', args.duration, 'durationsSeconds'],
    ['resolution', args.resolution, 'resolutions'],
    ['aspect ratio', args.aspectRatio, 'aspectRatios'],
  ]) {
    const allowed = video[key];
    if (value != null && Array.isArray(allowed) && !allowed.includes(value)) reasons.push(label);
  }
  if (args.aspectRatio != null && !Array.isArray(video.aspectRatios)) reasons.push('aspect ratio');
  if (args.audio != null && video.audio !== true) reasons.push('audio setting');
  const inputs = requestedInputs(args);
  if (Array.isArray(video.inputs)) reasons.push(...inputs.filter((kind) => !video.inputs.includes(kind)));
  if (Array.isArray(video.requiredInputs)) {
    reasons.push(...video.requiredInputs.filter((kind) => !inputs.includes(kind)).map((kind) => `missing ${kind}`));
  }
  return reasons;
}

export function compatiblePeers(model, args) {
  const compatible = [];
  const rejected = [];
  for (const peer of Array.isArray(model.peers) ? model.peers : []) {
    if (!isObject(peer) || typeof peer.peerId !== 'string') continue;
    const reasons = incompatibilities(peer, args);
    (reasons.length ? rejected : compatible).push({ peer, reasons });
  }
  const score = ({ peer }) => {
    const reputation = reputationOf(peer);
    const price = priceEstimate(peer, args.duration, args.resolution);
    const reputationValue = isNumber(reputation) ? reputation : -1;
    const priceValue = price ?? Number.POSITIVE_INFINITY;
    return args.prefer === 'price' ? [priceValue, -reputationValue] : [-reputationValue, priceValue];
  };
  compatible.sort((left, right) => {
    const [a0, a1] = score(left);
    const [b0, b1] = score(right);
    return a0 !== b0 ? (a0 < b0 ? -1 : 1) : a1 === b1 ? 0 : a1 < b1 ? -1 : 1;
  });
  return { compatible, rejected };
}

function alternatives(model) {
  const keys = ['durationsSeconds', 'resolutions', 'aspectRatios', 'inputs'];
  const result = {};
  for (const key of keys) {
    const values = new Set();
    for (const peer of Array.isArray(model.peers) ? model.peers : []) {
      if (!isObject(peer)) continue;
      const value = peerOptions(peer)[key];
      if (Array.isArray(value)) value.forEach((item) => values.add(item));
    }
    if (values.size) {
      result[key] = [...values].sort((a, b) => {
        const aString = typeof a === 'string';
        const bString = typeof b === 'string';
        if (aString !== bString) return aString ? 1 : -1;
        return a === b ? 0 : a < b ? -1 : 1;
      });
    }
  }
  return result;
}

function normalizePeerId(value) {
  const lower = value.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

export function selectedPeer(model, args) {
  let { compatible, rejected } = compatiblePeers(model, args);
  if (args.peer) {
    const wanted = normalizePeerId(args.peer);
    compatible = compatible.filter((item) => normalizePeerId(item.peer.peerId) === wanted);
  }
  if (!compatible.length) {
    throw new VideoError('No advertised seller supports the requested video options.', 'no_compatible_video_offer', {
      alternatives: alternatives(model),
      rejected: rejected.map((item) => ({ peerId: item.peer.peerId ?? null, reasons: item.reasons })),
    });
  }
  return compatible[0].peer;
}

export function detectImage(raw) {
  if (raw.length >= 8 && raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg';
  if (raw.length >= 12 && raw.toString('latin1', 0, 4) === 'RIFF' && raw.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function imageDataUrl(filePath) {
  const raw = await readFile(expandPath(filePath));
  if (!raw.length || raw.length > MAX_FRAME_BYTES) throw new VideoError(`${filePath} must be an image up to 25 MiB.`, 'invalid_frame');
  const mimeType = detectImage(raw);
  if (!mimeType) throw new VideoError(`${filePath} must be PNG, JPEG, or WebP.`, 'invalid_frame');
  return `data:${mimeType};base64,${raw.toString('base64')}`;
}

async function readPrompt(args) {
  const prompt = args.promptFile ? await readFile(expandPath(args.promptFile), 'utf8') : args.prompt;
  if (!prompt || !prompt.trim()) throw new VideoError('A video prompt is required.', 'missing_prompt');
  return prompt.trim();
}

export async function createBody(peer, args) {
  const service = peer.serviceId || args.modelId;
  const body = { model: `${peer.peerId}@${service}`, prompt: await readPrompt(args) };
  if (args.duration != null) body.duration = `${args.duration}s`;
  else if (args.autoDuration) body.duration = 'auto';
  if (args.resolution) body.resolution = args.resolution;
  if (args.aspectRatio) body.aspect_ratio = args.aspectRatio;
  if (args.audio != null) body.audio = args.audio;
  if (args.firstFrame) body[INPUT_FIELDS.first_frame] = await imageDataUrl(args.firstFrame);
  if (args.lastFrame) body[INPUT_FIELDS.last_frame] = await imageDataUrl(args.lastFrame);
  return body;
}

const NON_GLOBAL = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_GLOBAL.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) NON_GLOBAL.addSubnet(network, prefix, 'ipv6');
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

export function isUnsafeIp(value) {
  const address = value.replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(address);
  if (family === 4) return NON_GLOBAL.check(address, 'ipv4');
  if (family !== 6) throw new TypeError(`Not an IP address: ${value}`);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_GLOBAL.check(mapped[1], 'ipv4');
  return NON_GLOBAL.check(address, 'ipv6') || !GLOBAL_UNICAST_V6.check(address, 'ipv6');
}

export async function assertSafeHttps(url, resolve = lookup) {
  const unsafe = () => new VideoError('Video service returned an unsafe download URL.', 'unsafe_download_url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw unsafe();
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'https:' || !host || parsed.username || parsed.password || host === 'localhost' || host.endsWith('.localhost')) {
    throw unsafe();
  }
  if (isIP(host)) {
    if (isUnsafeIp(host)) throw unsafe();
    return;
  }
  let addresses;
  try {
    addresses = await resolve(host, { all: true });
  } catch {
    throw new VideoError('Could not resolve the video download host.', 'download_failed');
  }
  if (!addresses.length || addresses.some((entry) => isUnsafeIp(entry.address))) throw unsafe();
}

function idleTimeout(seconds) {
  const controller = new AbortController();
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new VideoError('Video download stalled.', 'download_timeout')), seconds * 1000);
  };
  reset();
  return { signal: controller.signal, reset, clear: () => clearTimeout(timer) };
}

async function saveMp4(response, output, onChunk = () => {}) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_VIDEO_BYTES) throw new VideoError('Generated video exceeds the size limit.', 'video_too_large');
  await mkdir(path.dirname(output), { recursive: true });
  const tempName = path.join(path.dirname(output), `.antseed-video-${process.pid}-${Date.now()}.mp4`);
  const handle = await open(tempName, 'wx', 0o600);
  let total = 0;
  let header = Buffer.alloc(0);
  let moved = false;
  try {
    try {
      for await (const chunk of response.body ?? []) {
        onChunk();
        total += chunk.length;
        if (total > MAX_VIDEO_BYTES) throw new VideoError('Generated video exceeds the size limit.', 'video_too_large');
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(chunk.subarray(0, 12 - header.length))]);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (header.length < 12 || header.toString('latin1', 4, 8) !== 'ftyp') {
      throw new VideoError('Video service returned an unsupported format.', 'invalid_video');
    }
    await rename(tempName, output);
    moved = true;
    return total;
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  } finally {
    if (!moved) await unlink(tempName).catch(() => {});
  }
}

async function fetchStream(url, init, label, code) {
  const timer = idleTimeout(300);
  try {
    return { response: await fetch(url, { ...init, redirect: 'manual', signal: timer.signal }), timer };
  } catch (error) {
    timer.clear();
    if (timer.signal.reason instanceof VideoError) throw timer.signal.reason;
    throw new VideoError(`Could not reach the ${label}.`, code);
  }
}

async function withIdleTimer(timer, work) {
  try {
    return await work();
  } catch (error) {
    if (timer.signal.aborted && timer.signal.reason instanceof VideoError) throw timer.signal.reason;
    throw error;
  } finally {
    timer.clear();
  }
}

function mediaType(response) {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

async function downloadCompleted(downloadUrl, output) {
  await assertSafeHttps(downloadUrl);
  const { response, timer } = await fetchStream(downloadUrl, {}, 'video download host', 'download_failed');
  return withIdleTimer(timer, async () => {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new VideoError('Video download failed.', 'download_failed', { status: response.status });
    }
    return saveMp4(response, output, timer.reset);
  });
}

async function retrieveOnce(base, modelId, jobId, output, downloadUrl) {
  const body = { model: modelId, queue_id: jobId, delete_media_on_completion: false };
  const { response, timer } = await fetchStream(`${base}/api/v1/video/retrieve`, {
    method: 'POST',
    headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 'local Antseed buyer proxy', 'proxy_unreachable');
  const statusBody = await withIdleTimer(timer, async () => {
    if (response.status >= 200 && response.status < 300 && mediaType(response) === 'video/mp4') {
      return { bytes: await saveMp4(response, output, timer.reset) };
    }
    const parsed = parseJson(await readLimited(response, JSON_LIMIT));
    if (response.status < 200 || response.status >= 300) throw errorFrom(response.status, parsed, 'Video status failed.');
    return { parsed };
  });
  if (statusBody.bytes !== undefined) return { state: 'done', bytes: statusBody.bytes };
  const status = String(statusBody.parsed.status ?? '').toUpperCase();
  if (status === 'FAILED' || status === 'CANCELLED') throw errorFrom(422, statusBody.parsed, 'Video generation failed.');
  if (status === 'COMPLETED') {
    if (!downloadUrl) throw new VideoError('Video completed without a download URL.', 'missing_download_url');
    try {
      return { state: 'done', bytes: await downloadCompleted(downloadUrl, output) };
    } catch (error) {
      if (error instanceof VideoError) error.details.completed = true;
      throw error;
    }
  }
  return { state: status.toLowerCase() || 'pending' };
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['proxy_unreachable', 'proxy_timeout', 'download_timeout', 'download_failed']);
export const RETRY_DELAYS_SECONDS = [5, 10, 20, 40, 60];
export const MAX_TRANSIENT_FAILURES = RETRY_DELAYS_SECONDS.length;
export const MAX_TRANSIENT_FAILURES_AFTER_COMPLETED = 3;

/** Retrieve errors that may clear on their own; everything else is final. */
export function isTransientRetrieveError(error) {
  if (!(error instanceof VideoError)) return false;
  const status = error.details.status;
  return status === undefined ? TRANSIENT_CODES.has(error.code) : TRANSIENT_STATUSES.has(status);
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Polls one accepted job until it is saved. Retrieves never create jobs, so
 * retrying is free; temporary errors are retried with backoff, but only a
 * bounded number of times in a row so a lasting failure surfaces quickly.
 */
export async function waitForVideo(base, modelId, jobId, output, downloadUrl, interval, timeout, { retrieve = retrieveOnce, delays = RETRY_DELAYS_SECONDS } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let failures = 0;
  let completed = false;
  let lastError = null;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await retrieve(base, modelId, jobId, output, downloadUrl);
    } catch (error) {
      if (!isTransientRetrieveError(error)) throw error;
      if (error.details.completed) completed = true;
      failures += 1;
      lastError = error;
      const limit = completed ? MAX_TRANSIENT_FAILURES_AFTER_COMPLETED : MAX_TRANSIENT_FAILURES;
      if (failures >= limit) throw retrieveUnavailable(jobId, error, failures);
      const delay = Math.min(delays[Math.min(failures - 1, delays.length - 1)], Math.max(0, (deadline - Date.now()) / 1000));
      await sleep(delay);
      continue;
    }
    if (result.state === 'done') return result;
    failures = 0;
    await sleep(interval);
  }
  if (lastError && failures > 0) throw retrieveUnavailable(jobId, lastError, failures);
  throw new VideoError('Timed out while waiting for the video.', 'video_timeout', { jobId, resumable: true });
}

function retrieveUnavailable(jobId, error, attempts) {
  return new VideoError('The video job was accepted, but its status or download kept failing. Retry later with download --job-id; this does not create a new job.', 'video_retrieve_unavailable', {
    jobId,
    lastStatus: error.details.status ?? null,
    lastCode: error.code,
    attempts,
    resumable: true,
  });
}

async function commandModels(args) {
  const models = (await catalog(args.proxyUrl)).map((entry) => ({
    id: entry.id ?? null,
    name: entry.name ?? null,
    aliases: entry.aliases ?? null,
    sellers: Array.isArray(entry.peers) ? entry.peers.length : 0,
  }));
  return { ok: true, models };
}

async function commandOptions(args) {
  const model = await resolveModel(args.proxyUrl, args.model);
  const sellers = (Array.isArray(model.peers) ? model.peers : []).filter(isObject).map((peer) => peerSummary(peer, args));
  return { ok: true, model: model.id ?? null, sellers, alternatives: alternatives(model) };
}

async function commandSelect(args) {
  const model = await resolveModel(args.proxyUrl, args.model);
  args.modelId = model.id;
  const { compatible } = compatiblePeers(model, args);
  const selected = selectedPeer(model, args);
  return {
    ok: true,
    model: model.id ?? null,
    selected: peerSummary(selected, args),
    compatible: compatible.map((item) => peerSummary(item.peer, args)),
  };
}

async function commandGenerate(args) {
  if (!args.peer) throw new VideoError('Run select first and pass the confirmed seller with --peer.', 'missing_peer');
  const model = await resolveModel(args.proxyUrl, args.model);
  args.modelId = String(model.id);
  const peer = selectedPeer(model, args);
  const { status, headers, body: accepted } = await requestJson('POST', `${args.proxyUrl}/api/v1/video/queue`, await createBody(peer, args), 300);
  if (status < 200 || status >= 300) {
    const error = errorFrom(status, accepted, 'Video creation failed.');
    error.details.peerId = peer.peerId;
    throw error;
  }
  const jobId = accepted.queue_id;
  if (typeof jobId !== 'string' || !jobId) throw new VideoError('Video service did not return a job id.', 'missing_job_id', { peerId: peer.peerId });
  const output = expandPath(args.output);
  const downloadUrl = typeof accepted.download_url === 'string' ? accepted.download_url : null;
  let result;
  try {
    result = await waitForVideo(args.proxyUrl, String(peer.serviceId || args.modelId), jobId, output, downloadUrl, args.pollInterval, args.timeout);
  } catch (error) {
    if (error instanceof VideoError) Object.assign(error.details, { jobId, peerId: peer.peerId });
    throw error;
  }
  return { ok: true, output, bytes: result.bytes, model: args.modelId, peerId: headers.get('x-antseed-seller-peer') || peer.peerId, jobId };
}

async function commandDownload(args) {
  const output = expandPath(args.output);
  const result = await waitForVideo(args.proxyUrl, args.model, args.jobId, output, null, args.pollInterval, args.timeout);
  return { ok: true, output, bytes: result.bytes, model: args.model, jobId: args.jobId };
}

async function commandFrame(args) {
  const ffmpeg = process.env.ANTSEED_FFMPEG || 'ffmpeg';
  const source = expandPath(args.video);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new VideoError(`Video not found: ${source}`, 'file_error');
  const output = expandPath(args.output);
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(output).toLowerCase())) {
    throw new VideoError('Frame output must end in .png, .jpg, .jpeg, or .webp.', 'invalid_frame');
  }
  await mkdir(path.dirname(output), { recursive: true });
  const seek = args.position === 'last' ? ['-sseof', '-0.1'] : [];
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...seek, '-i', source, '-frames:v', '1', '-update', '1', output], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error?.code === 'ENOENT') throw new VideoError('ffmpeg is required to extract frames.', 'ffmpeg_missing');
  const written = await stat(output).catch(() => null);
  if (result.status !== 0 || !written?.isFile() || written.size === 0) {
    throw new VideoError('Could not extract a frame from the video.', 'frame_extract_failed', { stderr: String(result.stderr || '').trim().slice(-300) });
  }
  return { ok: true, output, position: args.position, video: source };
}

const REQUEST_OPTIONS = {
  model: { type: 'string' },
  peer: { type: 'string' },
  prefer: { type: 'string', default: 'reputation' },
  duration: { type: 'string' },
  'auto-duration': { type: 'boolean' },
  resolution: { type: 'string' },
  'aspect-ratio': { type: 'string' },
  audio: { type: 'boolean' },
  'no-audio': { type: 'boolean' },
  'first-frame': { type: 'string' },
  'last-frame': { type: 'string' },
  prompt: { type: 'string' },
  'prompt-file': { type: 'string' },
};
const WAIT_OPTIONS = {
  output: { type: 'string', default: 'generated-video.mp4' },
  'poll-interval': { type: 'string', default: '5' },
  timeout: { type: 'string', default: '1800' },
};
const COMMANDS = {
  models: { options: {}, run: commandModels },
  options: { options: { model: { type: 'string' }, duration: { type: 'string' }, resolution: { type: 'string' } }, required: ['model'], run: commandOptions },
  select: { options: REQUEST_OPTIONS, required: ['model'], run: commandSelect },
  generate: { options: { ...REQUEST_OPTIONS, ...WAIT_OPTIONS }, required: ['model'], run: commandGenerate },
  download: { options: { model: { type: 'string' }, 'job-id': { type: 'string' }, ...WAIT_OPTIONS }, required: ['model', 'job-id'], run: commandDownload },
  frame: { options: { video: { type: 'string' }, position: { type: 'string', default: 'last' }, output: { type: 'string' } }, required: ['video', 'output'], run: commandFrame },
};

const USAGE = `usage: antseed_video.mjs [--proxy-url URL] {${Object.keys(COMMANDS).join(',')}} [options]

Discover, select, generate, and download Antseed videos. See SKILL.md for the workflow.`;

function invalid(message) {
  return new VideoError(message, 'invalid_arguments');
}

function parseInteger(name, raw, { min = 1 } = {}) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) throw invalid(`--${name} must be an integer.`);
  const value = Number(text);
  if (value < min) {
    throw name === 'duration' ? new VideoError('Duration must be a positive integer.', 'invalid_duration') : invalid(`--${name} must be at least ${min}.`);
  }
  return value;
}

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function parseCliArgs(argv, env = process.env) {
  const commandIndex = argv.findIndex((arg) => Object.hasOwn(COMMANDS, arg));
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (commandIndex < 0) throw invalid(`Choose a command: ${Object.keys(COMMANDS).join(', ')}.`);
  const name = argv[commandIndex];
  const command = COMMANDS[name];
  const { values, positionals } = parseArgs({
    args: [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)],
    options: { 'proxy-url': { type: 'string' }, ...command.options },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length) throw invalid(`Unexpected argument: ${positionals[0]}`);
  for (const key of command.required ?? []) {
    if (!values[key]) throw invalid(`--${key} is required for ${name}.`);
  }
  const args = { command: name, run: command.run };
  for (const [key, value] of Object.entries(values)) args[camel(key)] = value;
  args.proxyUrl = values['proxy-url'] ?? env.ANTSEED_PROXY_URL ?? DEFAULT_PROXY_URL;
  if (values.audio && values['no-audio']) throw invalid('Use either --audio or --no-audio.');
  args.audio = values.audio ? true : values['no-audio'] ? false : null;
  delete args.noAudio;
  if (name === 'generate' && Boolean(values.prompt) === Boolean(values['prompt-file'])) throw invalid('Use exactly one of --prompt or --prompt-file.');
  if ('prefer' in values && !['reputation', 'price'].includes(values.prefer)) throw invalid('--prefer must be reputation or price.');
  if ('position' in values && !['first', 'last'].includes(values.position)) throw invalid('--position must be first or last.');
  args.duration = parseInteger('duration', values.duration);
  if ('poll-interval' in values) args.pollInterval = parseInteger('poll-interval', values['poll-interval'], { min: 0 });
  if ('timeout' in values) args.timeout = parseInteger('timeout', values.timeout);
  if (args.autoDuration && args.duration != null) throw new VideoError('Use either --duration or --auto-duration.', 'invalid_duration');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) throw new VideoError(`Node.js ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}).`, 'node_too_old');
    let args;
    try {
      args = parseCliArgs(argv);
    } catch (error) {
      if (error instanceof VideoError) throw error;
      throw invalid(error.message);
    }
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    args.proxyUrl = proxyUrl(args.proxyUrl);
    emit(await args.run(args));
    return 0;
  } catch (error) {
    const videoError = error instanceof VideoError ? error : new VideoError(String(error?.message || error), 'file_error');
    emit({ ok: false, error: { code: videoError.code, message: videoError.message, ...videoError.details } });
    return 1;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.exitCode = await main();
}
