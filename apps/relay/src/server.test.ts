import net from 'node:net';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { isForbiddenIp } from './address-guard.js';
import { RelayServer } from './server.js';
import { SellerCache, parseHostPort, parseStaticSellers } from './seller-cache.js';

const PEER_ID = 'ab'.repeat(20);
const DISCOVERED_PRIVATE_PEER = 'ee'.repeat(20);
const DISCOVERED_LOCALHOST_NAME_PEER = 'ef'.repeat(20);

/** Injects a discovered (untrusted) peer as if a DHT poll had found it. */
function injectDiscovered(cache: SellerCache, peerId: string, publicAddress: string): void {
  (cache as unknown as { discovered: Map<string, unknown> }).discovered.set(peerId, {
    peerId,
    publicAddress,
    timestamp: Date.now(),
  });
}

describe('RelayServer bridge', () => {
  let seller: net.Server;
  let sellerPort: number;
  let relay: RelayServer;
  let relayPort: number;

  beforeAll(async () => {
    seller = net.createServer((socket) => {
      sellerSockets.push(socket);
      socket.on('data', (chunk) => socket.write(chunk));
    });
    seller.listen(0);
    await once(seller, 'listening');
    sellerPort = (seller.address() as net.AddressInfo).port;

    const cache = new SellerCache({
      dht: false,
      pollIntervalMs: 60_000,
      staticSellers: [{ peerId: PEER_ID, host: '127.0.0.1', port: sellerPort }],
    });
    injectDiscovered(cache, DISCOVERED_PRIVATE_PEER, `169.254.169.254:80`);
    injectDiscovered(cache, DISCOVERED_LOCALHOST_NAME_PEER, `localhost:${sellerPort}`);
    relay = new RelayServer(cache, {
      port: 0,
      maxBridgesPerIp: 2,
      tcpConnectTimeoutMs: 2_000,
      idleTimeoutMs: 60_000,
    });
    await relay.start();
    relayPort = relay.address().port;
  });

  afterAll(async () => {
    await relay.stop();
    seller.close();
  });

  it('pipes bytes both ways', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    await once(ws, 'open');
    const received: Buffer[] = [];
    ws.on('message', (data) => received.push(data as Buffer));

    ws.send('{"type":"hello"}\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(received).toString()).toBe('{"type":"hello"}\n');
    ws.close();
  });

  it('rejects unknown peer with 404', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${'cd'.repeat(20)}`);
    const [err] = await once(ws, 'error');
    expect((err as Error).message).toContain('404');
  });

  it('rejects malformed peer id with 400', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/nothex`);
    const [err] = await once(ws, 'error');
    expect((err as Error).message).toContain('400');
  });

  it('enforces per-IP bridge cap', async () => {
    const a = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    const b = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    await Promise.all([once(a, 'open'), once(b, 'open')]);

    const c = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    const [err] = await once(c, 'error');
    expect((err as Error).message).toContain('429');

    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 100));
    const d = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    await once(d, 'open');
    d.close();
  });

  it('closes the socket when the seller disconnects', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`);
    await once(ws, 'open');
    ws.send('x');
    await new Promise((r) => setTimeout(r, 100));
    for (const socket of sellerSockets) socket.destroy();
    const [code] = await once(ws, 'close');
    expect(code).toBe(1000);
  });

  it('rejects discovered sellers announcing a private IP with 403', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${DISCOVERED_PRIVATE_PEER}`);
    const [err] = await once(ws, 'error');
    expect((err as Error).message).toContain('403');
  });

  it('refuses to dial discovered hostnames that resolve to private ranges', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${DISCOVERED_LOCALHOST_NAME_PEER}`);
    await once(ws, 'open'); // literal check passes (hostname), guard fires at DNS lookup
    const [code] = await once(ws, 'close');
    expect(code).toBe(1011);
  });

  it('serves the seller snapshot over HTTP with CORS', async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/sellers`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { static: { peerId: string }[] };
    expect(body.static[0]?.peerId).toBe(PEER_ID);
  });

  it('reports readiness and privacy-safe aggregate metrics', async () => {
    const ready = await fetch(`http://127.0.0.1:${relayPort}/readyz`);
    expect(ready.status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${relayPort}/metrics`);
    expect(metrics.status).toBe(200);
    const body = (await metrics.json()) as Record<string, number>;
    expect(body.bridgeAttempts).toBeGreaterThan(0);
    expect(body).toHaveProperty('activeBridges');
    expect(JSON.stringify(body)).not.toContain(PEER_ID);
  });

  it('keeps static sellers ready when DHT discovery is stale', () => {
    const cache = new SellerCache({
      dht: true,
      pollIntervalMs: 60_000,
      staticSellers: [{ peerId: PEER_ID, host: '127.0.0.1', port: sellerPort }],
    });

    expect(cache.isReady(1)).toBe(true);
  });
});

describe('relay production admission controls', () => {
  let seller: net.Server;
  let relay: RelayServer;
  let relayPort: number;

  beforeAll(async () => {
    seller = net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
    seller.listen(0);
    await once(seller, 'listening');
    relay = new RelayServer(
      new SellerCache({
        dht: false,
        pollIntervalMs: 60_000,
        staticSellers: [{
          peerId: PEER_ID,
          host: '127.0.0.1',
          port: (seller.address() as net.AddressInfo).port,
        }],
      }),
      {
        port: 0,
        maxBridgesPerIp: 8,
        maxBridgesGlobal: 8,
        maxBridgesPerSeller: 1,
        maxPayloadBytes: 32,
        tcpConnectTimeoutMs: 2_000,
        idleTimeoutMs: 60_000,
        allowedOrigins: ['https://allowed.example'],
      },
    );
    await relay.start();
    relayPort = relay.address().port;
  });

  afterAll(async () => {
    await relay.stop();
    seller.close();
  });

  it('enforces the Origin allowlist and per-seller cap', async () => {
    const url = `ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`;
    const forbidden = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
    const [originError] = await once(forbidden, 'error');
    expect((originError as Error).message).toContain('403');

    const first = new WebSocket(url, { headers: { origin: 'https://allowed.example' } });
    await once(first, 'open');
    const saturated = new WebSocket(url, { headers: { origin: 'https://allowed.example' } });
    const [capacityError] = await once(saturated, 'error');
    expect((capacityError as Error).message).toContain('429');
    const closed = once(first, 'close');
    first.close();
    await closed;
    await waitForBridgeCount(relay, 0);
  });

  it('rejects oversized signaling messages', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`, {
      headers: { origin: 'https://allowed.example' },
    });
    await once(ws, 'open');
    ws.send(Buffer.alloc(64));
    const [code] = await once(ws, 'close');
    expect(code).toBe(1009);
  });

  it('counts an abnormal client disconnect as a failed bridge', async () => {
    const before = await relayMetrics(relayPort);
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`, {
      headers: { origin: 'https://allowed.example' },
    });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.terminate();
    await closed;
    await waitForBridgeCount(relay, 0);

    const after = await relayMetrics(relayPort);
    expect(after.bridgeFailed).toBe(before.bridgeFailed + 1);
    expect(after.bridgeCompleted).toBe(before.bridgeCompleted);
  });
});

async function waitForBridgeCount(relay: RelayServer, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (relay.bridgeCount !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(relay.bridgeCount).toBe(expected);
}

async function relayMetrics(port: number): Promise<{
  bridgeFailed: number;
  bridgeCompleted: number;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ bridgeFailed: number; bridgeCompleted: number }>;
}

describe('trustProxy per-IP accounting', () => {
  let seller: net.Server;
  let relay: RelayServer;
  let relayPort: number;

  beforeAll(async () => {
    seller = net.createServer((socket) => socket.on('data', (c) => socket.write(c)));
    seller.listen(0);
    await once(seller, 'listening');
    const sellerPort = (seller.address() as net.AddressInfo).port;
    relay = new RelayServer(
      new SellerCache({
        dht: false,
        pollIntervalMs: 60_000,
        staticSellers: [{ peerId: PEER_ID, host: '127.0.0.1', port: sellerPort }],
      }),
      { port: 0, maxBridgesPerIp: 1, tcpConnectTimeoutMs: 2_000, idleTimeoutMs: 60_000, trustProxy: true },
    );
    await relay.start();
    relayPort = relay.address().port;
  });

  afterAll(async () => {
    await relay.stop();
    seller.close();
  });

  it('keys the bridge cap on the last X-Forwarded-For entry', async () => {
    const url = `ws://127.0.0.1:${relayPort}/bridge/${PEER_ID}`;
    const a = new WebSocket(url, { headers: { 'x-forwarded-for': 'spoofed, 5.5.5.5' } });
    await once(a, 'open');

    // Same trusted entry → capped despite a different spoofable prefix.
    const b = new WebSocket(url, { headers: { 'x-forwarded-for': 'other, 5.5.5.5' } });
    const [err] = await once(b, 'error');
    expect((err as Error).message).toContain('429');

    // Different trusted entry → its own bucket.
    const c = new WebSocket(url, { headers: { 'x-forwarded-for': 'spoofed, 6.6.6.6' } });
    await once(c, 'open');

    a.close();
    c.close();
  });
});

