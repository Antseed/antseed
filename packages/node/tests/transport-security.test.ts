import net, { type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  buildSdpAuthEnvelope,
  buildTcpEncAck,
  buildTcpEncOffer,
  verifyConnectionAuthEnvelope,
  verifySdpAuthEnvelope,
  verifyTcpEncAck,
  verifyTcpEncOffer,
} from '../src/p2p/connection-auth.js';
import { ConnectionManager, type PeerConnection } from '../src/p2p/connection-manager.js';
import { FrameEncryptor, deriveSessionKeys, generateEphemeralKeyPair } from '../src/p2p/secure-channel.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import {
  CONNECTION_CAPABILITY_TCP_ENC_V1,
} from '../src/types/protocol.js';

const sellerIdentity = identityFromPrivateKeyHex('11'.repeat(32));
const buyerIdentity = identityFromPrivateKeyHex('22'.repeat(32));
const mitmIdentity = identityFromPrivateKeyHex('33'.repeat(32));

const managers: ConnectionManager[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

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
    conn.on('stateChange', (state) => {
      if (state === 'open') resolve();
      if (state === 'failed' || state === 'closed') reject(new Error(`connection ${state}`));
    });
    conn.on('error', () => {});
  });
}

function waitForFailure(conn: PeerConnection): Promise<void> {
  return new Promise((resolve) => {
    conn.on('error', () => {});
    conn.on('stateChange', (state) => {
      if (state === 'failed' || state === 'closed') resolve();
    });
  });
}

function waitForMessage(conn: PeerConnection): Promise<Uint8Array> {
  return new Promise((resolve) => conn.once('message', resolve));
}

