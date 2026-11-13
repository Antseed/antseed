import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager, type PeerConnection } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import {
  CONNECTION_CAPABILITY_TCP_ENC_V1,
  CONNECTION_CAPABILITY_WEBRTC_V1,
} from '../src/types/protocol.js';

const sellerIdentity = identityFromPrivateKeyHex('44'.repeat(32));
const buyerIdentity = identityFromPrivateKeyHex('55'.repeat(32));

// Runs in its own worker: transport-mode detection is a process-wide static.
const probe = await ConnectionManager.init(undefined);
const webrtcAvailable = probe.supportsWebRtc;

const managers: ConnectionManager[] = [];

function trackManager(manager: ConnectionManager): ConnectionManager {
  managers.push(manager);
  return manager;
}

function waitForConnection(manager: ConnectionManager): Promise<PeerConnection> {
  return new Promise((resolve) => manager.once('connection', resolve));
}

function waitForOpen(conn: PeerConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    if (conn.state === 'open') return resolve();
    conn.on('error', () => {});
    conn.on('stateChange', (state) => {
      if (state === 'open') resolve();
      if (state === 'failed' || state === 'closed') reject(new Error(`connection ${state}`));
    });
  });
}

function waitForMessage(conn: PeerConnection): Promise<Uint8Array> {
  return new Promise((resolve) => conn.once('message', resolve));
}

const iceConfig = { iceServers: [] };

describe.skipIf(!webrtcAvailable)('webrtc transport', () => {
  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      manager.closeAll();
      await manager.stopListening();
    }
  });

  it('connects over webrtc with signed sdp when the peer advertises support', async () => {
    const seller = trackManager(new ConnectionManager(iceConfig));
    const buyer = trackManager(new ConnectionManager(iceConfig));
    seller.setLocalIdentity(sellerIdentity);
    buyer.setLocalIdentity(buyerIdentity);
    await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

    const inboundPromise = waitForConnection(seller);
    const outbound = buyer.createConnection({
      remotePeerId: sellerIdentity.peerId,
      isInitiator: true,
      timeoutMs: 10_000,
      endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      remoteCapabilities: [CONNECTION_CAPABILITY_WEBRTC_V1],
    });

    const inbound = await inboundPromise;
    await Promise.all([waitForOpen(outbound), waitForOpen(inbound)]);
    expect(outbound.isEncryptedTransport).toBe(true);
    expect(inbound.isEncryptedTransport).toBe(true);
    expect(inbound.hasRemoteCapability(CONNECTION_CAPABILITY_WEBRTC_V1)).toBe(true);

    const inboundMessage = waitForMessage(inbound);
    outbound.send(new TextEncoder().encode('over dtls'));
    expect(new TextDecoder().decode(await inboundMessage)).toBe('over dtls');

    const outboundMessage = waitForMessage(outbound);
    inbound.send(new TextEncoder().encode('reply over dtls'));
    expect(new TextDecoder().decode(await outboundMessage)).toBe('reply over dtls');
  }, 20_000);

  it('prefers encrypted tcp when the peer supports both transports', async () => {
    const seller = trackManager(new ConnectionManager(iceConfig));
    const buyer = trackManager(new ConnectionManager(iceConfig));
    seller.setLocalIdentity(sellerIdentity);
    buyer.setLocalIdentity(buyerIdentity);
    await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

    const inboundPromise = waitForConnection(seller);
    const outbound = buyer.createConnection({
      remotePeerId: sellerIdentity.peerId,
      isInitiator: true,
      timeoutMs: 10_000,
      endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      remoteCapabilities: [CONNECTION_CAPABILITY_WEBRTC_V1, CONNECTION_CAPABILITY_TCP_ENC_V1],
    });

    const inbound = await inboundPromise;
    await waitForOpen(outbound);
    expect(outbound.transportDescription).toBe('tcp-encrypted');
    // Data channels cap messages at ~256 KiB; TCP must carry full 1 MiB chunks.
    const big = new Uint8Array(1024 * 1024).fill(7);
    const inboundMessage = waitForMessage(inbound);
    outbound.send(big);
    expect(await inboundMessage).toHaveLength(big.length);
  }, 20_000);

  it('falls back to tcp when the peer does not advertise webrtc', async () => {
    const seller = trackManager(new ConnectionManager(iceConfig));
    const buyer = trackManager(new ConnectionManager(iceConfig));
    seller.setLocalIdentity(sellerIdentity);
    buyer.setLocalIdentity(buyerIdentity);
    await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

    const inboundPromise = waitForConnection(seller);
    const outbound = buyer.createConnection({
      remotePeerId: sellerIdentity.peerId,
      isInitiator: true,
      timeoutMs: 10_000,
      endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
    });

    const inbound = await inboundPromise;
    await waitForOpen(outbound);
    // Encrypted TCP, not a data channel: the seller sees an intro, not a hello.
    expect(inbound.hasRemoteCapability(CONNECTION_CAPABILITY_WEBRTC_V1)).toBe(true);
    const inboundMessage = waitForMessage(inbound);
    outbound.send(new TextEncoder().encode('tcp fallback'));
    expect(new TextDecoder().decode(await inboundMessage)).toBe('tcp fallback');
  }, 20_000);
});

describe('webrtc availability', () => {
  it('reports transport support', () => {
    expect(typeof webrtcAvailable).toBe('boolean');
  });
});
