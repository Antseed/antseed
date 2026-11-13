import net, { type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectionAuthEnvelope } from '../src/p2p/connection-auth.js';
import { ConnectionManager } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';

// Force init()'s TCP-fallback mode: the dynamic import of node-datachannel
// fails, as on hosts where the native module is missing or broken.
vi.mock('node-datachannel', () => {
  throw new Error('native module unavailable');
});

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const buyerIdentity = identityFromPrivateKeyHex('22'.repeat(32));

const managers: ConnectionManager[] = [];
const sockets: Socket[] = [];

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

describe('WebRTC signaling in TCP-fallback mode', () => {
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const manager of managers.splice(0)) {
      manager.closeAll();
      await manager.stopListening();
    }
  });

  it('refuses a browser hello gracefully and keeps serving TCP intros', async () => {
    const manager = await ConnectionManager.init();
    managers.push(manager);
    manager.setLocalIdentity({ peerId: sellerIdentity.peerId, wallet: sellerIdentity.wallet });
    const errors: Error[] = [];
    manager.on('error', (err: Error) => errors.push(err));
    manager.on('connection', () => {});
    await manager.startListening({ peerId: sellerIdentity.peerId, port: 0, host: '127.0.0.1' });
    const port = manager.getListeningPort();
    expect(port).toBeTruthy();

    // A browser buyer's hello must be refused (socket closed), not crash the
    // process the way an uncaught "node-datachannel not loaded" throw would.
    // The refusal is silent: no error is emitted for this expected condition.
    const helloSocket = await connectSocket(port!);
    const hello = buildConnectionAuthEnvelope('hello', buyerIdentity.peerId, buyerIdentity.wallet);
    helloSocket.write(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');
    await waitForClose(helloSocket);
    expect(errors).toHaveLength(0);

    // The plain TCP intro path must remain unaffected afterwards.
    const introSocket = await connectSocket(port!);
    const connectionPromise = new Promise((resolve) => manager.once('connection', resolve));
    const intro = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet);
    introSocket.write(JSON.stringify({ type: 'intro', auth: intro, capabilities: [] }) + '\n');
    await expect(connectionPromise).resolves.toBeTruthy();
  });
});
