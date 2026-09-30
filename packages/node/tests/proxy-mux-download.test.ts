import { expect, it, vi } from 'vitest';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
import { decodeFrame } from '@antseed/protocol/framing';
import type { PeerConnection } from '../src/p2p/connection-manager.js';

function pair() {
  const errors: unknown[] = [];
  const buyer = new ProxyMux({ send(data: Uint8Array) { void seller.handleFrame(decodeFrame(data)!.message).catch(error => errors.push(error)); } } as unknown as PeerConnection);
  const seller = new ProxyMux({ send(data: Uint8Array) { void buyer.handleFrame(decodeFrame(data)!.message).catch(error => errors.push(error)); } } as unknown as PeerConnection);
  return { buyer, seller, errors };
}

const request = { requestId: 'download', method: 'POST', path: '/video', headers: { 'x-antseed-video-download': 'video-stream-v1' }, body: new TextEncoder().encode('{"queue_id":"queue-1"}') };
const start = { requestId: request.requestId, statusCode: 200, headers: { 'x-antseed-streaming': '1' }, body: new Uint8Array() };

it('waits for the consumer before acknowledging each bounded chunk', async () => {
  const { buyer, seller, errors } = pair();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const consumed = vi.fn(async () => { await gate; });
  let completed = false;
  seller.onProxyRequest(async () => {
    seller.sendProxyResponse(start);
    await seller.sendDownloadChunk({ requestId: request.requestId, data: new Uint8Array(65536), done: false });
    completed = true;
    seller.sendProxyChunk({ requestId: request.requestId, data: new Uint8Array(), done: true });
  });
  buyer.sendProxyRequest(request, () => {}, consumed);
  await vi.waitFor(() => expect(consumed).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  release();
  await vi.waitFor(() => expect(completed).toBe(true));
  await vi.waitFor(() => expect(buyer.activeRequestCount()).toBe(0));
  expect(errors).toEqual([]);
});

it('cancels only the requested stream and releases a blocked sender', async () => {
  const { buyer, seller, errors } = pair();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let cancelled = false;
  seller.onProxyRequest(async incoming => {
    if (incoming.requestId === 'other') {
      seller.sendProxyResponse({ ...start, requestId: 'other', headers: {} });
      return;
    }
    seller.sendProxyResponse(start);
    try { await seller.sendDownloadChunk({ requestId: request.requestId, data: new Uint8Array(65536), done: false }); }
    catch { cancelled = seller.downloadSignal(request.requestId)?.aborted ?? true; }
  });
  buyer.sendProxyRequest(request, () => {}, async () => { await gate; });
  buyer.cancelProxyRequest(request.requestId);
  await vi.waitFor(() => expect(cancelled).toBe(true));
  const received = vi.fn();
  buyer.sendProxyRequest({ ...request, requestId: 'other', headers: {} }, received, () => {});
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  release();
  expect(errors).toEqual([]);
});

it('aborts seller work on connection cleanup', async () => {
  const { buyer, seller, errors } = pair();
  let cancelled = false;
  seller.onProxyRequest(async incoming => {
    const signal = seller.downloadSignal(incoming.requestId)!;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
  });
  buyer.sendProxyRequest(request, () => {}, () => {});
  seller.abortPendingUploads();
  await vi.waitFor(() => expect(cancelled).toBe(true));
  buyer.cancelProxyRequest(request.requestId);
  expect(errors).toEqual([]);
});

it('bounds an abandoned acknowledgement wait', async () => {
  vi.useFakeTimers();
  const { buyer, seller, errors } = pair();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failure: unknown;
  try {
    seller.onProxyRequest(async () => {
      seller.sendProxyResponse(start);
      try { await seller.sendDownloadChunk({ requestId: request.requestId, data: new Uint8Array(1), done: false }); }
      catch (error) { failure = error; }
    });
    buyer.sendProxyRequest(request, () => {}, async () => { await gate; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(failure).toEqual(new Error('Download consumer timed out'));
    expect(seller.downloadSignal(request.requestId)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    buyer.cancelProxyRequest(request.requestId);
    seller.abortPendingUploads();
    release();
    vi.useRealTimers();
  }
});

it('accepts small JSON POST downloads and rejects large or other-method download bodies', async () => {
  const { buyer, seller, errors } = pair();
  const handled: string[] = [];
  seller.onProxyRequest(async incoming => { handled.push(incoming.requestId); seller.sendProxyResponse({ ...start, requestId: incoming.requestId, headers: {} }); });
  const body = new TextEncoder().encode('{"queue_id":"q"}');
  buyer.sendProxyRequest({ ...request, requestId: 'post', method: 'POST', body }, () => {}, () => {});
  buyer.sendProxyRequest({ ...request, requestId: 'large', method: 'POST', body: new Uint8Array(4097) }, () => {}, () => {});
  buyer.sendProxyRequest({ ...request, requestId: 'put', method: 'PUT', body }, () => {}, () => {});
  await vi.waitFor(() => expect(errors.length).toBe(2));
  expect(handled).toEqual(['post']);
});
