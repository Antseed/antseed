import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import {
  createResponseAuthPayload,
  VerificationSampler,
  VerificationStorage,
  type StoredResponseAuth,
} from '../src/verification/index.js';
import { VerificationRetention } from '../src/verification/retention.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 15);
const SELLER = '22'.repeat(20);

const directories: string[] = [];
function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function record(requestId: string, receivedAt: number, preimages = false): StoredResponseAuth {
  return {
    version: 1,
    requestId,
    buyerPeerId: '11'.repeat(20),
    sellerPeerId: SELLER,
    advertisedService: 'model-a',
    provider: 'test',
    statusCode: 200,
    requestHash: `0x${'33'.repeat(32)}`,
    responseHash: `0x${'44'.repeat(32)}`,
    responseStartedAt: receivedAt - 2,
    responseCompletedAt: receivedAt - 1,
    signature: `0x${'55'.repeat(65)}`,
    receivedAt,
    verified: true,
    verificationError: null,
    requestPreimage: preimages ? new Uint8Array(4096).fill(1) : null,
    responsePreimage: preimages ? new Uint8Array(4096).fill(2) : null,
  };
}

/** A sample directory as the sampler leaves it; `complete: false` is a write that stopped before the manifest. */
function writeSample(samplesDir: string, sampleId: string, mtimeMs: number, options: { bytes?: number; complete?: boolean; seller?: string } = {}): string {
  const directory = join(samplesDir, options.seller ?? SELLER, sampleId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.bin'), Buffer.alloc(options.bytes ?? 100, 1));
  if (options.complete !== false) {
    writeFileSync(join(directory, 'response.bin'), Buffer.alloc(options.bytes ?? 100, 2));
    writeFileSync(join(directory, 'manifest.json'), '{}');
  }
  const time = new Date(mtimeMs);
  utimesSync(directory, time, time);
  return directory;
}

function sampleIds(samplesDir: string, seller = SELLER): string[] {
  const sellerDir = join(samplesDir, seller);
  return existsSync(sellerDir) ? readdirSync(sellerDir).sort() : [];
}

describe('VerificationStorage.pruneResponseAuthsOlderThan', () => {
  it('deletes rows received before the cutoff in batches and keeps recent ones', async () => {
    const storage = new VerificationStorage(join(tempDir('verification-prune-'), 'verification.db'));
    try {
      for (let i = 0; i < 7; i++) storage.insertResponseAuth(record(`old-${i}`, NOW - 2 * DAY - i, i % 2 === 0));
      storage.insertResponseAuth(record('recent-1', NOW - HOUR, true));
      storage.insertResponseAuth(record('recent-2', NOW));

      const deleted = await storage.pruneResponseAuthsOlderThan(NOW - DAY, { batchSize: 3 });

      expect(deleted).toBe(7);
      for (let i = 0; i < 7; i++) expect(storage.getResponseAuth(`old-${i}`)).toBeNull();
      expect(storage.getResponseAuth('recent-1')?.requestPreimage?.length).toBe(4096);
      expect(storage.getResponseAuth('recent-2')).not.toBeNull();
      expect(storage.listResponseAuthsBySeller(SELLER).map((row) => row.requestId)).toEqual(['recent-2', 'recent-1']);
    } finally {
      storage.close();
    }
  });

  it('walks the received_at index instead of scanning the table', () => {
    const storage = new VerificationStorage(join(tempDir('verification-prune-plan-'), 'verification.db'));
    try {
      const db = (storage as unknown as { _db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ detail: string }> } } })._db;
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT rowid FROM response_auths WHERE received_at < ? ORDER BY received_at LIMIT ?')
        .all(NOW, 10)
        .map((row) => row.detail)
        .join('\n');
      expect(plan).toContain('idx_response_auths_received');
    } finally {
      storage.close();
    }
  });

  it('stops between batches once aborted', async () => {
    const storage = new VerificationStorage(join(tempDir('verification-prune-abort-'), 'verification.db'));
    try {
      for (let i = 0; i < 6; i++) storage.insertResponseAuth(record(`old-${i}`, NOW - 2 * DAY + i));
      const abort = new AbortController();
      const pruning = storage.pruneResponseAuthsOlderThan(NOW - DAY, { batchSize: 2, signal: abort.signal });
      abort.abort();
      expect(await pruning).toBe(2);
      expect(storage.getResponseAuth('old-0')).toBeNull();
      expect(storage.getResponseAuth('old-5')).not.toBeNull();
    } finally {
      storage.close();
    }
  });
});