describe('isForbiddenIp', () => {
  it('blocks private, loopback, link-local, CGNAT, and v6 internal ranges', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
  });

  it('blocks IPv4-in-IPv6 embeddings in non-dotted forms', () => {
    for (const ip of [
      '::ffff:7f00:1',            // hex-mapped 127.0.0.1
      '::ffff:a00:1',             // hex-mapped 10.0.0.1
      '2002:7f00:1::',            // 6to4 wrapping 127.0.0.1
      '2002:a9fe:a9fe::',         // 6to4 wrapping 169.254.169.254
      '2001:0:0:0:0:0:80ff:fffe', // Teredo wrapping 127.0.0.1 (client ^0xffff)
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses and rejects non-IPs', () => {
    for (const ip of [
      '8.8.8.8', '1.2.3.4', '172.32.0.1', '2001:4860:4860::8888',
      '::ffff:8.8.8.8', '::ffff:808:808', '2002:808:808::',
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(false);
    }
    expect(isForbiddenIp('example.com')).toBe(true);
  });
});

describe('parseHostPort', () => {
  it('handles v4, hostname, bracketed v6, and bare v6 forms', () => {
    expect(parseHostPort('1.2.3.4:7000')).toEqual({ host: '1.2.3.4', port: 7000 });
    expect(parseHostPort('example.com')).toEqual({ host: 'example.com', port: 6882 });
    expect(parseHostPort('[2001:db8::1]:7000')).toEqual({ host: '2001:db8::1', port: 7000 });
    expect(parseHostPort('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 6882 });
    expect(parseHostPort('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 6882 });
  });

  it('rejects malformed input', () => {
    expect(parseHostPort('')).toBeNull();
    expect(parseHostPort('host:99999')).toBeNull();
    expect(parseHostPort(':7000')).toBeNull();
  });
});

describe('parseStaticSellers', () => {
  it('parses entries and defaults the port', () => {
    const sellers = parseStaticSellers(`${PEER_ID}@1.2.3.4:7000, ${'cd'.repeat(20)}@example.com`);
    expect(sellers).toEqual([
      { peerId: PEER_ID, host: '1.2.3.4', port: 7000 },
      { peerId: 'cd'.repeat(20), host: 'example.com', port: 6882 },
    ]);
  });

  it('rejects malformed entries', () => {
    expect(() => parseStaticSellers('nope')).toThrow();
    expect(() => parseStaticSellers(`${PEER_ID}@host:99999`)).toThrow();
  });
});

const sellerSockets: net.Socket[] = [];
