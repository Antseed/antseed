import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntseedNode } from '../src/node.js';
import { DHTNode } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function dht(bindHost?: string): DHTNode {
  const node = new DHTNode({
    peerId: toPeerId('1'.repeat(40)),
    port: 0,
    bootstrapNodes: [],
    reannounceIntervalMs: 60_000,
    operationTimeoutMs: 200,
    ...(bindHost ? { bindHost } : {}),
  });
  cleanups.push(() => node.stop());
  return node;
}

describe('bind host', () => {
  it('binds the DHT socket to bindHost when set', async () => {
    const node = dht('127.0.0.1');
    await node.start();
    expect(node.getAddress()).toBe('127.0.0.1');
    expect(node.getPort()).toBeGreaterThan(0);
  });

  it('keeps binding the DHT socket to all interfaces by default', async () => {
    const node = dht();
    await node.start();
    expect(['0.0.0.0', '::']).toContain(node.getAddress());
  });

  it('binds seller DHT and signaling to bindHost and skips NAT mapping when disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'antseed-bind-host-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const seller = new AntseedNode({
      role: 'seller',
      dataDir,
      dhtPort: 0,
      signalingPort: 0,
      bindHost: '127.0.0.1',
      natTraversal: false,
      noOfficialBootstrap: true,
      bootstrapNodes: [],
      allowPrivateIPs: true,
      dhtOperationTimeoutMs: 200,
      relayer: { enabled: false },
    });
    let natAttempted = false;
    seller.on('nat:mapped', () => { natAttempted = true; });
    seller.on('nat:failed', () => { natAttempted = true; });
    cleanups.push(() => seller.stop());
    await seller.start();
    expect(seller.dhtPort).toBeGreaterThan(0);
    expect(seller.signalingPort).toBeGreaterThan(0);
    expect(seller.dhtPort).not.toBe(6881);
    expect(seller.signalingPort).not.toBe(6882);
    const internals = seller as unknown as {
      _dht: DHTNode;
      _connectionManager: { _server: { address(): { address: string } } };
    };
    expect(internals._dht.getAddress()).toBe('127.0.0.1');
    expect(internals._connectionManager._server.address().address).toBe('127.0.0.1');
    expect(natAttempted).toBe(false);
  });
});
