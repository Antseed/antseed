import { describe, expect, it, vi } from 'vitest';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { AntseedNode } from '../src/node.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import { encodeHttpRequest, decodeHttpResponse } from '../src/proxy/request-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import { MessageType } from '../src/types/protocol.js';
import { PeerConnection } from '../src/p2p/connection-manager.js';

function harness() {
  let finish!: () => void;
  let callbacks!: ProviderStreamCallbacks;
  const body = new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  const provider: Provider = {
    name: 'openai', services: ['model'], maxConcurrency: 10,
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    getCapacity: () => ({ current: 0, max: 10 }),
    handleRequest: vi.fn(),
    handleRequestStream: vi.fn(async (request, streamCallbacks) => {
      callbacks = streamCallbacks;
      callbacks.onResponseStart({ requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: new Uint8Array() });
      await new Promise<void>((resolve) => { finish = resolve; });
      callbacks.onResponseChunk({ requestId: request.requestId, data: body, done: true });
      return { requestId: request.requestId, statusCode: 200, headers: {}, body };
    }),
  };
  const frames: Uint8Array[] = [];
  const recordSpend = vi.fn();
  const sendNeedAuth = vi.fn();
  const payments = {
    hasSession: () => true, getChannelByPeer: () => ({ sessionId: 'channel', authMax: '1000000' }),
    getAcceptedCumulative: () => 0n, getCumulativeSpend: () => 0n, getEffectiveReserveMax: () => 1_000_000n,
    waitForPendingAuths: async () => {}, isChannelBlocked: () => false, hasClosingChannel: () => false,
    beginBillableRequest: vi.fn(), endBillableRequest: vi.fn(), recordSpend,
  };
  const handler = new SellerRequestHandler({
    identity: { peerId: 'a'.repeat(40) } as any, providers: [provider],
    sellerPaymentManager: payments as any, channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const { mux } = handler.handleConnection({ send: (frame: Uint8Array) => frames.push(frame), hasRemoteCapability: () => false } as any,
    'b'.repeat(40), { sendNeedAuth } as any, {} as any);
  const send = (requestId: string) => mux.handleFrame({
    type: MessageType.HttpRequest, messageId: 1,
    payload: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'model', stream: true })) }),
  });
  return { provider, handler, send, frames, recordSpend, sendNeedAuth, finish: () => finish(), started: () => Boolean(finish) };
}

describe('seller graceful shutdown', () => {
  it('finishes an active stream while rejecting new requests during drain', async () => {
    const state = harness();
    state.send('running');
    await vi.waitFor(() => expect(state.started()).toBe(true));
    let drained = false;
    const draining = state.handler.drain(1000).then((completed) => { drained = completed; });
    state.send('rejected');
    await vi.waitFor(() => expect(state.frames.length).toBe(2));
    const rejected = decodeHttpResponse(decodeFrame(state.frames[1]!)!.message.payload);
    expect(rejected.statusCode).toBe(503);
    expect(JSON.parse(new TextDecoder().decode(rejected.body)).error.code).toBe('seller_shutting_down');
    expect(drained).toBe(false);
    state.finish();
    await draining;
    expect(drained).toBe(true);
    expect(state.recordSpend).toHaveBeenCalledWith('channel', 8n);
    expect(state.sendNeedAuth).toHaveBeenCalledOnce();
    expect(state.provider.handleRequestStream).toHaveBeenCalledOnce();
    expect(state.frames).toHaveLength(3);
  });

  it('times out a stuck provider without allowing late frames or billing', async () => {
    const state = harness();
    state.send('stuck');
    await vi.waitFor(() => expect(state.started()).toBe(true));
    expect(await state.handler.drain(5)).toBe(false);
    const count = state.frames.length;
    state.finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.frames).toHaveLength(count);
    expect(state.recordSpend).not.toHaveBeenCalled();
  });

  it('rejects invalid shutdown deadlines', () => {
    for (const timeout of [-1, NaN, Infinity, 1.5]) {
      expect(() => new AntseedNode({ role: 'seller', shutdownDrainTimeoutMs: timeout })).toThrow();
    }
  });

  it('orders node shutdown after requests, payment authorizations, and transport drain', async () => {
    const node = new AntseedNode({ role: 'seller', shutdownDrainTimeoutMs: 1000 });
    const events: string[] = [];
    let finishRequest!: () => void;
    Object.assign(node, {
      _started: true,
      _sellerHandler: {
        drain: async () => {
          events.push('requests');
          await new Promise<void>((resolve) => { finishRequest = resolve; });
          return true;
        },
        clearMetadataRefreshTimer: () => {},
      },
      _sellerPaymentManager: {
        beginDrain: () => events.push('reject-reserves'),
        drainPendingPayments: async () => { events.push('payments'); },
        markConnectionsClosed: () => events.push('connections-closed'),
        waitForRunningTopUps: async () => { events.push('top-ups'); return true; },
      },
      _announcer: { stopPeriodicAnnounce: () => events.push('stop-advertising'), refreshMetadata: async () => {} },
      _sessionTracker: { finalizeAllSessions: async () => { events.push('finalize'); }, clearTimers: () => {} },
      _connectionManager: {
        connections: new Map([['buyer', { drainOutgoing: async () => { events.push('transport'); return true; } }]]),
        closeAll: () => events.push('close'),
      },
    });
    const stopping = node.stop();
    expect(node.stop()).toBe(stopping);
    await vi.waitFor(() => expect(events).toContain('requests'));
    expect(events).toContain('stop-advertising');
    expect(events).toContain('reject-reserves');
    expect(events).not.toContain('close');
    finishRequest();
    await stopping;
    expect(events.indexOf('payments')).toBeLessThan(events.indexOf('transport'));
    expect(events.indexOf('transport')).toBeLessThan(events.indexOf('finalize'));
    expect(events.indexOf('finalize')).toBeLessThan(events.indexOf('close'));
    // A top-up being mined still gets its wait once connections are closed.
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('connections-closed'));
    expect(events.indexOf('connections-closed')).toBeLessThan(events.indexOf('top-ups'));
  });

  it('waits for outgoing bytes rather than just provider completion', async () => {
    const connection = new PeerConnection({ remotePeerId: 'b'.repeat(40) as any, isInitiator: false });
    let buffered = 100;
    connection.attachDataChannel({ isOpen: () => true, bufferedAmount: () => buffered, onOpen: () => {}, onClosed: () => {}, onError: () => {}, onMessage: () => {} } as any);
    expect(await connection.drainOutgoing(0)).toBe(false);
    const draining = connection.drainOutgoing(1000);
    buffered = 0;
    expect(await draining).toBe(true);
  });

});