/** TCP proxy recording every byte in both directions. */
async function startRecordingProxy(targetPort: number): Promise<{ port: number; captured: Buffer[] }> {
  const captured: Buffer[] = [];
  const server = net.createServer((client) => {
    sockets.push(client);
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    sockets.push(upstream);
    client.on('data', (chunk) => { captured.push(chunk); upstream.write(chunk); });
    upstream.on('data', (chunk) => { captured.push(chunk); client.write(chunk); });
    const closeBoth = (): void => { client.destroy(); upstream.destroy(); };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no proxy port');
  return { port: address.port, captured };
}

describe('transport security', () => {
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const manager of managers.splice(0)) {
      manager.closeAll();
      await manager.stopListening();
    }
  });

  describe('signed SDP envelopes', () => {
    const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n';

    it('accepts a valid envelope from the expected peer', () => {
      const auth = buildSdpAuthEnvelope(sellerIdentity.peerId, sellerIdentity.wallet, 'answer', sdp);
      const result = verifySdpAuthEnvelope({
        auth,
        expectedPeerId: sellerIdentity.peerId,
        descriptionType: 'answer',
        sdp,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects an envelope signed by a different peer than the connection targets', () => {
      const auth = buildSdpAuthEnvelope(mitmIdentity.peerId, mitmIdentity.wallet, 'answer', sdp);
      const result = verifySdpAuthEnvelope({
        auth,
        expectedPeerId: sellerIdentity.peerId,
        descriptionType: 'answer',
        sdp,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/does not match/);
    });

    it('rejects when the SDP was substituted after signing', () => {
      const auth = buildSdpAuthEnvelope(sellerIdentity.peerId, sellerIdentity.wallet, 'answer', sdp);
      const result = verifySdpAuthEnvelope({
        auth,
        expectedPeerId: sellerIdentity.peerId,
        descriptionType: 'answer',
        sdp: 'v=0\r\na=fingerprint:sha-256 EE:VV:1L\r\n',
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/signature/);
    });

    it('rejects replayed envelopes', () => {
      const guard = new NonceReplayGuard();
      const auth = buildSdpAuthEnvelope(sellerIdentity.peerId, sellerIdentity.wallet, 'offer', sdp);
      const opts = {
        auth,
        expectedPeerId: sellerIdentity.peerId,
        descriptionType: 'offer',
        sdp,
        replayGuard: guard,
      };
      expect(verifySdpAuthEnvelope(opts).ok).toBe(true);
      const replayed = verifySdpAuthEnvelope(opts);
      expect(replayed.ok).toBe(false);
      expect(replayed.reason).toMatch(/replayed/);
    });
  });

  describe('v2 auth envelopes (transport binding)', () => {
    const capabilities = ['transport.tcp-enc.v1', 'verification.response-auth.v1'];
    const encPub = 'ab'.repeat(32);

    it('verifies when wire values match the signed binding', () => {
      const auth = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet, Date.now(), { capabilities, encPub });
      expect(auth.v).toBe(2);
      expect(verifyConnectionAuthEnvelope({
        type: 'intro',
        auth,
        wireCapabilities: capabilities,
        wireEncPub: encPub,
      }).ok).toBe(true);
    });

    it('rejects capabilities merged into a single delimiter-containing string', () => {
      const caps = ['a', 'b', 'transport.signed-sdp.v1'];
      const auth = buildConnectionAuthEnvelope('hello', buyerIdentity.peerId, buyerIdentity.wallet, Date.now(), { capabilities: caps });
      expect(verifyConnectionAuthEnvelope({
        type: 'hello',
        auth,
        wireCapabilities: [caps.join(',')],
      }).ok).toBe(false);
    });

    it('rejects when capabilities were stripped from the wire', () => {
      const auth = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet, Date.now(), { capabilities, encPub });
      expect(verifyConnectionAuthEnvelope({
        type: 'intro',
        auth,
        wireCapabilities: [],
        wireEncPub: encPub,
      }).ok).toBe(false);
    });

    it('rejects when the enc offer was stripped from the wire', () => {
      const auth = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet, Date.now(), { capabilities, encPub });
      expect(verifyConnectionAuthEnvelope({
        type: 'intro',
        auth,
        wireCapabilities: capabilities,
        wireEncPub: null,
      }).ok).toBe(false);
    });

    it('rejects when the version marker is stripped', () => {
      const auth = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet, Date.now(), { capabilities, encPub });
      const downgraded = { ...auth };
      delete (downgraded as { v?: 2 }).v;
      expect(verifyConnectionAuthEnvelope({
        type: 'intro',
        auth: downgraded,
        wireCapabilities: capabilities,
        wireEncPub: encPub,
      }).ok).toBe(false);
    });

    it('rejects unknown envelope versions', () => {
      const auth = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet);
      expect(verifyConnectionAuthEnvelope({
        type: 'intro',
        auth: { ...auth, v: 3 as unknown as 2 },
      }).ok).toBe(false);
    });
  });

  describe('tcp enc handshake envelopes', () => {
    it('verifies a valid offer and rejects a tampered public key', () => {
      const intro = buildConnectionAuthEnvelope('intro', buyerIdentity.peerId, buyerIdentity.wallet);
      const eph = generateEphemeralKeyPair();
      const offer = buildTcpEncOffer(buyerIdentity.wallet, buyerIdentity.peerId, intro.ts, intro.nonce, eph.publicKeyHex);

      expect(verifyTcpEncOffer({
        offer,
        peerId: buyerIdentity.peerId,
        introTs: intro.ts,
        introNonce: intro.nonce,
      }).ok).toBe(true);

      const attacker = generateEphemeralKeyPair();
      expect(verifyTcpEncOffer({
        offer: { ...offer, pub: attacker.publicKeyHex },
        peerId: buyerIdentity.peerId,
        introTs: intro.ts,
        introNonce: intro.nonce,
      }).ok).toBe(false);
    });

    it('verifies a valid ack and rejects one bound to a different handshake', () => {
      const eph = generateEphemeralKeyPair();
      const initiatorNonce = 'ab'.repeat(16);
      const ack = buildTcpEncAck(sellerIdentity.wallet, sellerIdentity.peerId, eph.publicKeyHex, initiatorNonce);

      expect(verifyTcpEncAck({
        ack,
        expectedPeerId: sellerIdentity.peerId,
        initiatorNonce,
      }).ok).toBe(true);

      expect(verifyTcpEncAck({
        ack,
        expectedPeerId: sellerIdentity.peerId,
        initiatorNonce: 'cd'.repeat(16),
      }).ok).toBe(false);

      expect(verifyTcpEncAck({
        ack,
        expectedPeerId: buyerIdentity.peerId,
        initiatorNonce,
      }).ok).toBe(false);
    });
  });

  describe('encrypted tcp transport (integration)', () => {
    it('encrypts all payload traffic when the peer advertises support', async () => {
      const seller = trackManager(new ConnectionManager());
      const buyer = trackManager(new ConnectionManager());
      seller.setLocalIdentity(sellerIdentity);
      buyer.setLocalIdentity(buyerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      const proxy = await startRecordingProxy(seller.getListeningPort()!);

      const inboundPromise = waitForConnection(seller);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        endpoint: { host: '127.0.0.1', port: proxy.port },
        remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      });

      const inbound = await inboundPromise;
      await waitForOpen(outbound);
      expect(outbound.isEncryptedTransport).toBe(true);
      expect(inbound.isEncryptedTransport).toBe(true);
      // Both ends name the same session, which a TEE seller binds into its attestation quote.
      expect(outbound.channelBinding).toMatch(/^[0-9a-f]{64}$/);
      expect(inbound.channelBinding).toBe(outbound.channelBinding);

      const secret = 'super-secret prompt payload 0xDEADBEEF';
      const inboundMessage = waitForMessage(inbound);
      outbound.send(new TextEncoder().encode(secret));
      expect(new TextDecoder().decode(await inboundMessage)).toBe(secret);

      const replySecret = 'assistant response with private data';
      const outboundMessage = waitForMessage(outbound);
      inbound.send(new TextEncoder().encode(replySecret));
      expect(new TextDecoder().decode(await outboundMessage)).toBe(replySecret);

      const wire = Buffer.concat(proxy.captured).toString('latin1');
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain(replySecret);
    });

    it('falls back to plaintext for legacy peers (no capability advertised)', async () => {
      const seller = trackManager(new ConnectionManager());
      const buyer = trackManager(new ConnectionManager());
      seller.setLocalIdentity(sellerIdentity);
      buyer.setLocalIdentity(buyerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      const inboundPromise = waitForConnection(seller);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      });

      const inbound = await inboundPromise;
      await waitForOpen(outbound);
      expect(outbound.isEncryptedTransport).toBe(false);
      expect(inbound.isEncryptedTransport).toBe(false);
      expect(outbound.channelBinding).toBeNull();
      expect(inbound.channelBinding).toBeNull();

      const inboundMessage = waitForMessage(inbound);
      outbound.send(new TextEncoder().encode('legacy plaintext'));
      expect(new TextDecoder().decode(await inboundMessage)).toBe('legacy plaintext');
    });

    it('strict mode rejects inbound plaintext intros', async () => {
      const seller = trackManager(new ConnectionManager(undefined, { requireSecureTransport: true }));
      const buyer = trackManager(new ConnectionManager());
      seller.setLocalIdentity(sellerIdentity);
      buyer.setLocalIdentity(buyerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      let inboundAccepted = false;
      seller.once('connection', () => { inboundAccepted = true; });

      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        timeoutMs: 500,
        endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      });
      await waitForFailure(outbound);
      expect(inboundAccepted).toBe(false);
    });

    it('strict mode still connects encrypted', async () => {
      const seller = trackManager(new ConnectionManager(undefined, { requireSecureTransport: true }));
      const buyer = trackManager(new ConnectionManager(undefined, { requireSecureTransport: true }));
      seller.setLocalIdentity(sellerIdentity);
      buyer.setLocalIdentity(buyerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      const inboundPromise = waitForConnection(seller);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        endpoint: { host: '127.0.0.1', port: seller.getListeningPort()! },
      });
      const inbound = await inboundPromise;
      await waitForOpen(outbound);
      expect(outbound.isEncryptedTransport).toBe(true);
      expect(inbound.isEncryptedTransport).toBe(true);
    });

    it('fails closed when a MITM answers the enc handshake with its own identity', async () => {
      const impostor = net.createServer((socket) => {
        sockets.push(socket);
        socket.once('data', () => {
          const eph = generateEphemeralKeyPair();
          const ack = buildTcpEncAck(mitmIdentity.wallet, mitmIdentity.peerId, eph.publicKeyHex, 'ab'.repeat(16));
          socket.write(JSON.stringify(ack) + '\n');
        });
      });
      servers.push(impostor);
      await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve));
      const address = impostor.address();
      if (!address || typeof address === 'string') throw new Error('no port');

      const buyer = trackManager(new ConnectionManager());
      buyer.setLocalIdentity(buyerIdentity);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        timeoutMs: 2_000,
        endpoint: { host: '127.0.0.1', port: address.port },
        remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      });
      await waitForFailure(outbound);
      expect(outbound.state === 'failed' || outbound.state === 'closed').toBe(true);
    });

    it('rejects an intro whose enc offer and capabilities were stripped in transit', async () => {
      const seller = trackManager(new ConnectionManager());
      const buyer = trackManager(new ConnectionManager());
      seller.setLocalIdentity(sellerIdentity);
      buyer.setLocalIdentity(buyerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      let sellerAccepted = false;
      seller.once('connection', () => { sellerAccepted = true; });

      // MITM proxy that strips `enc` and `capabilities` from the intro line to
      // force a plaintext downgrade.
      const sellerPort = seller.getListeningPort()!;
      const mitm = net.createServer((client) => {
        sockets.push(client);
        const upstream = net.connect({ host: '127.0.0.1', port: sellerPort });
        sockets.push(upstream);
        let stripped = false;
        let buffered = '';
        client.on('data', (chunk) => {
          if (stripped) { upstream.write(chunk); return; }
          buffered += chunk.toString('utf8');
          const lineBreak = buffered.indexOf('\n');
          if (lineBreak < 0) return;
          const intro = JSON.parse(buffered.slice(0, lineBreak));
          delete intro.enc;
          delete intro.capabilities;
          stripped = true;
          upstream.write(JSON.stringify(intro) + '\n' + buffered.slice(lineBreak + 1));
        });
        upstream.on('data', (chunk) => client.write(chunk));
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        upstream.on('close', () => client.destroy());
      });
      servers.push(mitm);
      await new Promise<void>((resolve) => mitm.listen(0, '127.0.0.1', resolve));
      const mitmAddress = mitm.address();
      if (!mitmAddress || typeof mitmAddress === 'string') throw new Error('no port');

      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        timeoutMs: 1_000,
        endpoint: { host: '127.0.0.1', port: mitmAddress.port },
        remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      });
      await waitForFailure(outbound);
      expect(sellerAccepted).toBe(false);
    });

    it('opens when the enc-ack and the first encrypted frame arrive coalesced', async () => {
      // Responder that writes the ack line and a large first frame in one chunk.
      const responderEph = generateEphemeralKeyPair();
      const payload = new Uint8Array(20_000).fill(0x42);
      const responder = net.createServer((socket) => {
        sockets.push(socket);
        let buffered = '';
        socket.on('data', (chunk) => {
          buffered += chunk.toString('utf8');
          const lineBreak = buffered.indexOf('\n');
          if (lineBreak < 0) return;
          const intro = JSON.parse(buffered.slice(0, lineBreak));
          const ack = buildTcpEncAck(sellerIdentity.wallet, sellerIdentity.peerId, responderEph.publicKeyHex, intro.auth.nonce);
          const keys = deriveSessionKeys(responderEph.privateKey, intro.enc.pub, {
            initiatorPeerId: buyerIdentity.peerId,
            responderPeerId: sellerIdentity.peerId,
            initiatorNonce: intro.auth.nonce,
            responderNonce: ack.nonce,
            initiatorPubHex: intro.enc.pub,
            responderPubHex: responderEph.publicKeyHex,
          }, false);
          const frame = new FrameEncryptor(keys.sendKey).encrypt(payload);
          socket.write(Buffer.concat([Buffer.from(JSON.stringify(ack) + '\n', 'utf8'), frame]));
        });
      });
      servers.push(responder);
      await new Promise<void>((resolve) => responder.listen(0, '127.0.0.1', resolve));
      const address = responder.address();
      if (!address || typeof address === 'string') throw new Error('no port');

      const buyer = trackManager(new ConnectionManager());
      buyer.setLocalIdentity(buyerIdentity);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        timeoutMs: 5_000,
        endpoint: { host: '127.0.0.1', port: address.port },
        remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      });

      const firstMessage = waitForMessage(outbound);
      await waitForOpen(outbound);
      const received = await firstMessage;
      expect(received).toHaveLength(20_000);
      expect(received.every((b) => b === 0x42)).toBe(true);
    });

    it('refuses inbound hello without crashing when webrtc is unavailable', async () => {
      const seller = trackManager(new ConnectionManager());
      seller.setLocalIdentity(sellerIdentity);
      await seller.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });

      let accepted = false;
      seller.once('connection', () => { accepted = true; });

      const socket = net.connect({ host: '127.0.0.1', port: seller.getListeningPort()! });
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(JSON.stringify({
        type: 'hello',
        auth: buildConnectionAuthEnvelope('hello', buyerIdentity.peerId, buyerIdentity.wallet),
      }) + '\n');

      await new Promise<void>((resolve) => socket.once('close', resolve));
      expect(accepted).toBe(false);
      expect(seller.getListeningPort()).not.toBeNull();
    });

    it('fails closed (no plaintext downgrade) when the responder never completes the handshake', async () => {
      const silent = net.createServer((socket) => { sockets.push(socket); });
      servers.push(silent);
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const address = silent.address();
      if (!address || typeof address === 'string') throw new Error('no port');

      const buyer = trackManager(new ConnectionManager());
      buyer.setLocalIdentity(buyerIdentity);
      const outbound = buyer.createConnection({
        remotePeerId: sellerIdentity.peerId,
        isInitiator: true,
        timeoutMs: 500,
        endpoint: { host: '127.0.0.1', port: address.port },
        remoteCapabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      });
      await waitForFailure(outbound);
      expect(outbound.isEncryptedTransport).toBe(false);
      expect(outbound.state === 'failed' || outbound.state === 'closed').toBe(true);
    });
  });
});
