import { afterEach, describe, expect, it, vi } from 'vitest';
import { DHTNode, DEFAULT_DHT_CONFIG, topicToInfoHash } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

const MAX_AGE_MS = 600;
const TOPIC = topicToInfoHash('antseed:test:record-expiry');
const ANNOUNCED_PORT = 7001;

const nodes: DHTNode[] = [];

async function startNode(id: string, bootstrapPort?: number): Promise<DHTNode> {
  const node = new DHTNode({
    ...DEFAULT_DHT_CONFIG,
    peerId: toPeerId(id.repeat(40)),
    port: 0,
    operationTimeoutMs: 1000,
    allowPrivateIPs: true,
    peerRecordMaxAgeMs: MAX_AGE_MS,
    bootstrapNodes: bootstrapPort === undefined ? [] : [{ host: '127.0.0.1', port: bootstrapPort }],
  });
  nodes.push(node);
  await node.start();
  if (bootstrapPort !== undefined) {
    await vi.waitFor(() => expect(node.getNodeCount()).toBeGreaterThan(0), { timeout: 3000 });
  }
  return node;
}

async function announcedPorts(looker: DHTNode): Promise<number[]> {
  return (await looker.lookup(TOPIC)).map((peer) => peer.port);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DHT peer record expiry', () => {
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((node) => node.stop()));
  });

  it('drops a peer that stopped announcing once its record ages out', async () => {
    const storage = await startNode('a');
    const announcer = await startNode('b', storage.getPort());
    const looker = await startNode('c', storage.getPort());

    await announcer.announce(TOPIC, ANNOUNCED_PORT);
    expect(await announcedPorts(looker)).toContain(ANNOUNCED_PORT);

    await announcer.stop();
    await sleep(MAX_AGE_MS * 2.5);

    expect(await announcedPorts(looker)).not.toContain(ANNOUNCED_PORT);
  }, 15_000);

  it('keeps a peer that reannounces within the record lifetime', async () => {
    const storage = await startNode('a');
    const announcer = await startNode('b', storage.getPort());
    const looker = await startNode('c', storage.getPort());

    await announcer.announce(TOPIC, ANNOUNCED_PORT);
    for (let elapsed = 0; elapsed < MAX_AGE_MS * 2.5; elapsed += MAX_AGE_MS / 4) {
      await sleep(MAX_AGE_MS / 4);
      await announcer.announce(TOPIC, ANNOUNCED_PORT);
    }

    expect(await announcedPorts(looker)).toContain(ANNOUNCED_PORT);
  }, 15_000);
});
