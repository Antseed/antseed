import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerConnection, SEND_HIGH_WATER_BYTES, SEND_STALL_TIMEOUT_MS } from '../src/p2p/connection-manager.js';
import { ConnectionState } from '../src/types/connection.js';

const MiB = 1024 * 1024;

/** A TCP socket that keeps `socket.writableLength` bytes unsent. */
function fakeSocket(writableLength = 0) {
  const socket = Object.assign(new EventEmitter(), {
    writableLength,
    writable: true,
    destroyed: false,
    written: 0,
    setKeepAlive: () => {},
    write(data: Uint8Array) { socket.written += data.length; return true; },
    end: () => {},
    destroy: () => { socket.destroyed = true; },
    removeAllListeners: () => socket,
  });
  return socket;
}

function openConnection(socket: unknown): PeerConnection {
  const conn = new PeerConnection({ remotePeerId: 'aa'.repeat(20) as never, isInitiator: false });
  conn.attachRawSocket(socket as never);
  conn.on('error', () => {});
  return conn;
}

describe('connection send backlog', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a sender go on while the peer keeps up', () => {
    const conn = openConnection(fakeSocket(SEND_HIGH_WATER_BYTES));
    expect(conn.whenWritable()).toBeUndefined();
  });

  it('makes a sender wait until the peer has read down to the high-water mark', async () => {
    const socket = fakeSocket(4 * MiB);
    const conn = openConnection(socket);
    let writable = false;
    void conn.whenWritable()!.then(() => { writable = true; });

    socket.writableLength = 2 * MiB;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writable).toBe(false);

    socket.writableLength = SEND_HIGH_WATER_BYTES;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writable).toBe(true);
    expect(conn.state).toBe(ConnectionState.Open);
    expect(conn.whenWritable()).toBeUndefined();
  });

  it('fails a peer that reads nothing, and releases the sender', async () => {
    const conn = openConnection(fakeSocket(4 * MiB));
    let writable = false;
    void conn.whenWritable()!.then(() => { writable = true; });

    await vi.advanceTimersByTimeAsync(SEND_STALL_TIMEOUT_MS - 1_000);
    expect(conn.state).toBe(ConnectionState.Open);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(conn.state).toBe(ConnectionState.Failed);
    expect(conn.failureReason?.message).toMatch(/stopped reading/);
    expect(writable).toBe(true);
  });

  it('keeps a slow peer that is still reading', async () => {
    const socket = fakeSocket(64 * MiB);
    const conn = openConnection(socket);
    void conn.whenWritable();

    for (let elapsed = 0; elapsed < SEND_STALL_TIMEOUT_MS * 3; elapsed += 10_000) {
      socket.writableLength -= 1024;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(conn.state).toBe(ConnectionState.Open);
  });

  it('watches a backlog no sender waits on', async () => {
    const socket = fakeSocket(0);
    const conn = openConnection(socket);
    conn.send(new Uint8Array(8));
    socket.writableLength = 4 * MiB;
    conn.send(new Uint8Array(8));

    await vi.advanceTimersByTimeAsync(SEND_STALL_TIMEOUT_MS + 1_000);
    expect(conn.state).toBe(ConnectionState.Failed);
  });

  it('refuses to queue more behind a socket that holds too much', () => {
    const socket = fakeSocket(257 * MiB);
    const conn = openConnection(socket);
    expect(() => conn.send(new Uint8Array(8))).toThrow(/not draining/);
    expect(socket.written).toBe(0);
    expect(conn.state).toBe(ConnectionState.Failed);
  });
});

describe('trySend', () => {
  it('sends like send', () => {
    const socket = fakeSocket();
    const conn = openConnection(socket);
    expect(conn.trySend(new Uint8Array(8))).toBe(true);
    expect(socket.written).toBe(8);
  });

  it('returns false instead of throwing when the socket is no longer writable', () => {
    const socket = fakeSocket();
    const conn = openConnection(socket);
    socket.writable = false;
    expect(conn.trySend(new Uint8Array(8))).toBe(false);
    expect(conn.state).toBe(ConnectionState.Failed);
  });
});
