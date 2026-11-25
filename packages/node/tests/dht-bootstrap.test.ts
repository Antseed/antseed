import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DHTNode, DEFAULT_DHT_CONFIG, DEFAULT_PEER_RECORD_MAX_AGE_MS, MAX_KNOWN_NODES, type DHTNodeConfig } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

const mock = vi.hoisted(() => ({ construct: vi.fn(), warn: vi.fn() }));
vi.mock('../src/utils/debug.js', () => ({ debugWarn: mock.warn }));
vi.mock('bittorrent-dht', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      constructor(options: unknown) { super(); mock.construct(options); }
      listen(_port: number, callback?: () => void): void {
        callback?.();
        void Promise.resolve().then(() => this.emit('ready'));
      }
      destroy(callback?: () => void): void { callback?.(); }
      toJSON(): { nodes: unknown[] } { return { nodes: [] }; }
    },
  };
});

const nodes: DHTNode[] = [];
function makeNode(overrides: Partial<DHTNodeConfig>): DHTNode {
  const node = new DHTNode({
    ...DEFAULT_DHT_CONFIG,
    peerId: toPeerId('a'.repeat(40)), port: 0, operationTimeoutMs: 1000,
    bootstrapNodes: [{ host: 'dht.example', port: 6881 }],
    ...overrides,
  });
  nodes.push(node);
  return node;
}
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });

const ipv4 = (address: string) => ({ address, family: 4 });

describe('DHT IPv4 bootstrap resolution', () => {
  it('requests all IPv4 answers and deduplicates endpoints while preserving ports', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('192.0.2.1'), ipv4('192.0.2.2'), ipv4('192.0.2.1')]);
    await makeNode({ lookup, bootstrapNodes: [
      { host: 'dht.example', port: 6881 }, { host: 'alias.example', port: 6881 },
      { host: '192.0.2.1', port: 7000 },
    ] }).start();
    expect(lookup).toHaveBeenCalledWith('dht.example', { family: 4, all: true });
    expect(lookup).toHaveBeenCalledWith('alias.example', { family: 4, all: true });
    expect(mock.construct).toHaveBeenCalledWith({
      bootstrap: ['192.0.2.1:6881', '192.0.2.2:6881', '192.0.2.1:7000'],
      maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS,
    });
  });

  it('passes IPv4 literals through and drops IPv6 literals without DNS queries', async () => {
    const lookup = vi.fn();
    await makeNode({ lookup, bootstrapNodes: [
      { host: '127.0.0.1', port: 6881 }, { host: '::1', port: 6881 },
      { host: '64:ff9b::227b:88f0', port: 6881 },
    ] }).start();
    expect(lookup).not.toHaveBeenCalled();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
  });

  it('drops IPv6-only DNS answers', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '64:ff9b::227b:88f0', family: 6 }]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: [], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
  });

  it('keeps IPv4 answers when the resolver also returns IPv6', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '64:ff9b::227b:88f0', family: 6 }, ipv4('192.0.2.1'),
    ]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['192.0.2.1:6881'], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
  });

  it('warns and skips a failed host without rejecting start or losing other bootstraps', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(makeNode({ lookup, bootstrapNodes: [
      { host: 'missing.example', port: 6881 }, { host: '127.0.0.1', port: 6881 },
    ] }).start()).resolves.toBeUndefined();
    expect(mock.warn).toHaveBeenCalledWith(expect.stringContaining('missing.example'));
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
  });

  it('resolves localhost with family 4 for local-test bootstraps', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('127.0.0.1')]);
    await makeNode({ lookup, allowPrivateIPs: true, bootstrapNodes: [
      { host: 'localhost', port: 12345 },
    ] }).start();
    expect(lookup).toHaveBeenCalledWith('localhost', { family: 4, all: true });
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:12345'], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
  });
});

describe('saved DHT nodes on start', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dht-bootstrap-known-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it(`adds up to ${MAX_KNOWN_NODES} saved nodes after the bootstrap list, skipping ones already on it`, async () => {
    const file = join(dir, 'dht-nodes.json');
    const saved = Array.from({ length: MAX_KNOWN_NODES + 4 }, (_, i) => ({ host: `198.51.100.${i + 1}`, port: 6881 }));
    await writeFile(file, JSON.stringify({ nodes: [{ host: '192.0.2.1', port: 6881 }, ...saved] }));
    await makeNode({ knownNodesFile: file, bootstrapNodes: [{ host: '192.0.2.1', port: 6881 }] }).start();
    const { bootstrap } = mock.construct.mock.calls[0]![0] as { bootstrap: string[] };
    expect(bootstrap[0]).toBe('192.0.2.1:6881');
    expect(bootstrap).toHaveLength(1 + MAX_KNOWN_NODES);
    expect(new Set(bootstrap).size).toBe(bootstrap.length);
  });

  it('starts from the bootstrap list alone when the file is missing or unreadable', async () => {
    const malformed = join(dir, 'malformed.json');
    await writeFile(malformed, '{ not json');
    for (const knownNodesFile of [join(dir, 'missing.json'), malformed]) {
      mock.construct.mockClear();
      await makeNode({ knownNodesFile, bootstrapNodes: [{ host: '192.0.2.1', port: 6881 }] }).start();
      expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['192.0.2.1:6881'], maxAge: DEFAULT_PEER_RECORD_MAX_AGE_MS });
    }
    expect(mock.warn).toHaveBeenCalledTimes(1);
    expect(String(mock.warn.mock.calls[0]![0])).toContain('Ignoring known DHT nodes file');
  });
});
