import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { RpcHealthMonitor, probeRpcEndpoint } from '../src/payments/rpc-health.js';

type RpcStub = { server: http.Server; url: string; setHealthy: (healthy: boolean) => void };

const stubs: RpcStub[] = [];
const monitors: RpcHealthMonitor[] = [];

afterEach(async () => {
  for (const monitor of monitors) monitor.stop();
  monitors.length = 0;
  await Promise.all(stubs.map((stub) => new Promise<void>((resolve) => stub.server.close(() => resolve()))));
  stubs.length = 0;
});

function track(monitor: RpcHealthMonitor): RpcHealthMonitor {
  monitors.push(monitor);
  return monitor;
}

async function startRpcStub(initiallyHealthy = true): Promise<RpcStub> {
  let healthy = initiallyHealthy;
  const server = http.createServer((_req, res) => {
    if (!healthy) {
      res.writeHead(500).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('stub failed to bind');
  const stub: RpcStub = {
    server,
    url: `http://127.0.0.1:${address.port}`,
    setHealthy: (value) => { healthy = value; },
  };
  stubs.push(stub);
  return stub;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('probeRpcEndpoint', () => {
  it('returns true for a well-formed eth_chainId response', async () => {
    const stub = await startRpcStub();
    expect(await probeRpcEndpoint(stub.url)).toBe(true);
  });

  it('returns false for HTTP errors and unreachable hosts', async () => {
    const stub = await startRpcStub(false);
    expect(await probeRpcEndpoint(stub.url)).toBe(false);
    expect(await probeRpcEndpoint('http://127.0.0.1:1', 200)).toBe(false);
  });
});

describe('RpcHealthMonitor', () => {
  it('starts optimistic: unknown state still counts as reachable', () => {
    const monitor = track(new RpcHealthMonitor({ rpcUrls: ['http://127.0.0.1:1'] }));
    expect(monitor.status().state).toBe('unknown');
    expect(monitor.reachable).toBe(true);
  });

  it('reports ready after a successful probe and fires onReady', async () => {
    const stub = await startRpcStub();
    const monitor = track(new RpcHealthMonitor({ rpcUrls: [stub.url] }));
    let readyCalls = 0;
    monitor.onReady(() => { readyCalls += 1; });

    expect(await monitor.probeNow()).toBe(true);
    expect(monitor.status().state).toBe('ready');
    expect(monitor.reachable).toBe(true);
    expect(readyCalls).toBe(1);

    // Staying ready does not re-fire the transition listener.
    expect(await monitor.probeNow()).toBe(true);
    expect(readyCalls).toBe(1);
  });

  it('reports unreachable after a failed probe', async () => {
    const monitor = track(new RpcHealthMonitor({ rpcUrls: ['http://127.0.0.1:1'], probeTimeoutMs: 200 }));
    expect(await monitor.probeNow()).toBe(false);
    expect(monitor.status().state).toBe('unreachable');
    expect(monitor.reachable).toBe(false);
    expect(monitor.status().lastError).toContain('127.0.0.1:1');
  });

  it('falls back to a secondary URL when the primary fails', async () => {
    const stub = await startRpcStub();
    const monitor = track(new RpcHealthMonitor({
      rpcUrls: ['http://127.0.0.1:1', stub.url],
      probeTimeoutMs: 500,
    }));
    expect(await monitor.probeNow()).toBe(true);
    expect(monitor.status().state).toBe('ready');
  });

  it('recovers in the background once the RPC becomes reachable', async () => {
    const stub = await startRpcStub(false);
    const monitor = track(new RpcHealthMonitor({
      rpcUrls: [stub.url],
      probeTimeoutMs: 300,
      retryBaseMs: 20,
      retryMaxMs: 40,
    }));
    monitor.start();

    await waitFor(() => monitor.status().state === 'unreachable');
    expect(monitor.reachable).toBe(false);

    stub.setHealthy(true);
    await waitFor(() => monitor.status().state === 'ready');
    expect(monitor.reachable).toBe(true);
  });

  it('re-detects a mid-session outage when a failure is reported, then recovers', async () => {
    const stub = await startRpcStub(true);
    const monitor = track(new RpcHealthMonitor({
      rpcUrls: [stub.url],
      probeTimeoutMs: 300,
      retryBaseMs: 20,
      retryMaxMs: 40,
    }));
    monitor.start();
    await waitFor(() => monitor.status().state === 'ready');

    // RPC dies later; the sticky ready state only flips once a call site
    // reports an observed on-chain failure.
    stub.setHealthy(false);
    expect(monitor.reachable).toBe(true);
    monitor.reportFailure();
    await waitFor(() => monitor.status().state === 'unreachable');
    expect(monitor.reachable).toBe(false);

    // Reports while the probe loop is already running do not stack loops.
    monitor.reportFailure();
    monitor.reportFailure();

    stub.setHealthy(true);
    await waitFor(() => monitor.status().state === 'ready');
    expect(monitor.reachable).toBe(true);
  });

  it('rejects an empty URL list', () => {
    expect(() => new RpcHealthMonitor({ rpcUrls: [] })).toThrow(/at least one/i);
  });
});
