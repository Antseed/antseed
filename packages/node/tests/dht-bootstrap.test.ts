import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DHTNode, DEFAULT_DHT_CONFIG, type DHTNodeConfig } from '../src/discovery/dht-node.js';
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
    });
  });

  it('passes IPv4 literals through and drops IPv6 literals without DNS queries', async () => {
    const lookup = vi.fn();
    await makeNode({ lookup, bootstrapNodes: [
      { host: '127.0.0.1', port: 6881 }, { host: '::1', port: 6881 },
      { host: '64:ff9b::227b:88f0', port: 6881 },
    ] }).start();
    expect(lookup).not.toHaveBeenCalled();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'] });
  });

  it('drops IPv6-only DNS answers', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '64:ff9b::227b:88f0', family: 6 }]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: [] });
  });

  it('keeps IPv4 answers when the resolver also returns IPv6', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '64:ff9b::227b:88f0', family: 6 }, ipv4('192.0.2.1'),
    ]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['192.0.2.1:6881'] });
  });

  it('warns and skips a failed host without rejecting start or losing other bootstraps', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(makeNode({ lookup, bootstrapNodes: [
      { host: 'missing.example', port: 6881 }, { host: '127.0.0.1', port: 6881 },
    ] }).start()).resolves.toBeUndefined();
    expect(mock.warn).toHaveBeenCalledWith(expect.stringContaining('missing.example'));
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'] });
  });

  it('resolves localhost with family 4 for local-test bootstraps', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('127.0.0.1')]);
    await makeNode({ lookup, allowPrivateIPs: true, bootstrapNodes: [
      { host: 'localhost', port: 12345 },
    ] }).start();
    expect(lookup).toHaveBeenCalledWith('localhost', { family: 4, all: true });
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:12345'] });
  });
});