describe('VerificationSampler.prune', () => {
  it('deletes samples past the retention age and keeps recent ones', async () => {
    const samplesDir = tempDir('verification-samples-prune-');
    writeSample(samplesDir, 'old', NOW - 8 * DAY);
    writeSample(samplesDir, 'recent', NOW - 6 * DAY);

    const result = await new VerificationSampler(samplesDir).prune({ now: NOW });

    expect(sampleIds(samplesDir)).toEqual(['recent']);
    expect(result).toEqual({ deletedSamples: 1, deletedBytes: 202, keptSamples: 1, keptBytes: 202 });
  });

  it('deletes the oldest samples first above the count limit', async () => {
    const samplesDir = tempDir('verification-samples-count-');
    for (let i = 0; i < 5; i++) writeSample(samplesDir, `s${i}`, NOW - (5 - i) * HOUR, { seller: i % 2 === 0 ? SELLER : '33'.repeat(20) });

    const result = await new VerificationSampler(samplesDir, { maxSampleCount: 3 }).prune({ now: NOW });

    expect(result.deletedSamples).toBe(2);
    expect([...sampleIds(samplesDir), ...sampleIds(samplesDir, '33'.repeat(20))].sort()).toEqual(['s2', 's3', 's4']);
  });

  it('deletes the oldest samples first above the total byte limit', async () => {
    const samplesDir = tempDir('verification-samples-bytes-');
    for (let i = 0; i < 4; i++) writeSample(samplesDir, `s${i}`, NOW - (4 - i) * HOUR, { bytes: 1000 });

    // Each sample is 2,002 bytes: room for two.
    const result = await new VerificationSampler(samplesDir, { maxTotalSampleBytes: 5000 }).prune({ now: NOW });

    expect(sampleIds(samplesDir)).toEqual(['s2', 's3']);
    expect(result).toEqual({ deletedSamples: 2, deletedBytes: 4004, keptSamples: 2, keptBytes: 4004 });
  });

  it('deletes an abandoned write without manifest.json once old, and keeps one still being written', async () => {
    const samplesDir = tempDir('verification-samples-incomplete-');
    writeSample(samplesDir, 'abandoned', NOW - 2 * HOUR, { complete: false });
    writeSample(samplesDir, 'writing', NOW - 1000, { complete: false });
    writeSample(samplesDir, 'complete', NOW - 2 * HOUR);

    await new VerificationSampler(samplesDir).prune({ now: NOW });

    expect(sampleIds(samplesDir)).toEqual(['complete', 'writing']);
  });

  it('keeps everything with every limit set to 0, except abandoned writes', async () => {
    const samplesDir = tempDir('verification-samples-unlimited-');
    writeSample(samplesDir, 'ancient', NOW - 365 * DAY);
    writeSample(samplesDir, 'abandoned', NOW - 2 * HOUR, { complete: false });
    writeSample(samplesDir, 'recent', NOW);

    await new VerificationSampler(samplesDir, { sampleRetentionMs: 0, maxTotalSampleBytes: 0, maxSampleCount: 0 }).prune({ now: NOW });

    expect(sampleIds(samplesDir)).toEqual(['ancient', 'recent']);
  });

  it('removes a seller directory left empty, and tolerates a missing samples directory', async () => {
    const samplesDir = tempDir('verification-samples-seller-');
    writeSample(samplesDir, 'old', NOW - 8 * DAY);
    const old = new Date(NOW - 8 * DAY);
    utimesSync(join(samplesDir, SELLER), old, old);

    await new VerificationSampler(samplesDir).prune({ now: NOW });
    expect(readdirSync(samplesDir)).toEqual([]);

    const missing = await new VerificationSampler(join(samplesDir, 'missing')).prune({ now: NOW });
    expect(missing).toEqual({ deletedSamples: 0, deletedBytes: 0, keptSamples: 0, keptBytes: 0 });
  });

  it('ages a sample the sampler wrote from when it was saved', async () => {
    const samplesDir = tempDir('verification-samples-real-');
    const seller = identityFromPrivateKeyHex('11'.repeat(32));
    const buyer = identityFromPrivateKeyHex('22'.repeat(32));
    const request: SerializedHttpRequest = {
      requestId: 'req-retention-1', method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"model":"model-a"}'),
    };
    const response: SerializedHttpResponse = {
      requestId: 'req-retention-1', statusCode: 200,
      headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"ok":true}'),
    };
    const responseAuth = createResponseAuthPayload({
      request, response, buyerPeerId: buyer.peerId, sellerPeerId: seller.peerId,
      advertisedService: 'model-a', provider: 'test', responseStartedAt: 1, responseCompletedAt: 2,
    }, seller.wallet);
    const sampler = new VerificationSampler(samplesDir, { sampleRate: 1 });
    const sample = await sampler.maybeStoreResponseAuthSample({ request, response, responseAuth, verified: true, verificationError: null });

    expect((await sampler.prune({ now: sample!.savedAt + 6 * DAY })).deletedSamples).toBe(0);
    expect(existsSync(join(sample!.directory, 'manifest.json'))).toBe(true);
    expect((await sampler.prune({ now: sample!.savedAt + 8 * DAY })).deletedSamples).toBe(1);
    expect(existsSync(sample!.directory)).toBe(false);
  });
});

