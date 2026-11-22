import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
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

/** A seller-side stream that answers what it gets uppercased, then ends. */
function upperStream(received: string[] = []): Duplex {
  const local: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      received.push(chunk.toString());
      local.push(chunk.toString().toUpperCase());
      local.push(null);
      callback();
    },
  });
  return local;
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
  it('relays bytes both ways to the stream the seller supplies, and reports the byte counts', async () => {
    const closed: Array<{ bytesUp: number; bytesDown: number }> = [];
    const asked: string[] = [];
    const received: string[] = [];
    const { buyer } = linked(async (_streamId, credentialId) => {
      asked.push(credentialId);
      return { open: () => upperStream(received), onClose: (stats) => closed.push(stats) };
    });
    const stream = await buyer.openStream('s1', 'cred-1');
    const answer = readAll(stream);
    stream.write('hello relay');
    expect(await answer).toBe('HELLO RELAY');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(['cred-1']);
    expect(received).toEqual(['hello relay']);
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

  it('refuses a stream whose seller side fails to open, with its reason', async () => {
    const { buyer } = linked(async () => ({ open: () => { throw new Error('no sidecar'); } }));
    await expect(buyer.openStream('s-fail', 'cred')).rejects.toThrow('no sidecar');
  });

  it('ends open streams when the connection closes', async () => {
    const { buyer } = linked(async () => ({ open: () => upperStream() }));
    const stream = await buyer.openStream('s4', 'cred');
    const failed = new Promise<string>((resolve) => stream.on('error', (error) => resolve(error.message)));
    buyer.close();
    expect(await failed).toBe('connection closed');
  });
});
