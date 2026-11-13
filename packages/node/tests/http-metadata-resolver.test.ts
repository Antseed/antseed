import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMetadataResolver, MAX_METADATA_HTTP_RESPONSE_SIZE } from '../src/discovery/http-metadata-resolver.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function buildMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 0,
      },
    ],
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(128),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HttpMetadataResolver', () => {
  it('uses a bounded default response size', () => {
    expect(MAX_METADATA_HTTP_RESPONSE_SIZE).toBe(256 * 1024);
  });

  it('fetches metadata from the single endpoint regardless of announced version', async () => {
    const metadata = buildMetadata({ version: 11 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 0,
    });

    const resolved = await resolver.resolve({ host: '1.1.1.1', port: 6882 });

    expect(resolved).toEqual(expect.objectContaining({ version: 11 }));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://1.1.1.1:6882/metadata',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('limits concurrent metadata fetches', async () => {
    let active = 0;
    let peak = 0;
    const releaseQueue: Array<() => void> = [];
    const fetchMock = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releaseQueue.push(() => {
          active -= 1;
          resolve();
        });
      });
      return new Response(JSON.stringify(buildMetadata()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      maxConcurrent: 2,
      failureCooldownMs: 0,
    });

    const pending = [
      resolver.resolve({ host: '1.1.1.1', port: 6882 }),
      resolver.resolve({ host: '1.1.1.2', port: 6882 }),
      resolver.resolve({ host: '1.1.1.3', port: 6882 }),
    ];

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);

    releaseQueue.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    while (releaseQueue.length > 0) {
      releaseQueue.shift()?.();
    }
    const results = await Promise.all(pending);
    expect(results.every((result) => result !== null)).toBe(true);
  });

  it('rejects metadata exceeding the configured content length limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(buildMetadata()), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '101',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 0,
      maxResponseBytes: 100,
    });

    await expect(resolver.resolve({ host: '1.1.1.1', port: 6882 })).resolves.toBeNull();
  });

  it('stops reading streamed metadata after the response limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('x'.repeat(101), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 0,
      maxResponseBytes: 100,
    });

    await expect(resolver.resolve({ host: '1.1.1.1', port: 6882 })).resolves.toBeNull();
  });
  it('caches failed endpoints for the configured cooldown', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 60_000,
    });
    const peer = { host: '84.228.226.179', port: 6882 };

    const first = await resolver.resolve(peer);
    const second = await resolver.resolve(peer);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not skip other ports for the same host after one port fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 60_000,
    });

    // First call on a random ephemeral port fails.
    const first = await resolver.resolve({ host: '18.200.194.8', port: 57882 });
    // Second call on another port of the same host still attempts fetch.
    const second = await resolver.resolve({ host: '18.200.194.8', port: 6882 });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an endpoint after cooldown expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const metadata = buildMetadata();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 1_000,
    });
    const peer = { host: '147.236.231.105', port: 6882 };

    const first = await resolver.resolve(peer);
    const skipped = await resolver.resolve(peer);
    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
    const retried = await resolver.resolve(peer);

    expect(first).toBeNull();
    expect(skipped).toBeNull();
    expect(retried).toEqual(expect.objectContaining({
      ...metadata,
      resolvedAtMs: new Date('2026-01-01T00:00:01.001Z').getTime(),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('increases endpoint cooldown across consecutive failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 1_000,
      maxFailureCooldownMs: 10_000,
    });
    const peer = { host: '147.236.231.105', port: 6882 };

    const first = await resolver.resolve(peer); // attempt #1, fail, cooldown=1s
    const firstCooldownSkip = await resolver.resolve(peer); // still in 1s window

    vi.setSystemTime(new Date('2026-01-01T00:00:01.001Z'));
    const second = await resolver.resolve(peer); // attempt #2, fail, cooldown=2s

    vi.setSystemTime(new Date('2026-01-01T00:00:02.500Z'));
    const secondCooldownSkip = await resolver.resolve(peer); // should still be cooling down

    vi.setSystemTime(new Date('2026-01-01T00:00:03.002Z'));
    const third = await resolver.resolve(peer); // attempt #3 allowed

    expect(first).toBeNull();
    expect(firstCooldownSkip).toBeNull();
    expect(second).toBeNull();
    expect(secondCooldownSkip).toBeNull();
    expect(third).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('probes a failed endpoint before a long cooldown expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const metadata = buildMetadata();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resolver = new HttpMetadataResolver({
      timeoutMs: 100,
      failureCooldownMs: 10_000,
      maxFailureCooldownMs: 10_000,
      recoveryProbeIntervalMs: 2_000,
    });
    const peer = { host: '147.236.231.105', port: 6882 };

    const first = await resolver.resolve(peer);
    const skipped = await resolver.resolve(peer);
    vi.setSystemTime(new Date('2026-01-01T00:00:02.001Z'));
    const probed = await resolver.resolve(peer);

    expect(first).toBeNull();
    expect(skipped).toBeNull();
    expect(probed).toEqual(expect.objectContaining({
      ...metadata,
      resolvedAtMs: new Date('2026-01-01T00:00:02.001Z').getTime(),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
