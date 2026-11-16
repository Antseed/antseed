import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager, INBOUND_AT_CAPACITY_MESSAGE, type PeerConnection } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { CONNECTION_CAPABILITY_TCP_ENC_V1 } from '../src/types/protocol.js';
import { ConnectionState } from '../src/types/connection.js';

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const buyerIdentities = ['22', '33', '44'].map((byte) => identityFromPrivateKeyHex(byte.repeat(32)));
const managers: ConnectionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.closeAll();
    await manager.stopListening();
  }
});

async function listen(maxInboundConnections: number, maxInboundConnectionsPerIp?: number): Promise<number> {
  const manager = new ConnectionManager(undefined, { maxInboundConnections, ...(maxInboundConnectionsPerIp ? { maxInboundConnectionsPerIp } : {}) });
  managers.push(manager);
  manager.setLocalIdentity(sellerIdentity);
  manager.setMetadataProvider(() => ({ peerId: sellerIdentity.peerId }) as never);
  await manager.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });
  return manager.getListeningPort()!;
}

function connectBuyer(port: number, index: number): PeerConnection {
  const buyer = new ConnectionManager();
  managers.push(buyer);
  buyer.setLocalIdentity(buyerIdentities[index]!);
  const conn = buyer.createConnection({
    remotePeerId: sellerIdentity.peerId,
    isInitiator: true,
    endpoint: { host: '127.0.0.1', port },
    remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
  });
  conn.on('error', () => {});
  return conn;
}

/** Resolves once the connection opens (null) or fails (its reason). */
function settle(conn: PeerConnection): Promise<Error | null> {
  return new Promise((resolve) => {
    if (conn.state === ConnectionState.Open) return resolve(null);
    conn.on('stateChange', (state) => {
      if (state === ConnectionState.Open) resolve(null);
      if (state === ConnectionState.Failed || state === ConnectionState.Closed) resolve(conn.failureReason ?? new Error(state));
    });
  });
}

function probe(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET /metadata HTTP/1.1\r\nHost: localhost\r\n\r\n');
    });
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString(); });
    socket.on('close', () => resolve(received));
    socket.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' ? resolve(received) : reject(err)));
  });
}

describe('ConnectionManager inbound connection limits', () => {
  it('refuses a buyer past maxInboundConnections with the capacity message', async () => {
    const port = await listen(2);

    expect(await settle(connectBuyer(port, 0))).toBeNull();
    expect(await settle(connectBuyer(port, 1))).toBeNull();
    expect((await settle(connectBuyer(port, 2)))?.message).toBe(INBOUND_AT_CAPACITY_MESSAGE);
  });

  it('still serves metadata while the buyer limit is reached', async () => {
    const port = await listen(1);
    expect(await settle(connectBuyer(port, 0))).toBeNull();

    const response = await probe(port);
    expect(response).toMatch(/^HTTP\/1\.1 200 /);
    expect(response).toContain(sellerIdentity.peerId);
  });

  it('lets a connected buyer reconnect at the limit, replacing its old connection', async () => {
    const port = await listen(1);
    const first = connectBuyer(port, 0);
    expect(await settle(first)).toBeNull();
    const firstClosed = new Promise<void>((resolve) => first.on('stateChange', (state) => {
      if (state === ConnectionState.Closed || state === ConnectionState.Failed) resolve();
    }));

    expect(await settle(connectBuyer(port, 0))).toBeNull();
    await firstClosed;
    expect((await settle(connectBuyer(port, 1)))?.message).toBe(INBOUND_AT_CAPACITY_MESSAGE);
  });

  it('frees a slot when a buyer disconnects', async () => {
    const port = await listen(1);
    const first = connectBuyer(port, 0);
    expect(await settle(first)).toBeNull();
    const closed = new Promise<void>((resolve) => setTimeout(resolve, 100));
    first.close();
    await closed;

    expect(await settle(connectBuyer(port, 1))).toBeNull();
  });

  it('caps sockets from one IP at maxInboundConnectionsPerIp', async () => {
    const port = await listen(10, 2);
    expect(await settle(connectBuyer(port, 0))).toBeNull();
    expect(await settle(connectBuyer(port, 1))).toBeNull();
    // A third socket from the same address is closed on accept.
    expect(await settle(connectBuyer(port, 2))).not.toBeNull();
  });
});
