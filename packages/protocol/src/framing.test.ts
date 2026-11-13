import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, FrameDecoder } from './framing.js';
import { MessageType, FRAME_HEADER_SIZE, MAX_PAYLOAD_SIZE } from './messages.js';

const payload = new TextEncoder().encode('hello frames');

describe('frame codec', () => {
  it('round-trips a frame', () => {
    const encoded = encodeFrame({ type: MessageType.HttpRequest, messageId: 42, payload });
    expect(encoded.length).toBe(FRAME_HEADER_SIZE + payload.length);
    const decoded = decodeFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.message.type).toBe(MessageType.HttpRequest);
    expect(decoded!.message.messageId).toBe(42);
    expect(Buffer.from(decoded!.message.payload)).toEqual(Buffer.from(payload));
    expect(decoded!.bytesConsumed).toBe(encoded.length);
  });

  it('pins the big-endian header layout', () => {
    const encoded = encodeFrame({ type: 0x20, messageId: 0x01020304, payload: Uint8Array.of(0xff) });
    expect([...encoded]).toEqual([0x20, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x01, 0xff]);
  });

  it('reassembles frames split across chunks', () => {
    const encoded = encodeFrame({ type: MessageType.AuthAck, messageId: 7, payload });
    const decoder = new FrameDecoder();
    expect(decoder.feed(encoded.slice(0, 5))).toEqual([]);
    const frames = decoder.feed(encoded.slice(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.messageId).toBe(7);
  });

  it('decodes multiple coalesced frames', () => {
    const a = encodeFrame({ type: MessageType.Ping, messageId: 1, payload: new Uint8Array(8) });
    const b = encodeFrame({ type: MessageType.Pong, messageId: 2, payload: new Uint8Array(8) });
    const merged = new Uint8Array([...a, ...b]);
    const frames = new FrameDecoder().feed(merged);
    expect(frames.map((f) => f.type)).toEqual([MessageType.Ping, MessageType.Pong]);
  });

  it('rejects oversized payload declarations', () => {
    const bogus = new Uint8Array(FRAME_HEADER_SIZE);
    new DataView(bogus.buffer).setUint32(5, MAX_PAYLOAD_SIZE + 1);
    const decoder = new FrameDecoder();
    expect(() => decoder.feed(bogus)).toThrow(/exceeds maximum/);
    expect(decoder.bufferedBytes).toBe(0);
  });
});
