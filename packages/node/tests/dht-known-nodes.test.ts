import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_FALLBACK_BOOTSTRAP_NODES, toBootstrapConfig } from '../src/discovery/bootstrap.js';
import {
  DEFAULT_DHT_CONFIG, DHTNode, MAX_KNOWN_NODES, pickKnownNodes, topicToInfoHash, type DHTNodeConfig,
} from '../src/discovery/dht-node.js';
import { AntseedNode } from '../src/node.js';
import { toPeerId } from '../src/types/peer.js';

const nodes: DHTNode[] = [];
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dht-known-nodes-'));
  dirs.push(dir);
  return dir;
}

async function startNode(id: string, overrides: Partial<DHTNodeConfig> = {}): Promise<DHTNode> {
  const node = new DHTNode({
    ...DEFAULT_DHT_CONFIG,
    peerId: toPeerId(id.repeat(40)),
    port: 0,
    operationTimeoutMs: 1000,
    allowPrivateIPs: true,
    bootstrapNodes: [],
    ...overrides,
  });
  nodes.push(node);
  await node.start();
  return node;
}

const local = (node: DHTNode) => ({ host: '127.0.0.1', port: node.getPort() });

/** A local UDP port with no DHT node behind it any more. */
async function deadEndpoint(): Promise<{ host: string; port: number }> {
  const node = new DHTNode({ ...DEFAULT_DHT_CONFIG, peerId: toPeerId('f'.repeat(40)), port: 0, bootstrapNodes: [] });
  await node.start();
  const endpoint = local(node);
  await node.stop();
  return endpoint;
}

async function savedPorts(file: string): Promise<number[]> {
  const saved = JSON.parse(await readFile(file, 'utf8')) as { nodes: Array<{ port: number }> };
  return saved.nodes.map((node) => node.port);
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('saved DHT nodes', () => {
  it('saves the nodes it knew on stop and rejoins through them when its bootstrap list does not answer', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const bootstrap = await startNode('a');
    const bootstrapEndpoint = local(bootstrap);
    const peer = await startNode('b', { bootstrapNodes: [bootstrapEndpoint] });
    const first = await startNode('c', { bootstrapNodes: [bootstrapEndpoint], knownNodesFile: file });
    await vi.waitFor(() => expect(first.getNodeCount()).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await first.stop();

    // The bootstrap node is on the list already, so only the peer is saved.
    expect(await savedPorts(file)).toEqual([peer.getPort()]);

    await bootstrap.stop();
    const second = await startNode('d', { bootstrapNodes: [bootstrapEndpoint], knownNodesFile: file });
    expect(second.getNodeCount()).toBeGreaterThan(0);
  }, 15_000);

  it('never contacts the saved nodes while the bootstrap list answers', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const bootstrap = await startNode('a');
    const saved = await startNode('b');
    await writeFile(file, JSON.stringify({ savedAt: '2026-01-01T00:00:00.000Z', nodes: [local(saved)] }));
    const node = await startNode('c', { bootstrapNodes: [local(bootstrap)], knownNodesFile: file });
    await vi.waitFor(() => expect(node.getNodeCount()).toBeGreaterThan(0), { timeout: 3000 });
    await node.lookup(topicToInfoHash('antseed:test:known-nodes'));
    // Any query from the node would have put it in the saved node's routing table.
    expect(saved.getNodeCount()).toBe(0);
  }, 15_000);

  it('saves after a lookup, without waiting for stop', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const bootstrap = await startNode('a');
    const peer = await startNode('b', { bootstrapNodes: [local(bootstrap)] });
    const node = await startNode('c', { bootstrapNodes: [local(bootstrap)], knownNodesFile: file });
    await vi.waitFor(() => expect(node.getNodeCount()).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    await node.lookup(topicToInfoHash('antseed:test:known-nodes'));
    await vi.waitFor(async () => expect(await savedPorts(file)).toEqual([peer.getPort()]), { timeout: 3000 });
  }, 15_000);

  it('keeps the saved nodes when it never connected', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const body = JSON.stringify({ savedAt: '2026-01-01T00:00:00.000Z', nodes: [await deadEndpoint()] });
    await writeFile(file, body);
    const node = await startNode('a', { knownNodesFile: file });
    await node.stop();
    expect(await readFile(file, 'utf8')).toBe(body);
  }, 15_000);
});