describe('VerificationRetention', () => {
  it('runs after the startup delay and then every interval on an unref\'d timer, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pruneResponseAuthsOlderThan = vi.fn(async () => 0);
    const prune = vi.fn(async () => ({ deletedSamples: 0, deletedBytes: 0, keptSamples: 0, keptBytes: 0 }));
    const retention = new VerificationRetention({
      storage: { pruneResponseAuthsOlderThan },
      sampler: { prune },
      startupDelayMs: 1000,
      intervalMs: HOUR,
      now: () => NOW,
    });
    retention.start();
    expect(pruneResponseAuthsOlderThan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(pruneResponseAuthsOlderThan).toHaveBeenCalledTimes(1);
    expect(pruneResponseAuthsOlderThan).toHaveBeenCalledWith(NOW - DAY, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(prune).toHaveBeenCalledWith(expect.objectContaining({ now: NOW }));

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(pruneResponseAuthsOlderThan).toHaveBeenCalledTimes(2);

    await retention.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(pruneResponseAuthsOlderThan).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hold the process open', async () => {
    const retention = new VerificationRetention({ storage: null, sampler: null });
    retention.start();
    try {
      const timer = (retention as unknown as { _timer: { hasRef(): boolean } })._timer;
      expect(timer.hasRef()).toBe(false);
    } finally {
      await retention.stop();
    }
  });

  it('keeps ResponseAuth rows of any age with a retention of 0, and survives a failing store', async () => {
    const pruneResponseAuthsOlderThan = vi.fn(async () => 0);
    const prune = vi.fn(async () => { throw new Error('disk gone'); });
    const result = await new VerificationRetention({
      storage: { pruneResponseAuthsOlderThan },
      sampler: { prune },
      responseAuthRetentionMs: 0,
    }).runOnce();
    expect(pruneResponseAuthsOlderThan).not.toHaveBeenCalled();
    expect(result).toEqual({ responseAuthsDeleted: 0, samples: null });
  });
});

describe('a buyer node', () => {
  it('prunes expired ResponseAuth rows and evidence samples after start, and stops the pruning on stop', async () => {
    const dataDir = tempDir('node-verification-retention-');
    const samplesDir = join(dataDir, 'verification_samples');
    const now = Date.now();
    writeSample(samplesDir, 'old', now - 8 * DAY);
    writeSample(samplesDir, 'recent', now - HOUR);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const node = new AntseedNode({ role: 'buyer', dataDir, noOfficialBootstrap: true });
    const internals = node as unknown as {
      _initializeVerificationStorage(dataDir: string): void;
      _verificationStorage: VerificationStorage | null;
      _verificationRetention: { _run: Promise<unknown> | null } | null;
      _started: boolean;
    };
    internals._initializeVerificationStorage(dataDir);
    const storage = internals._verificationStorage!;
    storage.insertResponseAuth(record('old', now - 2 * DAY));
    storage.insertResponseAuth(record('recent', now - HOUR));

    // Nothing runs while the buyer is still starting.
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.getResponseAuth('old')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await internals._verificationRetention?._run;
    expect(storage.getResponseAuth('old')).toBeNull();
    expect(storage.getResponseAuth('recent')).not.toBeNull();
    expect(sampleIds(samplesDir)).toEqual(['recent']);

    internals._started = true;
    await node.stop();
    expect(internals._verificationRetention).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
