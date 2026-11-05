import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionManager, parseMetadataVersionHeader } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { HttpMetadataResolver } from '../src/discovery/http-metadata-resolver.js';
import { METADATA_VERSION } from '../src/discovery/peer-metadata.js';

const sellerIdentity = identityFromPrivateKeyHex('33'.repeat(32));
const managers: ConnectionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.closeAll();
    await manager.stopListening();
  }
});

async function listen(seen: Array<number | undefined>): Promise<number> {
  const manager = new ConnectionManager();
  managers.push(manager);
  manager.setLocalIdentity(sellerIdentity);
  manager.setMetadataProvider((requestedVersion) => {
    seen.push(requestedVersion);
    return { version: requestedVersion ?? 12 };
  });
  await manager.startListening({ peerId: sellerIdentity.peerId, host: '127.0.0.1', port: 0 });
  return manager.getListeningPort()!;
}

function send(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(request));
    let received = '';
    socket.on('data', (chunk) => { received += chunk.toString(); });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });
}

describe('metadata version negotiation', () => {
  it('reads the requested version from the request header, case-insensitively', () => {
    expect(parseMetadataVersionHeader(Buffer.from('Host: x\r\nX-Antseed-Metadata-Version: 13\r\n\r\n'))).toBe(13);
    expect(parseMetadataVersionHeader(Buffer.from('Host: x\r\n\r\nx-antseed-metadata-version: 13\r\n'))).toBeUndefined();
    expect(parseMetadataVersionHeader(Buffer.from('x-antseed-metadata-version: thirteen\r\n\r\n'))).toBeUndefined();
    expect(parseMetadataVersionHeader(Buffer.from('\r\n'))).toBeUndefined();
  });

  it('passes the header to the metadata provider, and nothing for legacy buyers', async () => {
    const seen: Array<number | undefined> = [];
    const port = await listen(seen);
    expect(await send(port, 'GET /metadata HTTP/1.1\r\nHost: localhost\r\n\r\n')).toContain('{"version":12}');
    expect(await send(port, 'GET /metadata HTTP/1.1\r\nHost: localhost\r\nx-antseed-metadata-version: 13\r\n\r\n')).toContain('{"version":13}');
    expect(seen).toEqual([undefined, 13]);
  });

  it('waits for headers split across packets', async () => {
    const seen: Array<number | undefined> = [];
    const port = await listen(seen);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write('GET /metadata HTTP/1.1\r\nHost: localhost\r\n');
        setTimeout(() => socket.write('x-antseed-metadata-version: 13\r\n\r\n'), 20);
      });
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString(); });
      socket.on('close', () => resolve(received));
      socket.on('error', reject);
    });
    expect(response).toContain('{"version":13}');
  });

  it('makes the buyer resolver ask for its newest version', async () => {
    const seen: Array<number | undefined> = [];
    const port = await listen(seen);
    await new HttpMetadataResolver({ failureCooldownMs: 0 }).resolve({ host: '127.0.0.1', port });
    expect(seen).toEqual([METADATA_VERSION]);
  });
});
