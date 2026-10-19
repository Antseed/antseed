import { describe, expect, it } from 'vitest';
import { PeerConnection } from '../src/p2p/connection-manager.js';
import { ConnectionState } from '../src/types/connection.js';

/** A data channel whose send reports queued (false) while `buffered` bytes wait. */
function fakeChannel(buffered: () => number) {
  const sent: Uint8Array[] = [];
  const channel = {
    onOpen: () => {}, onClosed: () => {}, onError: () => {}, onMessage: () => {},
    isOpen: () => true,
    sendMessageBinary: (data: Uint8Array) => { sent.push(data); return false; },
    bufferedAmount: buffered,
    close: () => {},
  };
  return { channel, sent };
}

function openConnection(channel: unknown): PeerConnection {
  const conn = new PeerConnection({ remotePeerId: 'aa'.repeat(20) as never, isInitiator: true });
  conn.attachDataChannel(channel as never);
  conn.setState(ConnectionState.Open);
  return conn;
}

describe('data channel send', () => {
  it('keeps the connection open when a send is queued behind earlier data', () => {
    const { channel, sent } = fakeChannel(() => 3 * 1024 * 1024);
    const conn = openConnection(channel);
    for (let i = 0; i < 200; i += 1) conn.send(new Uint8Array(8 * 1024));
    expect(sent).toHaveLength(200);
    expect(conn.state).toBe(ConnectionState.Open);
  });

  it('fails the connection when the channel stops draining', () => {
    const { channel } = fakeChannel(() => 65 * 1024 * 1024);
    const conn = openConnection(channel);
    conn.on('error', () => {});
    expect(() => conn.send(new Uint8Array(8))).toThrow(/not draining/);
    expect(conn.state).toBe(ConnectionState.Failed);
  });
});
