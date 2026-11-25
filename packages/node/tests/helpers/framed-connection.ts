/**
 * An in-memory framed connection between a buyer and a seller, wired the way
 * AntseedNode wires a real one. Shared by the tests that run the real buyer
 * and seller stacks against each other.
 */
import { FrameDecoder } from '../../src/p2p/message-protocol.js';
import { PaymentMux } from '../../src/p2p/payment-mux.js';
import { VerificationMux } from '../../src/verification/verification-mux.js';
import { ConnectionState } from '../../src/types/connection.js';
import type { PeerConnection } from '../../src/p2p/connection-manager.js';

type Listener = (...args: any[]) => void;

/**
 * Two ends of an in-memory framed connection. Delivery is async like a real socket. With `coalesce`, all that
 * one end sends before the other end reads arrives as a single chunk, as on a byte-stream transport.
 */
export function connectionPair(coalesce = false): { buyerSide: PeerConnection; sellerSide: PeerConnection } {
  const make = () => {
    const listeners = new Map<string, Set<Listener>>();
    const end: any = {
      state: ConnectionState.Open,
      remoteAddress: '203.0.113.9',
      hasRemoteCapability: () => false,
      on(event: string, listener: Listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
      },
      off(event: string, listener: Listener) { listeners.get(event)?.delete(listener); },
      emitMessage(data: Uint8Array) { for (const listener of listeners.get('message') ?? []) listener(data); },
      send: (_data: Uint8Array) => {},
      /** The connection reports a new state to its listeners, as a real one does when it closes. */
      emitState(state: ConnectionState) { for (const listener of listeners.get('stateChange') ?? []) listener(state); },
    };
    return end;
  };
  const buyerSide = make();
  const sellerSide = make();
  const sendTo = (target: any) => {
    let unread: Uint8Array[] = [];
    return (data: Uint8Array) => {
      const copy = data.slice();
      if (!coalesce) return void setImmediate(() => target.emitMessage(copy));
      if (unread.push(copy) === 1) setImmediate(() => { const chunk = Buffer.concat(unread); unread = []; target.emitMessage(chunk); });
    };
  };
  buyerSide.send = sendTo(sellerSide);
  sellerSide.send = sendTo(buyerSide);
  return { buyerSide, sellerSide };
}

/** Route incoming frames the same way AntseedNode._wireConnection does. */
export function wireFrames(conn: PeerConnection, muxes: { proxy: { handleFrame(frame: any): Promise<unknown> }; payment: PaymentMux; verification: VerificationMux }): void {
  const decoder = new FrameDecoder();
  conn.on('message', (data: Uint8Array) => {
    for (const frame of decoder.feed(data)) {
      const target = PaymentMux.isPaymentMessage(frame.type)
        ? muxes.payment
        : VerificationMux.isVerificationMessage(frame.type) ? muxes.verification : muxes.proxy;
      void target.handleFrame(frame).catch(() => {});
    }
  });
}
