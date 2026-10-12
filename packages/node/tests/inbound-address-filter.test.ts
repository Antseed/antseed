import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager, INBOUND_REFUSED_MESSAGE, type PeerConnection } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { CONNECTION_CAPABILITY_TCP_ENC_V1 } from '../src/types/protocol.js';

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const buyerIdentity = identityFromPrivateKeyHex('22'.repeat(32));
const managers: ConnectionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.closeAll();
    await manager.stopListening();
  }
});

async function listen(acceptInboundAddress: (remoteAddress: string) => boolean): Promise<number> {
  const manager = new ConnectionManager(undefined, { acceptInboundAddress });
  managers.push(manager);
  manager.setLocalIdentity(sellerIdentity);
  await manager.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });
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
    });
    socket.on('close', () => resolve(received));
    socket.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' ? resolve(received) : reject(err)));
  });
}

function waitForFailure(conn: PeerConnection): Promise<Error | null> {
  return new Promise((resolve) => {
    conn.on('error', () => {});
    conn.on('stateChange', (state) => {
      if (state === 'failed' || state === 'closed') resolve(conn.failureReason);
    });
  });
}

describe('ConnectionManager acceptInboundAddress', () => {
  it('answers refused HTTP requests with 403 and the refusal message', async () => {
    const seen: string[] = [];
    const port = await listen((address) => {
      seen.push(address);
      return false;
    });

    const response = await probe(port);
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain(INBOUND_REFUSED_MESSAGE);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/127\.0\.0\.1$/);
  });

  it('fails a refused buyer connection with the refusal message', async () => {
    const port = await listen(() => false);
    const buyer = new ConnectionManager();
    managers.push(buyer);
    buyer.setLocalIdentity(buyerIdentity);

    const outbound = buyer.createConnection({
      remotePeerId: sellerIdentity.peerId,
      isInitiator: true,
      endpoint: { host: '127.0.0.1', port },
      remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
    });

    expect((await waitForFailure(outbound))?.message).toBe(INBOUND_REFUSED_MESSAGE);
  });

  it('serves sockets whose remote address is accepted', async () => {
    const port = await listen(() => true);

    expect(await probe(port)).toMatch(/^HTTP\/1\.1 (200|503) /);
  });
});
