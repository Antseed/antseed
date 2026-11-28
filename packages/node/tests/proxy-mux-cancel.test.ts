import { expect, it, vi } from 'vitest';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
import { decodeFrame } from '@antseed/protocol/framing';
import { MessageType } from '../src/types/protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';

/** A buyer and a seller mux wired to each other; `sent` counts each side's frames by type. */
function pair() {
  const errors: unknown[] = [];
  const sent = { buyer: [] as number[], seller: [] as number[] };
  const buyer = new ProxyMux({ send(data: Uint8Array) {
    const message = decodeFrame(data)!.message;
    sent.buyer.push(message.type);
    void seller.handleFrame(message).catch((error) => errors.push(error));
  } } as unknown as PeerConnection);
  const seller = new ProxyMux({ send(data: Uint8Array) {
    const message = decodeFrame(data)!.message;
    sent.seller.push(message.type);
    void buyer.handleFrame(message).catch((error) => errors.push(error));
  } } as unknown as PeerConnection);
  return { buyer, seller, errors, sent };
}

const request = (requestId: string, bytes = 16) => ({
  requestId, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new Uint8Array(bytes),
});
const streamStart = (requestId: string) => ({ requestId, statusCode: 200, headers: { 'x-antseed-streaming': '1' }, body: new Uint8Array() });

it('tells the seller when the buyer cancels a streaming answer, and aborts only that request', async () => {
  const { buyer, seller, errors } = pair();
  const signals = new Map<string, AbortSignal | undefined>();
  const ended = new Map<string, () => void>();
  seller.onProxyRequest(async (incoming) => {
    const signal = seller.requestSignal(incoming.requestId);
    signals.set(incoming.requestId, signal);
    seller.sendProxyResponse(streamStart(incoming.requestId));
    seller.sendProxyChunk({ requestId: incoming.requestId, data: new TextEncoder().encode('data: {}\n\n'), done: false });
    await new Promise<void>((resolve) => {
      ended.set(incoming.requestId, resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  });
  const chunks = vi.fn();
  buyer.sendProxyRequest(request('kept'), () => {}, () => {});
  buyer.sendProxyRequest(request('cancelled'), () => {}, chunks);
  await vi.waitFor(() => expect(chunks).toHaveBeenCalled());

  buyer.cancelProxyRequest('cancelled');

  await vi.waitFor(() => expect(signals.get('cancelled')?.aborted).toBe(true));
  expect(signals.get('kept')?.aborted).toBe(false);
  ended.get('kept')!();
  expect(errors).toEqual([]);
});

it('sends no cancel for a request that already finished', async () => {
  const { buyer, seller, sent } = pair();
  seller.onProxyRequest(async (incoming) => {
    seller.sendProxyResponse({ requestId: incoming.requestId, statusCode: 200, headers: {}, body: new Uint8Array([1]) });
  });
  const received = vi.fn();
  buyer.sendProxyRequest(request('done'), received, () => {});
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());

  buyer.cancelProxyRequest('done');

  expect(sent.buyer).not.toContain(MessageType.HttpRequestCancel);
});

it('drops a chunked upload the buyer cancels before its body has arrived', async () => {
  const { seller } = pair();
  const handled = vi.fn();
  seller.onProxyRequest(async () => { handled(); });
  // The seller receives the upload header and part of the body, then the cancel.
  const encode = async (type: MessageType, payload: Uint8Array) => seller.handleFrame({ type, messageId: 1, payload });
  const { encodeHttpRequest, encodeHttpRequestChunk, encodeHttpResponseChunk } = await import('@antseed/protocol/request-codec');
  await encode(MessageType.HttpRequest, encodeHttpRequest({ ...request('upload', 0), headers: { 'x-antseed-upload': 'chunked' } }));
  await encode(MessageType.HttpRequestChunk, encodeHttpRequestChunk({ requestId: 'upload', data: new Uint8Array(1024), done: false }));
  expect(seller.pendingUploadBytes()).toBe(1024);

  await encode(MessageType.HttpRequestCancel, encodeHttpResponseChunk({ requestId: 'upload', data: new Uint8Array(0), done: false }));
  await encode(MessageType.HttpRequestEnd, encodeHttpRequestChunk({ requestId: 'upload', data: new Uint8Array(1), done: true }));

  expect(seller.pendingUploadBytes()).toBe(0);
  expect(handled).not.toHaveBeenCalled();
});