describe('fallback bootstrap nodes', () => {
  it('joins through them when nothing on the bootstrap list answers', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const fallback = await startNode('a');
    const node = await startNode('b', {
      bootstrapNodes: [await deadEndpoint()],
      fallbackBootstrapNodes: [local(fallback)],
      knownNodesFile: file,
    });
    expect(node.getNodeCount()).toBeGreaterThan(0);
    expect(fallback.getNodeCount()).toBeGreaterThan(0);

    // The fallback node is never saved: it is added again whenever it's needed.
    await node.stop();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('are only tried after the saved nodes', async () => {
    const file = join(await tempDir(), 'dht-nodes.json');
    const saved = await startNode('a');
    const fallback = await startNode('b');
    await writeFile(file, JSON.stringify({ savedAt: '2026-01-01T00:00:00.000Z', nodes: [local(saved)] }));
    const node = await startNode('c', {
      bootstrapNodes: [await deadEndpoint()],
      fallbackBootstrapNodes: [local(fallback)],
      knownNodesFile: file,
    });
    expect(node.getNodeCount()).toBeGreaterThan(0);
    expect(saved.getNodeCount()).toBeGreaterThan(0);
    expect(fallback.getNodeCount()).toBe(0);
  }, 15_000);

  it('are never contacted while the bootstrap list answers', async () => {
    const bootstrap = await startNode('a');
    const fallback = await startNode('b');
    const node = await startNode('c', { bootstrapNodes: [local(bootstrap)], fallbackBootstrapNodes: [local(fallback)] });
    await vi.waitFor(() => expect(node.getNodeCount()).toBeGreaterThan(0), { timeout: 3000 });
    await node.lookup(topicToInfoHash('antseed:test:known-nodes'));
    // Any query from the node would have put it in the fallback node's routing table.
    expect(fallback.getNodeCount()).toBe(0);
  }, 15_000);
});

describe('pickKnownNodes', () => {
  it('keeps valid, distinct IPv4 nodes outside the excluded set', () => {
    expect(pickKnownNodes([
      { host: '192.0.2.1', port: 6881 },
      { host: '192.0.2.1', port: 6881 },
      { host: '192.0.2.2', port: 6881 },
      { host: '192.0.2.3', port: 0 },
      { host: '2001:db8::1', port: 6881 },
      { host: 'dht.example', port: 6881 },
      { host: '192.0.2.4', port: 6881.5 },
      null,
      'nope',
    ], { exclude: new Set(['192.0.2.2:6881']) })).toEqual([{ host: '192.0.2.1', port: 6881 }]);
  });

  it('drops private addresses unless they are allowed', () => {
    const table = [{ host: '127.0.0.1', port: 6881 }, { host: '10.0.0.1', port: 6881 }, { host: '192.0.2.1', port: 6881 }];
    expect(pickKnownNodes(table)).toEqual([{ host: '192.0.2.1', port: 6881 }]);
    expect(pickKnownNodes(table, { allowPrivateIPs: true })).toHaveLength(3);
  });

  it(`keeps at most ${MAX_KNOWN_NODES}, spread over the whole table`, () => {
    const table = Array.from({ length: 64 }, (_, i) => ({ host: `192.0.2.${i + 1}`, port: 6881 }));
    const picked = pickKnownNodes(table);
    expect(picked).toHaveLength(MAX_KNOWN_NODES);
    expect(picked[0]).toEqual(table[0]);
    expect(picked.at(-1)).toEqual(table[60]);
  });
});

describe('AntseedNode DHT config', () => {
  type Internals = { _identity: unknown; _createDHTConfig(port: number, bootstrap: unknown[]): DHTNodeConfig };
  const dhtConfig = (node: AntseedNode): DHTNodeConfig => {
    const internals = node as unknown as Internals;
    internals._identity = { peerId: toPeerId('a'.repeat(40)) };
    return internals._createDHTConfig(0, []);
  };

  it('saves known nodes in the data directory and falls back to the public routers', async () => {
    const dataDir = await tempDir();
    expect(dhtConfig(new AntseedNode({ role: 'buyer', dataDir }))).toMatchObject({
      knownNodesFile: join(dataDir, 'dht-nodes.json'),
      fallbackBootstrapNodes: toBootstrapConfig(PUBLIC_FALLBACK_BOOTSTRAP_NODES),
    });
  });

  it('uses neither on an isolated network', async () => {
    const config = dhtConfig(new AntseedNode({ role: 'seller', dataDir: await tempDir(), noOfficialBootstrap: true }));
    expect(config.knownNodesFile).toBeUndefined();
    expect(config.fallbackBootstrapNodes).toBeUndefined();
  });
});
