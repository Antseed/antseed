import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameDecoder } from '@antseed/protocol/framing';
import { RELAY_RESPONSE_WAIT_MS, encodeRelayClose, encodeRelayData, encodeRelayOpen } from '@antseed/protocol/blind-relay';
import { RelayMux, type RelayGrant } from '../src/p2p/relay-mux.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import { MessageType } from '../src/types/protocol.js';
import { AntseedNode } from '../src/node.js';
import type { PeerInfo } from '../src/types/peer.js';

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

  /** A seller's mux alone, fed frames as a buyer would send them; `sent` is what it answers. */
  function sellerAlone(authorize: (streamId: string, credentialId: string) => Promise<RelayGrant>, options: { maxBufferedBytes?: number } = {}) {
    const sent: number[] = [];
    const decoder = new FrameDecoder();
    const mux = new RelayMux({
      send: (data: Uint8Array) => { for (const frame of decoder.feed(data)) sent.push(frame.type); },
    } as unknown as PeerConnection, { authorize, ...options });
    let messageId = 0;
    const feed = (type: MessageType, payload: Uint8Array) => mux.handleFrame({ type, messageId: messageId++, payload });
    return { mux, sent, feed };
  }

  /** An authorizer the test answers when it chooses. */
  function deferredGrant() {
    const closed: Array<{ bytesUp: number; bytesDown: number; error?: string }> = [];
    let opened = 0;
    let resolve!: (grant: RelayGrant) => void;
    const asked = new Promise<RelayGrant>((done) => { resolve = done; });
    const grant: RelayGrant = { open: () => { opened += 1; return upperStream(); }, onClose: (stats) => closed.push(stats) };
    return { authorize: () => asked, answer: () => resolve(grant), closed, opened: () => opened };
  }

  it('tells a grant that arrives after the buyer cancelled the stream that it closed, and never opens it', async () => {
    const pending = deferredGrant();
    const { mux, feed } = sellerAlone(pending.authorize);
    const opening = feed(MessageType.RelayOpen, encodeRelayOpen({ streamId: 'late', credentialId: 'cred' }));
    await feed(MessageType.RelayClose, encodeRelayClose({ streamId: 'late', reason: 'cancelled' }));
    pending.answer();
    await opening;
    expect(pending.opened()).toBe(0);
    expect(pending.closed).toEqual([{ bytesUp: 0, bytesDown: 0, error: 'closed before it opened' }]);
    expect(mux.openStreams).toBe(0);
  });

  it('tells a grant that arrives after the connection closed that it closed, and never opens it', async () => {
    const pending = deferredGrant();
    const { mux, feed } = sellerAlone(pending.authorize);
    const opening = feed(MessageType.RelayOpen, encodeRelayOpen({ streamId: 'gone', credentialId: 'cred' }));
    mux.close();
    pending.answer();
    await opening;
    expect(pending.opened()).toBe(0);
    expect(pending.closed).toEqual([{ bytesUp: 0, bytesDown: 0, error: 'closed before it opened' }]);
  });

  it('closes a stream whose seller side stops reading, instead of holding what the buyer keeps sending', async () => {
    const closed: Array<{ error?: string }> = [];
    // Never finishes a write: everything after the first chunk waits in the stream.
    const stalled = new Duplex({ read() {}, write() {} });
    const { mux, sent, feed } = sellerAlone(async () => ({ open: () => stalled, onClose: (stats) => closed.push(stats) }), { maxBufferedBytes: 64 * 1024 });
    await feed(MessageType.RelayOpen, encodeRelayOpen({ streamId: 'slow', credentialId: 'cred' }));
    const chunk = new Uint8Array(16 * 1024);
    for (let i = 0; i < 64; i += 1) await feed(MessageType.RelayData, encodeRelayData({ streamId: 'slow', data: chunk }));
    expect(stalled.writableLength).toBeLessThanOrEqual(64 * 1024 + chunk.length);
    expect(stalled.destroyed).toBe(true);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.error).toMatch(/fell behind/);
    expect(sent).toContain(MessageType.RelayClose);
    expect(mux.openStreams).toBe(0);
  });

  it('closes a stream whose grant takes no more bytes, with its reason, before writing them', async () => {
    const closed: Array<{ error?: string }> = [];
    const received: number[] = [];
    const local = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) { received.push(chunk.length); callback(); } });
    let room = 100;
    const { mux, sent, feed } = sellerAlone(async () => ({
      open: () => local,
      accept: (bytes) => {
        if (bytes > room) return false;
        room -= bytes;
        return true;
      },
      onClose: (stats) => closed.push(stats),
    }));
    await feed(MessageType.RelayOpen, encodeRelayOpen({ streamId: 'full', credentialId: 'cred' }));
    await feed(MessageType.RelayData, encodeRelayData({ streamId: 'full', data: new Uint8Array(60) }));
    await feed(MessageType.RelayData, encodeRelayData({ streamId: 'full', data: new Uint8Array(60) }));
    expect(received).toEqual([60]);
    expect(local.destroyed).toBe(true);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.error).toMatch(/too many request bytes/);
    expect(sent).toContain(MessageType.RelayClose);
    expect(mux.openStreams).toBe(0);
  });

  it('closes a stream whose buyer side stops reading, instead of holding what the seller keeps sending', async () => {
    const sellerSide = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const ends: { mux?: RelayMux }[] = [{}, {}];
    const conn = (to: number) => {
      const decoder = new FrameDecoder();
      return { send: (data: Uint8Array) => { for (const frame of decoder.feed(data)) void ends[to]!.mux!.handleFrame(frame); } } as unknown as PeerConnection;
    };
    ends[0]!.mux = new RelayMux(conn(1), { maxBufferedBytes: 64 * 1024 });
    ends[1]!.mux = new RelayMux(conn(0), { authorize: async () => ({ open: () => sellerSide }) });
    // Opened and never read.
    const stream = await ends[0]!.mux!.openStream('unread', 'cred');
    const failed = new Promise<string>((resolve) => stream.on('error', (error) => resolve(error.message)));
    for (let i = 0; i < 64 && !sellerSide.destroyed; i += 1) {
      sellerSide.push(Buffer.alloc(16 * 1024));
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(await failed).toMatch(/fell behind/);
    expect(stream.readableLength).toBeLessThanOrEqual(64 * 1024 + 16 * 1024);
    expect(sellerSide.destroyed).toBe(true);
  });

  it('ends open streams when the connection closes', async () => {
    const { buyer } = linked(async () => ({ open: () => upperStream() }));
    const stream = await buyer.openStream('s4', 'cred');
    const failed = new Promise<string>((resolve) => stream.on('error', (error) => resolve(error.message)));
    buyer.close();
    expect(await failed).toBe('connection closed');
  });
});

