import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const managers: ConnectionManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
});

async function listen(acceptInboundAddress: (remoteAddress: string) => boolean): Promise<number> {
  const manager = new ConnectionManager(undefined, { acceptInboundAddress });
  managers.push(manager);
  await manager.startListening({ peerId: sellerIdentity.peerId, port: 0 });
  return manager.getListeningPort()!;
}

/** Sends a metadata request and resolves with whatever the listener writes before closing. */
function probe(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET /metadata HTTP/1.1\r\nHost: localhost\r\n\r\n');
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      socket.end();
    });
    socket.on('close', () => resolve(received));
    socket.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' ? resolve(received) : reject(err)));
  });
}

describe('ConnectionManager acceptInboundAddress', () => {
  it('closes sockets whose remote address is refused before reading them', async () => {
    const seen: string[] = [];
    const port = await listen((address) => {
      seen.push(address);
      return false;
    });

    expect(await probe(port)).toBe('');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/127\.0\.0\.1$/);
  });

  it('serves sockets whose remote address is accepted', async () => {
    const port = await listen(() => true);

    expect(await probe(port)).toMatch(/^HTTP\/1\.1 /);
  });
});
