import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { createMp4Inspector, mp4MoovFacts, MP4_MAX_MOOV_BYTES, type Mp4Facts } from '@antseed/api-adapter';

/**
 * Checks of a video-to-video source (`video_url`) a seller runs before it
 * asks for payment: is it an MP4, how long is it, and does the declared
 * `duration` match it. Inline `data:` URLs are read in memory; https URLs are
 * read with a few small range requests (the box headers and `moov`), only
 * from public addresses, with byte and time caps, and nothing is kept.
 */

export interface VideoSourceFacts {
  /**
   * Length in milliseconds: the longer of the movie header (`mvhd`) and the
   * longest track, so a file edited to claim a shorter length is measured at
   * its real length.
   */
  durationMs: number;
  /** Size of the file in bytes, when known. */
  sizeBytes?: number;
  /** First video track's display size and frame rate, when readable. */
  width?: number;
  height?: number;
  fps?: number;
}

/** Facts of a parsed MP4 as a source measurement. */
function sourceFacts(facts: Mp4Facts, sizeBytes: number): VideoSourceFacts {
  return {
    durationMs: Math.max(facts.durationMs, facts.trackDurationMs ?? 0),
    sizeBytes,
    ...(facts.video?.width ? { width: facts.video.width } : {}),
    ...(facts.video?.height ? { height: facts.video.height } : {}),
    ...(facts.video?.fps ? { fps: facts.video.fps } : {}),
  };
}

export class VideoSourceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface MeasureVideoSourceOptions {
  /** Largest source file accepted, in bytes. */
  maxBytes?: number;
  /** Time limit for reading a URL source. Default 10 s. */
  timeoutMs?: number;
  /** For tests only: allow loopback and private addresses. */
  allowPrivateNetwork?: boolean;
  /** For tests only: allow plain http URLs. */
  allowHttp?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** A server without range support streams the whole file; read at most this much. */
const MAX_FULL_READ_BYTES = 64 * 1024 * 1024;
const FIRST_READ_BYTES = 64 * 1024;
const MAX_RANGE_REQUESTS = 16;
const MAX_REDIRECTS = 3;
const MAX_TOP_LEVEL_BOXES = 1000;
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9.+-]+=[^;,]*)*);base64,/i;
/** Inline source types the upstreams read as MP4/MOV. */
const VIDEO_MIME = /^video\/(mp4|quicktime|x-m4v)$/i;

const invalidSource = (message = 'The source video must be an MP4 or MOV file whose first box is ftyp and whose moov box is readable') =>
  new VideoSourceError(400, 'invalid_video_source', message);

