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
});
