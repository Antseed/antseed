import { randomBytes, randomInt } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { ResponseAuthPayload } from '../types/protocol.js';
import { encodeHttpRequest, encodeHttpResponse } from '../proxy/request-codec.js';

const SAMPLE_RANDOM_SCALE = 1_000_000;
const DEFAULT_SAMPLE_RATE = 0.005;
const DEFAULT_MAX_SAMPLE_BYTES = 16 * 1024 * 1024;
/**
 * No code reads a sample back yet. A sample is self-contained evidence (its
 * manifest carries the signed ResponseAuth) kept for a later audit or dispute
 * exhibit, so a week is kept, bounded by total size and count: a busy buyer
 * keeps a recent window rather than an ever-growing archive.
 */
const DEFAULT_SAMPLE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_TOTAL_SAMPLE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_SAMPLE_COUNT = 10_000;
/**
 * A sample directory without manifest.json is a write the process never
 * finished. A write takes milliseconds, so one this old is abandoned.
 */
const INCOMPLETE_SAMPLE_GRACE_MS = 60 * 60_000;
const MANIFEST_FILE = 'manifest.json';

export interface VerificationSampleConfig {
  sampleRate?: number;
  maxSampleBytes?: number;
  /** `prune()` deletes samples older than this. 0 keeps samples of any age. Default: 7 days. */
  sampleRetentionMs?: number;
  /** `prune()` deletes the oldest samples while all of them together exceed this. 0 = no limit. Default: 1 GiB. */
  maxTotalSampleBytes?: number;
  /** `prune()` deletes the oldest samples while there are more than this. 0 = no limit. Default: 10,000. */
  maxSampleCount?: number;
  random?: () => number;
}

export interface VerificationSamplePruneResult {
  deletedSamples: number;
  deletedBytes: number;
  keptSamples: number;
  keptBytes: number;
}

export interface ResponseAuthSampleInput {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  responseAuth: ResponseAuthPayload;
  verified: boolean;
  verificationError: string | null;
}

export interface StoredVerificationSample {
  sampleId: string;
  directory: string;
  savedAt: number;
}

export class VerificationSampler {
  private readonly _samplesDir: string;
  private readonly _sampleRate: number;
  private readonly _maxSampleBytes: number;
  private readonly _retentionMs: number;
  private readonly _maxTotalBytes: number;
  private readonly _maxCount: number;
  private readonly _random: () => number;

  constructor(samplesDir: string, config: VerificationSampleConfig = {}) {
    this._samplesDir = samplesDir;
    this._sampleRate = normalizeSampleRate(config.sampleRate ?? DEFAULT_SAMPLE_RATE);
    this._maxSampleBytes = Math.max(1, config.maxSampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES);
    this._retentionMs = normalizeLimit(config.sampleRetentionMs, DEFAULT_SAMPLE_RETENTION_MS);
    this._maxTotalBytes = normalizeLimit(config.maxTotalSampleBytes, DEFAULT_MAX_TOTAL_SAMPLE_BYTES);
    this._maxCount = normalizeLimit(config.maxSampleCount, DEFAULT_MAX_SAMPLE_COUNT);
    this._random = config.random ?? cryptoRandomFloat;
  }

  shouldSample(): boolean {
    if (this._sampleRate <= 0) return false;
    if (this._sampleRate >= 1) return true;
    return this._random() < this._sampleRate;
  }

  async maybeStoreResponseAuthSample(input: ResponseAuthSampleInput): Promise<StoredVerificationSample | null> {
    if (!input.verified) return null;
    if (input.response.streamedBody) return null;
    if (!this.shouldSample()) return null;

    const requestBytes = encodeHttpRequest(input.request);
    const responseBytes = encodeHttpResponse(input.response);
    const combinedBytes = requestBytes.byteLength + responseBytes.byteLength;
    if (combinedBytes > this._maxSampleBytes) {
      return null;
    }

    const savedAt = Date.now();
    const sampleId = sampleIdFor(input.responseAuth);
    const directory = join(this._samplesDir, input.responseAuth.sellerPeerId, sampleId);
    await mkdir(directory, { recursive: true });

    const manifest: VerificationSampleManifest = {
      version: 1,
      savedAt,
      requestId: input.responseAuth.requestId,
      buyerPeerId: input.responseAuth.buyerPeerId,
      sellerPeerId: input.responseAuth.sellerPeerId,
      advertisedService: input.responseAuth.advertisedService,
      provider: input.responseAuth.provider,
      statusCode: input.responseAuth.statusCode,
      requestHash: input.responseAuth.requestHash,
      responseHash: input.responseAuth.responseHash,
      responseStartedAt: input.responseAuth.responseStartedAt,
      responseCompletedAt: input.responseAuth.responseCompletedAt,
      verified: input.verified,
      verificationError: input.verificationError,
      responseAuth: input.responseAuth,
      files: {
        request: 'request.bin',
        response: 'response.bin',
        encoding: 'antseed-http-codec-v1',
      },
    };

    await writeFileAtomic(join(directory, 'request.bin'), requestBytes);
    await writeFileAtomic(join(directory, 'response.bin'), responseBytes);
    // The manifest is the completion marker. Readers should ignore sample
    // directories without manifest.json because the process may have stopped
    // between evidence writes.
    await writeFileAtomic(
      join(directory, 'manifest.json'),
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );

    return { sampleId, directory, savedAt };
  }