const tooLarge = (sizeBytes: number, maxBytes: number) => new VideoSourceError(
  413, 'video_source_too_large',
  `The source video is ${formatMb(sizeBytes)}; this model takes at most ${formatMb(maxBytes)}`,
);

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Whether an address is reachable on the public internet (not loopback, private, link-local, ...). */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 192 && b === 2)
      || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return false;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const embedded = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): judge the embedded IPv4.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
      return g5 === 0xffff && isPublicIpAddress(embedded(g6, g7));
    }
    // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64, 100::/64 discard, 2001::/23 IETF (Teredo, benchmarking...),
    // 2001:db8::/32 documentation, 2002::/16 6to4 (embeds an IPv4 that may be private).
    if (g0 === 0x64 && g1 === 0xff9b) return false;
    if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false;
    if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
    if (g0 === 0x2002) return false;
    // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local, ff00::/8 multicast.
    if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00) return false;
    // Only global unicast (2000::/3) is public.
    return (g0 & 0xe000) === 0x2000;
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address (with an optional embedded IPv4 tail), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0]!;
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const bytes = v4.slice(1).map(Number);
    if (bytes.some(byte => byte > 255)) return null;
    text = `${text.slice(0, v4.index)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => part === '' ? [] : part.split(':').map(group => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some(Number.isNaN) ? null : groups;
}

/** Measures the source video given as a `data:` URL or an http(s) URL. */
export async function measureVideoSource(source: string, options: MeasureVideoSourceOptions = {}): Promise<VideoSourceFacts> {
  if (source.startsWith('data:')) return measureDataUrl(source, options.maxBytes);
  return measureUrl(source, options);
}

function measureDataUrl(source: string, maxBytes?: number): VideoSourceFacts {
  const match = source.slice(0, 256).match(DATA_URL);
  if (!match) throw invalidSource('An inline source video must be a base64 data URL');
  if (!VIDEO_MIME.test(match[1] ?? '')) throw invalidSource('An inline source video must be a data:video/mp4 (or data:video/quicktime) URL');
  const bytes = Buffer.from(source.slice(match[0].length), 'base64');
  if (maxBytes !== undefined && bytes.length > maxBytes) throw tooLarge(bytes.length, maxBytes);
  const inspector = createMp4Inspector();
  inspector.update(bytes);
  const facts = inspector.finish();
  if (!facts) throw invalidSource();
  return sourceFacts(facts, bytes.length);
}

interface RangeResponse {
  status: number;
  total?: number;
  start?: number;
  stream: IncomingMessage;
}

async function measureUrl(source: string, options: MeasureVideoSourceOptions): Promise<VideoSourceFacts> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalidSource('The source video must be a data URL or an https URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let requests = 0;
  let current = url;
  const get = async (start: number, end: number): Promise<RangeResponse> => {
    if (++requests > MAX_RANGE_REQUESTS) throw invalidSource('The source video has too many top-level boxes to read');
    let target = current;
    for (let redirect = 0; ; redirect += 1) {
      const response = await openRequest(target, `bytes=${start}-${end}`, controller.signal, options);
      const location = response.headers.location;
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.destroy();
        if (redirect >= MAX_REDIRECTS) throw new VideoSourceError(400, 'video_source_unavailable', 'The source video URL redirects too many times');
        target = new URL(location, target);
        continue;
      }
      current = target;
      const range = String(response.headers['content-range'] ?? '').match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
      const length = Number(response.headers['content-length']);
      return {
        status: response.statusCode ?? 0,
        ...(range ? { start: Number(range[1]) } : {}),
        ...(range && range[3] !== '*' ? { total: Number(range[3]) } : response.statusCode === 200 && Number.isSafeInteger(length) ? { total: length } : {}),
        stream: response,
      };
    }
  };
  try {
    const first = await get(0, FIRST_READ_BYTES - 1);
    if (first.status === 200) return await measureFullResponse(first, options.maxBytes);
    if (first.status !== 206 || first.start !== 0) {
      first.stream.destroy();
      throw new VideoSourceError(400, 'video_source_unavailable', `The source video URL answered HTTP ${first.status}`);
    }
    const total = first.total;
    if (total === undefined) {
      first.stream.destroy();
      throw new VideoSourceError(400, 'video_source_unavailable', 'The source video URL does not say how large the file is');
    }
    if (options.maxBytes !== undefined && total > options.maxBytes) {
      first.stream.destroy();
      throw tooLarge(total, options.maxBytes);
    }
    const head = await readAll(first.stream, FIRST_READ_BYTES);
    const read = async (start: number, length: number): Promise<Buffer> => {
      if (start + length <= head.length) return head.subarray(start, start + length);
      const response = await get(start, start + length - 1);
      if (response.status !== 206 || response.start !== start) {
        response.stream.destroy();
        throw new VideoSourceError(400, 'video_source_unavailable', 'The source video URL does not answer range requests consistently');
      }
      return readAll(response.stream, length);
    };
    let offset = 0;
    for (let boxes = 0; offset + 8 <= total && boxes < MAX_TOP_LEVEL_BOXES; boxes += 1) {
      const header = await read(offset, Math.min(16, total - offset));
      if (header.length < 8) break;
      const size32 = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxes === 0 && type !== 'ftyp') throw invalidSource();
      const headerSize = size32 === 1 ? 16 : 8;
      if (header.length < headerSize) break;
      const size = size32 === 1 ? Number(header.readBigUInt64BE(8)) : size32 === 0 ? total - offset : size32;
      if (!Number.isSafeInteger(size) || size < headerSize || offset + size > total) throw invalidSource();
      if (type === 'moov') {
        if (size - headerSize > MP4_MAX_MOOV_BYTES) throw invalidSource('The source video moov box is too large to read');
        const body = await read(offset + headerSize, size - headerSize);
        const facts = mp4MoovFacts(body);
        if (!facts) throw invalidSource();
        return sourceFacts(facts, total);
      }
      offset += size;
    }
    throw invalidSource();
  } catch (cause) {
    if (cause instanceof VideoSourceError) throw cause;
    if (controller.signal.aborted) throw new VideoSourceError(400, 'video_source_unavailable', 'Reading the source video URL timed out');
    throw new VideoSourceError(400, 'video_source_unavailable', 'Could not read the source video URL');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function measureFullResponse(response: RangeResponse, maxBytes?: number): Promise<VideoSourceFacts> {
  const cap = Math.min(maxBytes ?? MAX_FULL_READ_BYTES, MAX_FULL_READ_BYTES);
  if (response.total !== undefined && response.total > cap) {
    response.stream.destroy();
    if (maxBytes !== undefined && response.total > maxBytes) throw tooLarge(response.total, maxBytes);
    throw new VideoSourceError(413, 'video_source_too_large', `The source video URL does not support range requests, so it must be at most ${formatMb(cap)}`);
  }
  const inspector = createMp4Inspector();
  let received = 0;
  for await (const chunk of response.stream as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > cap) {
      response.stream.destroy();
      throw new VideoSourceError(413, 'video_source_too_large', `The source video URL does not support range requests, so it must be at most ${formatMb(cap)}`);
    }
    inspector.update(chunk);
  }
  const facts = inspector.finish();
  if (!facts) throw invalidSource();
  return sourceFacts(facts, received);
}

async function readAll(stream: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    received += chunk.length;
    if (received > limit) {
      stream.destroy();
      throw new VideoSourceError(400, 'video_source_unavailable', 'The source video URL sent more bytes than requested');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Refuses a URL the seller would never fetch: not https (or http in tests), or with credentials. */
function checkSourceUrl(url: URL, options: MeasureVideoSourceOptions): void {
  const secure = url.protocol === 'https:';
  if ((!secure && !(options.allowHttp && url.protocol === 'http:')) || url.username || url.password) {
    throw invalidSource('The source video must be a data URL or an https URL without credentials');
  }
}

/** Checks a source's form without reading it: a video data URL, or an https URL. */
export function checkVideoSourceForm(source: string, options: MeasureVideoSourceOptions = {}): void {
  if (source.startsWith('data:')) {
    const match = source.slice(0, 256).match(DATA_URL);
    if (!match) throw invalidSource('An inline source video must be a base64 data URL');
    if (!VIDEO_MIME.test(match[1] ?? '')) throw invalidSource('An inline source video must be a data:video/mp4 (or data:video/quicktime) URL');
    return;
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalidSource('The source video must be a data URL or an https URL');
  }
  checkSourceUrl(url, options);
}

async function openRequest(url: URL, range: string, signal: AbortSignal, options: MeasureVideoSourceOptions): Promise<IncomingMessage> {
  checkSourceUrl(url, options);
  const secure = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || (!options.allowPrivateNetwork && addresses.some(({ address }) => !isPublicIpAddress(address)))) {
    throw new VideoSourceError(400, 'video_source_unavailable', 'The source video URL must point to a public address');
  }
  const { address, family } = addresses[0]!;
  const request = secure ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      signal,
      headers: { range, 'accept-encoding': 'identity', 'user-agent': 'AntSeed-video-check/1' },
      // Connect to the address that was checked, so DNS can't change in between.
      lookup: (_hostname, lookupOptions, callback) => {
        if ((lookupOptions as { all?: boolean }).all) (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** What a seller checks about a video-to-video request before payment. */
export interface VideoSourceRule {
  /** Shortest and longest source the upstream accepts, in seconds. */
  minSeconds?: number;
  maxSeconds?: number;
  /** Largest source file the upstream accepts, in bytes. */
  maxBytes?: number;
  /** Size, aspect ratio (width / height) and frame rate limits of the source's video track. */
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  minAspectRatio?: number;
  maxAspectRatio?: number;
  minFps?: number;
  maxFps?: number;
  /**
   * The output is as long as the source, so the declared `duration` (what
   * the buyer pays for) must be the source length rounded down.
   */
  durationMatchesSource: boolean;
  /**
   * The model cuts its output to `duration` but can't make it longer than the
   * source, so a longer `duration` would be paid for and never delivered.
   */
  durationAtMostSource?: boolean;
}

export interface VideoSourcePrecheckOptions {
  /** URL sources one buyer may have checked per minute. Default 20. */
  maxUrlChecksPerBuyerPerMinute?: number;
  /** URL sources checked at once. Default 4. */
  maxConcurrentUrlChecks?: number;
  measure?: (source: string, options: MeasureVideoSourceOptions) => Promise<VideoSourceFacts>;
  measureOptions?: Omit<MeasureVideoSourceOptions, 'maxBytes'>;
}

const RESULT_TTL_MS = 10 * 60_000;

/** Why the source's size, aspect ratio or frame rate is outside the model's limits, or null. */
export function shapeProblem(facts: VideoSourceFacts, rule: VideoSourceRule): string | null {
  const { width, height, fps } = facts;
  const size = width && height ? `${width}x${height}` : undefined;
  const needsSize = rule.minWidth ?? rule.minHeight ?? rule.maxWidth ?? rule.maxHeight ?? rule.minAspectRatio ?? rule.maxAspectRatio;
  if (needsSize !== undefined && !size) return 'Could not read the source video\'s size; re-encode it as H.264 MP4';
  if (size && width && height) {
    if ((rule.minWidth && width < rule.minWidth) || (rule.minHeight && height < rule.minHeight)) {
      return `The source video is ${size}; this model needs at least ${rule.minWidth ?? 1}x${rule.minHeight ?? 1} (scale it up, for example with ffmpeg -vf scale)`;
    }
    if ((rule.maxWidth && width > rule.maxWidth) || (rule.maxHeight && height > rule.maxHeight)) {
      return `The source video is ${size}; this model takes at most ${rule.maxWidth ?? '-'}x${rule.maxHeight ?? '-'}`;
    }
    const ratio = width / height;
    if ((rule.minAspectRatio && ratio < rule.minAspectRatio - 0.005) || (rule.maxAspectRatio && ratio > rule.maxAspectRatio + 0.005)) {
      return `The source video is ${size} (aspect ratio ${ratio.toFixed(2)}); this model takes ${rule.minAspectRatio ?? 0} to ${rule.maxAspectRatio ?? '∞'}`;
    }
  }
  if (fps !== undefined && ((rule.minFps && fps < rule.minFps) || (rule.maxFps && fps > rule.maxFps))) {
    return `The source video is ${fps} fps; this model takes ${rule.minFps ?? 0} to ${rule.maxFps ?? '∞'} fps (re-encode it, for example with ffmpeg -r 24)`;
  }
  return null;
}
const MAX_RESULTS = 500;

function errorResponse(request: SerializedHttpRequest, statusCode: number, code: string, message: string): SerializedHttpResponse {
  return {
    requestId: request.requestId,
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify({ error: { code, message } })),
  };
}

/**
 * Builds the seller's check of a request's source video. The result is kept
 * for each request (its id and body), because the buyer sends the same
 * request again after opening the payment channel.
 */
export function createVideoSourcePrecheck(options: VideoSourcePrecheckOptions = {}) {
  const measure = options.measure ?? measureVideoSource;
  const perBuyer = options.maxUrlChecksPerBuyerPerMinute ?? 20;
  const maxConcurrent = options.maxConcurrentUrlChecks ?? 4;
  const results = new Map<string, { at: number; response: SerializedHttpResponse | null }>();
  const recent = new Map<string, number[]>();
  let active = 0;

  return async function precheck(
    request: SerializedHttpRequest,
    buyerPeerId: string | undefined,
    source: string,
    declaredSeconds: number | undefined,
    rule: VideoSourceRule,
  ): Promise<SerializedHttpResponse | null> {
    const now = Date.now();
    const key = `${request.requestId}:${createHash('sha256').update(request.body).digest('hex')}`;
    const cached = results.get(key);
    if (cached && now - cached.at < RESULT_TTL_MS) {
      return cached.response ? { ...cached.response, requestId: request.requestId } : null;
    }

    try {
      checkVideoSourceForm(source, options.measureOptions);
    } catch (cause) {
      if (cause instanceof VideoSourceError) return errorResponse(request, cause.statusCode, cause.code, cause.message);
      throw cause;
    }
    const isUrl = !source.startsWith('data:');
    if (isUrl) {
      const buyer = (buyerPeerId ?? 'unknown').toLowerCase();
      const times = (recent.get(buyer) ?? []).filter(at => now - at < 60_000);
      if (times.length >= perBuyer || active >= maxConcurrent) {
        recent.set(buyer, times);
        return errorResponse(request, 429, 'video_check_busy', 'Too many source videos are being checked; try again in a minute');
      }
      times.push(now);
      recent.set(buyer, times);
      active += 1;
    }
    let response: SerializedHttpResponse | null = null;
    try {
      const facts = await measure(source, { ...options.measureOptions, ...(rule.maxBytes !== undefined ? { maxBytes: rule.maxBytes } : {}) });
      const seconds = facts.durationMs / 1000;
      const shown = seconds.toFixed(2);
      if ((rule.minSeconds !== undefined && seconds < rule.minSeconds) || (rule.maxSeconds !== undefined && seconds > rule.maxSeconds)) {
        const range = rule.minSeconds !== undefined && rule.maxSeconds !== undefined
          ? `${rule.minSeconds} to ${rule.maxSeconds} s`
          : rule.minSeconds !== undefined ? `at least ${rule.minSeconds} s` : `at most ${rule.maxSeconds} s`;
        response = errorResponse(request, 400, 'invalid_video_source', `The source video is ${shown} s long; this model takes a source of ${range}`);
      } else if (shapeProblem(facts, rule)) {
        response = errorResponse(request, 400, 'invalid_video_source', shapeProblem(facts, rule)!);
      } else if (rule.durationMatchesSource) {
        const expected = Math.max(1, Math.floor(seconds));
        if (declaredSeconds !== expected) {
          response = errorResponse(request, 400, 'invalid_video_duration',
            `The output is as long as the source video (${shown} s), so send "duration": ${expected} (the source length in whole seconds, rounded down)`);
        }
      } else if (rule.durationAtMostSource && declaredSeconds !== undefined && declaredSeconds > Math.max(1, Math.floor(seconds))) {
        response = errorResponse(request, 400, 'invalid_video_duration',
          `The output can't be longer than the source video (${shown} s); send a "duration" of at most ${Math.max(1, Math.floor(seconds))}`);
      }
    } catch (cause) {
      response = cause instanceof VideoSourceError
        ? errorResponse(request, cause.statusCode, cause.code, cause.message)
        : errorResponse(request, 400, 'invalid_video_source', 'Could not read the source video');
    } finally {
      if (isUrl) active -= 1;
    }
    // A busy or unreachable source may work later, so only firm answers are kept.
    if (!response || response.statusCode !== 429) {
      results.set(key, { at: now, response });
      for (const [entry, value] of results) {
        if (results.size <= MAX_RESULTS && now - value.at < RESULT_TTL_MS) break;
        results.delete(entry);
      }
    }
    return response;
  };
}
