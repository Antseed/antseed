import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameDecoder } from '@antseed/protocol/framing';
import { RelayMux, type RelayGrant } from '../src/p2p/relay-mux.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';

/** Two muxes joined back to back, as a buyer and a seller over one connection. */
function linked(authorize?: (streamId: string, credentialId: string) => Promise<RelayGrant>) {
  const ends: { mux?: RelayMux } [] = [{}, {}];
  const conn = (to: number) => {
    const decoder = new FrameDecoder();
    return {
      send: (data: Uint8Array) => {
        for (const frame of decoder.feed(data)) void ends[to]!.mux!.handleFrame(frame);
      },
    } as unknown as PeerConnection;
  };
  ends[0]!.mux = new RelayMux(conn(1));
  ends[1]!.mux = new RelayMux(conn(0), authorize ? { authorize } : {});
  return { buyer: ends[0]!.mux!, seller: ends[1]!.mux! };
}

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** An upstream that answers each line with it uppercased, then closes. */
async function upperServer(): Promise<number> {
  server = createServer((socket) => {
    socket.on('data', (data) => {
      socket.end(data.toString().toUpperCase());
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

describe('RelayMux', () => {
  it('relays bytes both ways to the host the seller chose, and reports the byte counts', async () => {
    const port = await upperServer();
    const closed: Array<{ bytesUp: number; bytesDown: number }> = [];
    const asked: string[] = [];
    const { buyer } = linked(async (_streamId, credentialId) => {
      asked.push(credentialId);
      return { host: '127.0.0.1', port, onClose: (stats) => closed.push(stats) };
    });
    const stream = await buyer.openStream('s1', 'cred-1');
    const answer = readAll(stream);
    stream.write('hello relay');
    expect(await answer).toBe('HELLO RELAY');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(['cred-1']);
    expect(closed).toEqual([{ bytesUp: 11, bytesDown: 11 }]);
  });

  it('refuses a stream the seller does not authorize, with its reason', async () => {
    const { buyer } = linked(async () => { throw new Error('unknown credential'); });
    await expect(buyer.openStream('s2', 'nope')).rejects.toThrow('unknown credential');
    expect(buyer.openStreams).toBe(0);
  });

  it('refuses every stream on a peer that does not relay', async () => {
    const { buyer } = linked();
    await expect(buyer.openStream('s3', 'cred')).rejects.toThrow('this seller does not relay');
  });

  it('ends open streams when the connection closes', async () => {
    const port = await upperServer();
    const { buyer } = linked(async () => ({ host: '127.0.0.1', port }));
    const stream = await buyer.openStream('s4', 'cred');
    const failed = new Promise<string>((resolve) => stream.on('error', (error) => resolve(error.message)));
    buyer.close();
    expect(await failed).toBe('connection closed');
  });
});
