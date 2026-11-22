/**
 * Regression test for the seller-side mux-collision bug:
 *
 * When a buyer reconnects while their previous connection is still in a
 * CLOSING state, the old connection's stateChange listener fires AFTER the
 * new mux is registered and deletes it from `_muxes`. The new connection is
 * open but has no mux to dispatch requests, so every inbound request is
 * silently dropped.
 *
 * Root cause (node.ts _wireConnection):
 *   conn.on("stateChange", (state) => {
 *     if (state === Closed) {
 *       this._muxes.delete(peerId);   // ← deletes by key, not by reference
 *       ...
 *     }
 *   });
 * When conn2 arrives, _muxes.set(peerId, mux2) overwrites mux1.
 * Later, conn1's stateChange fires and blindly deletes mux2.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { ConnectionState } from '../src/types/connection.js';
import type { PeerId } from '../src/types/peer.js';

const BUYER_PEER_ID = 'b'.repeat(40) as PeerId;
const SELLER_PEER_ID = 's'.repeat(40) as PeerId;

/** Minimal fake PeerConnection — just an EventEmitter with remotePeerId and send(). */
function makeFakeConn(remotePeerId: PeerId): EventEmitter & { remotePeerId: PeerId; send: ReturnType<typeof vi.fn> } {
  const conn = new EventEmitter() as EventEmitter & { remotePeerId: PeerId; send: ReturnType<typeof vi.fn> };
  conn.remotePeerId = remotePeerId;
  conn.send = vi.fn();
  return conn;
}

/** Create a minimal seller AntseedNode with real network disabled. */
function makeSellerNode(): AntseedNode {
  const node = new AntseedNode({ role: 'seller' });
  // Inject identity so internal helpers that read it don't throw
  (node as any)._identity = {
    peerId: SELLER_PEER_ID,
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
  };
  // Stub _sessionTracker so disconnect cleanup doesn't touch real metering
  const sessionTracker = {
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    getOrCreateSession: vi.fn(),
  };
  (node as any)._sessionTracker = sessionTracker;
  // Create SellerRequestHandler so _handleIncomingConnection can delegate
  (node as any)._sellerHandler = new SellerRequestHandler({
    providers: [],
    sellerPaymentManager: null,
    sessionTracker: sessionTracker as any,
    channelsClient: null,
    announcer: null,
    emit: (event: string, ...args: unknown[]) => node.emit(event, ...args),
  });
  return node;
}

describe('seller reconnect — mux-collision regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains the new mux when the stale connection closes after a reconnect', () => {
    const node = makeSellerNode();

    const conn1 = makeFakeConn(BUYER_PEER_ID);
    const conn2 = makeFakeConn(BUYER_PEER_ID);

    // First connection arrives — mux1 is registered
    (node as any)._handleIncomingConnection(conn1);
    const mux1 = (node as any)._muxes.get(BUYER_PEER_ID);
    expect(mux1).toBeDefined();

    // Buyer reconnects while conn1 is still alive — mux2 replaces mux1
    (node as any)._handleIncomingConnection(conn2);
    const mux2 = (node as any)._muxes.get(BUYER_PEER_ID);
    expect(mux2).toBeDefined();
    expect(mux2).not.toBe(mux1);

    // conn1 closes after the reconnect (delayed TCP teardown / bot scanner eviction)
    conn1.emit('stateChange', ConnectionState.Closed);

    // After the fix: stale conn1's stateChange must NOT evict mux2.
    const muxAfterClose = (node as any)._muxes.get(BUYER_PEER_ID);
    expect(muxAfterClose).toBe(mux2);
  });

  it('closes and forgets the relay muxes when the node stops', async () => {
    const node = makeSellerNode();
    (node as any)._handleIncomingConnection(makeFakeConn(BUYER_PEER_ID));
    const relayMux = (node as any)._relayMuxes.get(BUYER_PEER_ID);
    const close = vi.spyOn(relayMux, 'close');
    (node as any)._sessionTracker.finalizeAllSessions = vi.fn().mockResolvedValue(undefined);
    (node as any)._sessionTracker.clearTimers = vi.fn();
    (node as any)._started = true;

    await node.stop();

    expect(close).toHaveBeenCalledOnce();
    expect((node as any)._relayMuxes.size).toBe(0);
  });

  it('removes the mux when the correct (current) connection closes', () => {
    const node = makeSellerNode();

    const conn1 = makeFakeConn(BUYER_PEER_ID);
    (node as any)._handleIncomingConnection(conn1);
    expect((node as any)._muxes.get(BUYER_PEER_ID)).toBeDefined();

    conn1.emit('stateChange', ConnectionState.Closed);

    // No reconnect — the mux should be gone
    expect((node as any)._muxes.get(BUYER_PEER_ID)).toBeUndefined();
  });

  it('does not finalize the session when a stale connection closes after a reconnect', () => {
    const node = makeSellerNode();
    const finalize = (node as any)._sessionTracker.finalizeSession;

    const conn1 = makeFakeConn(BUYER_PEER_ID);
    const conn2 = makeFakeConn(BUYER_PEER_ID);

    (node as any)._handleIncomingConnection(conn1);
    (node as any)._handleIncomingConnection(conn2);

    // Stale conn1 closes — must NOT finalize the live session
    conn1.emit('stateChange', ConnectionState.Closed);
    expect(finalize).not.toHaveBeenCalled();

    // Live conn2 closes — should finalize
    conn2.emit('stateChange', ConnectionState.Closed);
    expect(finalize).toHaveBeenCalledOnce();
  });
});
