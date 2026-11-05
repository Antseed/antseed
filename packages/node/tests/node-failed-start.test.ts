import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';

describe('a start that fails partway', () => {
  it('releases what it opened, so a retry starts clean', async () => {
    const node = new AntseedNode({ role: 'buyer', dataDir: mkdtempSync(join(tmpdir(), 'node-failed-start-')), noOfficialBootstrap: true });
    const internals = node as unknown as Record<string, unknown>;
    const closeStore = vi.fn();
    const stopMonitor = vi.fn();
    const stopDht = vi.fn(async () => {});
    let attempts = 0;
    // The payment store and RPC monitor are up when the DHT fails to start.
    internals._startBuyer = async () => {
      attempts += 1;
      internals._channelStore = { close: closeStore };
      internals._rpcHealth = { stop: stopMonitor };
      internals._dht = { stop: stopDht };
      throw new Error('DHT bind failed');
    };
    await expect(node.start()).rejects.toThrow('DHT bind failed');
    expect([closeStore.mock.calls.length, stopMonitor.mock.calls.length, stopDht.mock.calls.length]).toEqual([1, 1, 1]);
    expect([internals._channelStore, internals._rpcHealth, internals._dht]).toEqual([null, null, null]);
    await expect(node.start()).rejects.toThrow('DHT bind failed');
    expect(attempts).toBe(2);
    expect(closeStore).toHaveBeenCalledTimes(2);
  });

  it('drops its idle-settlement listener on stop, so a restarted seller settles each idle session once', async () => {
    const node = new AntseedNode({ role: 'seller', dataDir: mkdtempSync(join(tmpdir(), 'node-failed-start-')), noOfficialBootstrap: true });
    const internals = node as unknown as Record<string, unknown>;
    const settle = vi.fn();
    internals._settleOnIdle = settle;
    node.on('session:finalized', settle);
    internals._started = true;
    await node.stop();
    expect(node.listenerCount('session:finalized')).toBe(0);
    expect(internals._settleOnIdle).toBeNull();
  });
});

describe('an explicit identity', () => {
  it('is used ahead of the environment and the stored key', async () => {
    const { identityFromPrivateKeyHex } = await import('../src/p2p/identity.js');
    const identity = identityFromPrivateKeyHex('11'.repeat(32));
    const node = new AntseedNode({ role: 'buyer', dataDir: mkdtempSync(join(tmpdir(), 'node-identity-')), noOfficialBootstrap: true, identity });
    const internals = node as unknown as Record<string, unknown>;
    internals._startBuyer = async () => { throw new Error('stop here'); };
    process.env.ANTSEED_IDENTITY_HEX = '22'.repeat(32);
    try {
      await expect(node.start()).rejects.toThrow('stop here');
    } finally {
      delete process.env.ANTSEED_IDENTITY_HEX;
    }
    expect(node.peerId).toBe(identity.peerId);
  });
});