  /**
   * Deletes samples past the retention age, abandoned writes (no manifest.json)
   * past a short grace, and then the oldest samples while the rest exceed the
   * total byte or count limit. A sample's age is its directory's mtime, which
   * the manifest's rename sets when the sample completes. All file work is
   * async and one operation at a time, so a large directory never holds the
   * event loop or fills libuv's thread pool. Stops early when `signal` aborts.
   */
  async prune(options: { now?: number; signal?: AbortSignal } = {}): Promise<VerificationSamplePruneResult> {
    const now = options.now ?? Date.now();
    const { samples, sellerDirs } = await scanSamples(this._samplesDir, options.signal);
    const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);

    const ageCutoff = this._retentionMs > 0 ? now - this._retentionMs : -Infinity;
    const incompleteCutoff = now - (this._retentionMs > 0
      ? Math.min(this._retentionMs, INCOMPLETE_SAMPLE_GRACE_MS)
      : INCOMPLETE_SAMPLE_GRACE_MS);
    const doomed: ScannedSample[] = [];
    const kept: ScannedSample[] = [];
    for (const sample of samples.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const expired = sample.mtimeMs < ageCutoff || (!sample.complete && sample.mtimeMs < incompleteCutoff);
      (expired ? doomed : kept).push(sample);
    }
    // Over a limit: the oldest of the rest go too.
    let keptBytes = totalBytes - doomed.reduce((sum, sample) => sum + sample.bytes, 0);
    let keptCount = kept.length;
    for (const sample of kept) {
      const overBytes = this._maxTotalBytes > 0 && keptBytes > this._maxTotalBytes;
      const overCount = this._maxCount > 0 && keptCount > this._maxCount;
      if (!overBytes && !overCount) break;
      doomed.push(sample);
      keptBytes -= sample.bytes;
      keptCount -= 1;
    }

    let deletedSamples = 0;
    let deletedBytes = 0;
    for (const sample of doomed) {
      if (options.signal?.aborted) break;
      try {
        await rm(sample.path, { recursive: true, force: true });
        deletedSamples += 1;
        deletedBytes += sample.bytes;
      } catch {
        // Left for the next run.
      }
    }

    // A seller directory nothing was written to within the grace is removed
    // once it is empty. rmdir fails on a directory that is not empty, so a
    // sample written meanwhile is never lost.
    for (const sellerDir of sellerDirs) {
      if (options.signal?.aborted) break;
      if (sellerDir.mtimeMs >= incompleteCutoff) continue;
      await rmdir(sellerDir.path).catch(() => {});
    }
    return {
      deletedSamples,
      deletedBytes,
      keptSamples: samples.length - deletedSamples,
      keptBytes: totalBytes - deletedBytes,
    };
  }
}

interface ScannedSample {
  path: string;
  mtimeMs: number;
  bytes: number;
  complete: boolean;
}

interface ScannedSellerDir {
  path: string;
  mtimeMs: number;
}

/**
 * Lists `<samplesDir>/<sellerPeerId>/<sampleId>/` directories with their mtime,
 * total file size and whether manifest.json exists. Entries that vanish or
 * cannot be read mid-scan are skipped, and symlinks are never followed.
 */
async function scanSamples(
  samplesDir: string,
  signal?: AbortSignal,
): Promise<{ samples: ScannedSample[]; sellerDirs: ScannedSellerDir[] }> {
  const samples: ScannedSample[] = [];
  const sellerDirs: ScannedSellerDir[] = [];
  const sellers = await readdir(samplesDir, { withFileTypes: true }).catch(() => []);
  for (const seller of sellers) {
    if (signal?.aborted) break;
    if (!seller.isDirectory()) continue;
    const sellerPath = join(samplesDir, seller.name);
    const sellerStat = await stat(sellerPath).catch(() => null);
    if (!sellerStat) continue;
    sellerDirs.push({ path: sellerPath, mtimeMs: sellerStat.mtimeMs });
    const entries = await readdir(sellerPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (!entry.isDirectory()) continue;
      const sample = await scanSample(join(sellerPath, entry.name));
      if (sample) samples.push(sample);
    }
  }
  return { samples, sellerDirs };
}

async function scanSample(path: string): Promise<ScannedSample | null> {
  try {
    const { mtimeMs } = await stat(path);
    let bytes = 0;
    let complete = false;
    for (const name of await readdir(path)) {
      if (name === MANIFEST_FILE) complete = true;
      bytes += await lstat(join(path, name)).then((file) => file.size, () => 0);
    }
    return { path, mtimeMs, bytes, complete };
  } catch {
    return null;
  }
}

interface VerificationSampleManifest {
  version: 1;
  savedAt: number;
  requestId: string;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  provider: string;
  statusCode: number;
  requestHash: string;
  responseHash: string;
  responseStartedAt: number;
  responseCompletedAt: number;
  verified: boolean;
  verificationError: string | null;
  responseAuth: ResponseAuthPayload;
  files: {
    request: string;
    response: string;
    encoding: 'antseed-http-codec-v1';
  };
}

function sampleIdFor(payload: ResponseAuthPayload): string {
  return `${sanitizePathSegment(payload.requestId)}-${payload.requestHash.slice(2, 18)}`;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
  return sanitized.length > 0 ? sanitized : 'sample';
}

function normalizeSampleRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SAMPLE_RATE;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** A configured limit: 0 turns it off; a missing, negative or non-finite value takes the default. */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function cryptoRandomFloat(): number {
  return randomInt(0, SAMPLE_RANDOM_SCALE) / SAMPLE_RANDOM_SCALE;
}

async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
