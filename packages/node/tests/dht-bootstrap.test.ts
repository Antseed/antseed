import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { DHTNode, DEFAULT_DHT_CONFIG, type DHTNodeConfig } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

const mock = vi.hoisted(() => ({
  ready: true,
  construct: vi.fn(),
  listen: vi.fn(),
  addNode: vi.fn(),
  destroy: vi.fn(),
  toArray: vi.fn(),
  warn: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../src/utils/debug.js', () => ({ debugWarn: mock.warn, debugLog: mock.log }));

vi.mock('bittorrent-dht', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      nodes = { toArray: mock.toArray };
      addNode = mock.addNode;
      constructor(options: unknown) {
        super();
        mock.construct(options);
      }
      listen(port: number, callback?: () => void): void {
        mock.listen(port);
        callback?.();
        // Like bittorrent-dht, ready does not guarantee a nonempty table.
        if (mock.ready) void Promise.resolve().then(() => this.emit('ready'));
      }
      destroy(callback?: () => void): void {
        mock.destroy();
        callback?.();
      }
    },
  };
});

const nodes: DHTNode[] = [];
function makeNode(overrides: Partial<DHTNodeConfig> = {}): DHTNode {
  const node = new DHTNode({
    ...DEFAULT_DHT_CONFIG,
    peerId: toPeerId('a'.repeat(40)),
    port: 0,
    bootstrapNodes: [{ host: 'dht.example', port: 6881 }],
    operationTimeoutMs: 1000,
    ...overrides,
  });
  nodes.push(node);
  return node;
}

const ipv4 = (address: string): LookupAddress => ({ address, family: 4 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.ready = true;
  mock.toArray.mockReturnValue([]);
});

afterEach(async () => {
  await Promise.all(nodes.splice(0).map(node => node.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DHT IPv4 bootstrap resolution', () => {
  it('requests all IPv4 answers and deduplicates endpoints across hosts, preserving ports', async () => {
    const lookup = vi.fn().mockResolvedValue([
      ipv4('192.0.2.1'), ipv4('192.0.2.2'), ipv4('192.0.2.1'),
    ]);
    await makeNode({
      lookup,
      bootstrapNodes: [
        { host: 'dht.example', port: 6881 },
        { host: 'alias.example', port: 6881 },
        { host: '192.0.2.1', port: 7000 },
      ],
    }).start();
    expect(lookup).toHaveBeenCalledWith('dht.example', { family: 4, all: true });
    expect(lookup).toHaveBeenCalledWith('alias.example', { family: 4, all: true });
    expect(mock.construct).toHaveBeenCalledWith({
      bootstrap: ['192.0.2.1:6881', '192.0.2.2:6881', '192.0.2.1:7000'],
    });
  });

  it('passes IPv4 literals through and drops IPv6 literals without DNS queries', async () => {
    const lookup = vi.fn();
    await makeNode({ lookup, bootstrapNodes: [
      { host: '127.0.0.1', port: 6881 },
      { host: '::1', port: 6881 },
      { host: '64:ff9b::227b:88f0', port: 6881 },
    ] }).start();
    expect(lookup).not.toHaveBeenCalled();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'] });
  });

  it('drops IPv6-only answers and invalid addresses, even if labeled family 4', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '64:ff9b::227b:88f0', family: 6 },
      { address: '::1', family: 4 },
      { address: 'not-an-ip', family: 4 },
    ]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: [] });
  });

  it('keeps valid IPv4 answers when DNS also returns IPv6', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '64:ff9b::227b:88f0', family: 6 }, ipv4('192.0.2.1'),
    ]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['192.0.2.1:6881'] });
  });

  it('skips a failed host without rejecting start or losing other bootstraps', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const node = makeNode({ lookup, bootstrapNodes: [
      { host: 'missing.example', port: 6881 }, { host: '127.0.0.1', port: 6881 },
    ] });
    await expect(node.start()).resolves.toBeUndefined();
    expect(mock.warn).toHaveBeenCalledWith(expect.stringContaining('missing.example'));
    expect(mock.warn).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:6881'] });
  });

  it('bounds a stuck DNS lookup instead of hanging startup', async () => {
    const lookup = vi.fn().mockImplementation(() => new Promise<LookupAddress[]>(() => {}));
    const started = makeNode({ lookup }).start();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(started).resolves.toBeUndefined();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: [] });
    expect(mock.warn).toHaveBeenCalledWith(expect.stringContaining('Bootstrap DNS lookup timeout'));
    expect(vi.getTimerCount()).toBe(1); // Only the isolation monitor remains.
  });

  it('counts initial DNS resolution against the startup timeout budget', async () => {
    mock.ready = false;
    let finish!: (answers: LookupAddress[]) => void;
    const lookup = vi.fn().mockImplementation(() => new Promise<LookupAddress[]>(resolve => { finish = resolve; }));
    const node = makeNode({ lookup });
    const ready = vi.fn();
    node.events.on('ready', ready);
    const started = node.start();
    await vi.advanceTimersByTimeAsync(400);
    finish([ipv4('192.0.2.1')]);
    await vi.advanceTimersByTimeAsync(599);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('resolves localhost with family 4 and preserves local-test bootstraps', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('127.0.0.1')]);
    await makeNode({ lookup, allowPrivateIPs: true, bootstrapNodes: [
      { host: 'localhost', port: 12345 },
    ] }).start();
    expect(lookup).toHaveBeenCalledWith('localhost', { family: 4, all: true });
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: ['127.0.0.1:12345'] });
  });
});

