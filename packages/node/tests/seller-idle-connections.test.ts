import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { InboundIdleTracker } from '../src/p2p/inbound-idle-tracker.js';
import { encodeFrame } from '../src/p2p/message-protocol.js';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import type { PeerId } from '../src/types/peer.js';
import { MessageType } from '../src/types/protocol.js';

const BUYER_PEER_ID = 'b'.repeat(40) as PeerId;
const IDLE_MS = 30 * 60_000;

type FakeConn = EventEmitter & { remotePeerId: PeerId; isInitiator: boolean; state: ConnectionState; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function makeFakeConn(): FakeConn {
  const conn = new EventEmitter() as FakeConn;
  conn.remotePeerId = BUYER_PEER_ID;
  conn.isInitiator = false;
  conn.state = ConnectionState.Open;
  conn.send = vi.fn();
  conn.close = vi.fn();
  return conn;
}

/** A seller node with no network, its idle tracker on a fake clock. */
function makeSellerNode(options: { paidChannel?: boolean } = {}) {
  let now = 0;
  const node = new AntseedNode({ role: 'seller' });
  const sessionTracker = { finalizeSession: vi.fn().mockResolvedValue(undefined), getOrCreateSession: vi.fn() };
  (node as any)._sessionTracker = sessionTracker;
  (node as any)._sellerHandler = new SellerRequestHandler({
    providers: [],
    sellerPaymentManager: null,
    sessionTracker: sessionTracker as any,
    channelsClient: null,
    announcer: null,
    emit: (event: string, ...args: unknown[]) => node.emit(event, ...args),
  });
  (node as any)._channelStore = { getActiveChannelByPeer: () => (options.paidChannel ? { sessionId: 'channel' } : null) };
  (node as any)._inboundIdle = new InboundIdleTracker({
    idleTimeoutMs: IDLE_MS,
    holdsSession: (peerId: PeerId) => Boolean((node as any)._channelStore.getActiveChannelByPeer(peerId)),
    now: () => now,
  });
  return { node, tracker: (node as any)._inboundIdle as InboundIdleTracker, advance: (ms: number) => { now += ms; } };
}

const ping = () => encodeFrame({ type: MessageType.Ping, messageId: 0, payload: new Uint8Array(8) });
const modelsRequest = () => encodeFrame({
  type: MessageType.HttpRequest,
  messageId: 1,
  payload: encodeHttpRequest({ requestId: 'req-1', method: 'GET', path: '/v1/models', headers: {}, body: new Uint8Array(0) }),
});

describe('seller idle buyer connections', () => {
  it('closes a buyer connection that only sends keepalive pings', () => {
    const { node, tracker, advance } = makeSellerNode();
    const conn = makeFakeConn();
    (node as any)._handleIncomingConnection(conn);

    advance(IDLE_MS - 1);
    conn.emit('message', ping());
    advance(1);

    expect(tracker.sweep()).toEqual([BUYER_PEER_ID]);
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it('counts requests as traffic', async () => {
    const { node, tracker, advance } = makeSellerNode();
    const conn = makeFakeConn();
    (node as any)._handleIncomingConnection(conn);

    advance(IDLE_MS - 1);
    conn.emit('message', modelsRequest());
    await vi.waitFor(() => expect(conn.send).toHaveBeenCalled());
    advance(1);

    expect(tracker.sweep()).toEqual([]);
    expect(conn.close).not.toHaveBeenCalled();
  });

  it('keeps an idle connection whose buyer has a paid channel open', () => {
    const { node, tracker, advance } = makeSellerNode({ paidChannel: true });
    const conn = makeFakeConn();
    (node as any)._handleIncomingConnection(conn);

    advance(IDLE_MS * 4);

    expect(tracker.sweep()).toEqual([]);
    expect(conn.close).not.toHaveBeenCalled();
  });

  it('stops tracking a connection once it closes', () => {
    const { node, tracker } = makeSellerNode();
    const conn = makeFakeConn();
    (node as any)._handleIncomingConnection(conn);
    expect(tracker.size).toBe(1);

    conn.emit('stateChange', ConnectionState.Closed);

    expect(tracker.size).toBe(0);
  });
});
