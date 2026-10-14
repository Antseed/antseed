import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { ResponseAuthPayload } from '../types/protocol.js';
import { encodeHttpRequest, encodeHttpResponse } from '../proxy/request-codec.js';

const SAMPLE_RANDOM_SCALE = 1_000_000;
const DEFAULT_SAMPLE_RATE = 0.005;
const DEFAULT_MAX_SAMPLE_BYTES = 16 * 1024 * 1024;

export interface VerificationSampleConfig {
  sampleRate?: number;
  maxSampleBytes?: number;
  random?: () => number;
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
  private readonly _random: () => number;

  constructor(samplesDir: string, config: VerificationSampleConfig = {}) {
    this._samplesDir = samplesDir;
    this._sampleRate = normalizeSampleRate(config.sampleRate ?? DEFAULT_SAMPLE_RATE);
    this._maxSampleBytes = Math.max(1, config.maxSampleBytes ?? DEFAULT_MAX_SAMPLE_BYTES);
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

function cryptoRandomFloat(): number {
  return randomInt(0, SAMPLE_RANDOM_SCALE) / SAMPLE_RANDOM_SCALE;
}

async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