describe('RelayMux idle streams', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stream to a seller side that answers only when the test tells it to: an upstream that takes its time. */
  async function quietStream() {
    vi.useFakeTimers();
    const closed: Array<{ error?: string }> = [];
    const sellerSide: Duplex = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const { buyer } = linked(async () => ({ open: () => sellerSide, onClose: (stats) => closed.push(stats) }));
    const stream = await buyer.openStream('quiet', 'cred');
    const received: string[] = [];
    const failures: string[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    stream.on('error', (error) => failures.push(error.message));
    stream.write('the request');
    await vi.advanceTimersByTimeAsync(10);
    return { stream, sellerSide, closed, received, failures };
  }

  it('keeps a stream open through the whole wait a buyer gives an answer to start', async () => {
    const { stream, sellerSide, closed, received, failures } = await quietStream();
    // Longer than two minutes: an upstream that thinks before its first byte.
    await vi.advanceTimersByTimeAsync(RELAY_RESPONSE_WAIT_MS);
    expect([stream.destroyed, sellerSide.destroyed, closed, failures]).toEqual([false, false, [], []]);
    sellerSide.push('the answer');
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual(['the answer']);
  });

  it('keeps a stream open through the whole pause a buyer gives a started answer', async () => {
    const { stream, sellerSide, closed, received, failures } = await quietStream();
    sellerSide.push('the answer starts');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(RELAY_RESPONSE_WAIT_MS);
    expect([stream.destroyed, sellerSide.destroyed, closed, failures]).toEqual([false, false, [], []]);
    sellerSide.push(', and ends');
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual(['the answer starts', ', and ends']);
  });

  it('still ends a stream that stays idle past the buyer\'s wait, on both sides', async () => {
    const { stream, sellerSide, closed, failures } = await quietStream();
    await vi.advanceTimersByTimeAsync(RELAY_RESPONSE_WAIT_MS + 60_000);
    expect(stream.destroyed).toBe(true);
    expect(sellerSide.destroyed).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/idle/);
    expect(closed).toMatchObject([{ error: 'idle' }]);
  });
});

describe('AntseedNode.openRelayStream', () => {
  it('opens no stream on a connection other than the one a TEE attestation covered', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = { peerId: 'a'.repeat(40) } as PeerInfo;
    const sent: Uint8Array[] = [];
    // The attested connection (`session-1`) closed, and the seller is reached over a new one.
    const replacement = { channelBinding: 'session-2', send: (data: Uint8Array) => { sent.push(data); } };
    (node as unknown as { _getOrCreateConnection: () => Promise<unknown> })._getOrCreateConnection = async () => replacement;

    await expect(node.openRelayStream(peer, 'stream-1', 'cred-1', undefined, { channelBinding: 'session-1' }))
      .rejects.toMatchObject({ attribution: 'buyer', code: 'buyer-tee-connection-changed' });
    expect(sent).toHaveLength(0);

    // Without a binding, or on the connection it names, the stream is asked for.
    void node.openRelayStream(peer, 'stream-2', 'cred-1', undefined, { channelBinding: 'session-2' }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);
    (node as unknown as { _relayMuxes: Map<string, RelayMux> })._relayMuxes.get(peer.peerId)!.close();
  });
});