describe('isolated DHT bootstrap retries', () => {
  it('re-resolves changed DNS and retries at 20s, 40s, then at most 60s', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([ipv4('192.0.2.1')])
      .mockResolvedValue([ipv4('192.0.2.2'), ipv4('192.0.2.2')]);
    await makeNode({ lookup }).start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mock.addNode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.addNode).toHaveBeenCalledTimes(1);
    expect(mock.addNode).toHaveBeenCalledWith({ host: '192.0.2.2', port: 6881 });
    expect(mock.log).toHaveBeenCalledWith(expect.stringContaining('retrying IPv4 bootstrap'));
    await vi.advanceTimersByTimeAsync(39_999);
    expect(mock.addNode).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.addNode).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.addNode).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.addNode).toHaveBeenCalledTimes(4);
  });

  it('skips DNS and retries while connected, then resumes if the table empties', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('192.0.2.1')]);
    await makeNode({ lookup }).start();
    mock.toArray.mockReturnValue([{}]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(mock.addNode).not.toHaveBeenCalled();
    mock.toArray.mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.addNode).toHaveBeenCalledTimes(1);
    expect(mock.addNode).toHaveBeenCalledWith({ host: '192.0.2.1', port: 6881 });
  });

  it('recovers after every initial DNS query fails', async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([ipv4('192.0.2.1')]);
    await makeNode({ lookup }).start();
    expect(mock.construct).toHaveBeenCalledWith({ bootstrap: [] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mock.addNode).toHaveBeenCalledTimes(1);
    expect(mock.addNode).toHaveBeenCalledWith({ host: '192.0.2.1', port: 6881 });
  });

  it('continues retrying after a timed-out DNS query without overlapping lookups', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([ipv4('192.0.2.1')])
      .mockImplementationOnce(() => new Promise<LookupAddress[]>(() => {}))
      .mockResolvedValue([ipv4('192.0.2.2')]);
    await makeNode({ lookup }).start();
    await vi.advanceTimersByTimeAsync(20_999);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(mock.addNode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // DNS timeout; next attempt is 40s later.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(mock.addNode).toHaveBeenCalledWith({ host: '192.0.2.2', port: 6881 });
  });

  it('cancels startup and all timers if stopped after binding but before ready', async () => {
    mock.ready = false;
    const lookup = vi.fn().mockResolvedValue([ipv4('192.0.2.1')]);
    const node = makeNode({ lookup });
    const ready = vi.fn();
    node.events.on('ready', ready);
    const started = node.start();
    const rejected = expect(started).rejects.toThrow('DHT start cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.construct).toHaveBeenCalledTimes(1);
    await node.stop();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ready).not.toHaveBeenCalled();
    expect(mock.addNode).not.toHaveBeenCalled();
  });

  it('cancels the unrefed retry timer on stop', async () => {
    const lookup = vi.fn().mockResolvedValue([ipv4('192.0.2.1')]);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const node = makeNode({ lookup });
    await node.start();
    const retryTimer = timeout.mock.results.at(-1)!.value;
    expect(vi.getTimerCount()).toBe(1);
    expect(retryTimer.hasRef()).toBe(false);
    timeout.mockRestore();
    await node.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(mock.addNode).not.toHaveBeenCalled();
  });

  it('does not add nodes or resurrect a timer after stop during a DNS retry', async () => {
    let finish!: (answers: LookupAddress[]) => void;
    const lookup = vi.fn().mockResolvedValueOnce([ipv4('192.0.2.1')])
      .mockImplementation(() => new Promise<LookupAddress[]>(resolve => { finish = resolve; }));
    const node = makeNode({ lookup });
    await node.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lookup).toHaveBeenCalledTimes(2);
    await node.stop();
    finish([ipv4('192.0.2.2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.addNode).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry if a node replies while DNS resolution is in flight', async () => {
    let finish!: (answers: LookupAddress[]) => void;
    const lookup = vi.fn().mockResolvedValueOnce([ipv4('192.0.2.1')])
      .mockImplementation(() => new Promise<LookupAddress[]>(resolve => { finish = resolve; }));
    await makeNode({ lookup }).start();
    await vi.advanceTimersByTimeAsync(20_000);
    mock.toArray.mockReturnValue([{}]);
    finish([ipv4('192.0.2.2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.addNode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('does not create a DHT if stopped during initial DNS resolution', async () => {
    let finish!: (answers: LookupAddress[]) => void;
    const lookup = vi.fn().mockImplementation(() => new Promise<LookupAddress[]>(resolve => { finish = resolve; }));
    const node = makeNode({ lookup });
    const started = node.start();
    const rejected = expect(started).rejects.toThrow('DHT start cancelled');
    await node.stop();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    finish([ipv4('192.0.2.1')]);
    expect(mock.construct).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
