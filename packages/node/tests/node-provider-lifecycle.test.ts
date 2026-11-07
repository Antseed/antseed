import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import type { PeerAnnouncer } from '../src/discovery/announcer.js';
import type { Provider } from '../src/interfaces/seller-provider.js';

// No UPnP on the test machine's router.
vi.mock('../src/p2p/nat-traversal.js', () => ({
  NatTraversal: class {
    async mapPorts() { return { success: false, mappings: [] }; }
    async cleanup() {}
  },
}));

const dirs: string[] = [];
const nodes: AntseedNode[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function provider(name: string, extra: Partial<Provider> = {}): Provider {
  return {
    name,
    services: [`${name}-model`],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    handleRequest: async () => { throw new Error('unused'); },
    getCapacity: () => ({ current: 0, max: 1 }),
    ...extra,
  } as Provider;
}

async function startSeller(providers: Provider[]): Promise<AntseedNode> {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-provider-lifecycle-'));
  dirs.push(dataDir);
  const node = new AntseedNode({ role: 'seller', dataDir, bootstrapNodes: [], noOfficialBootstrap: true, dhtPort: 0, signalingPort: 0 });
  nodes.push(node);
  for (const p of providers) node.registerProvider(p);
  await node.start();
  return node;
}

describe('seller providers', () => {
  it('publish valid metadata when two providers contribute the same capability', async () => {
    const shared = ['colony-pool-e2e.v2', 'colony-pool-e2e.v2.pool-a'];
    const node = await startSeller([
      provider('pool-a', { peerCapabilities: shared }),
      provider('pool-b', { peerCapabilities: ['colony-pool-e2e.v2', 'colony-pool-e2e.v2.pool-b'] }),
    ]);
    const announcer = (node as unknown as { _announcer: PeerAnnouncer })._announcer;
    await announcer.refreshMetadata();
    const capabilities = announcer.getLatestMetadata()?.capabilities ?? [];
    expect(capabilities.filter((c) => c === 'colony-pool-e2e.v2')).toHaveLength(1);
    expect(capabilities).toEqual(expect.arrayContaining(['colony-pool-e2e.v2.pool-a', 'colony-pool-e2e.v2.pool-b']));
    expect(new Set(capabilities).size).toBe(capabilities.length);
  });

  it('are stopped when the node stops, and a failing stop does not block the others', async () => {
    const stopA = vi.fn(async () => { throw new Error('busy'); });
    const stopB = vi.fn(async () => {});
    const node = await startSeller([provider('a', { stop: stopA }), provider('b', { stop: stopB }), provider('c')]);
    await node.stop();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });
});
