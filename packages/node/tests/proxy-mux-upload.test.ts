import { describe, expect, it, vi } from 'vitest';
import { ByteBudget, DEFAULT_MAX_UPLOAD_BODY_BYTES, ProxyMux } from '../src/proxy/proxy-mux.js';
import {
  decodeHttpRequest,
  decodeHttpRequestChunk,
  decodeHttpResponse,
  encodeHttpRequestChunk,
} from '../src/proxy/request-codec.js';
import { MessageType } from '../src/types/protocol.js';
import {
  ANTSEED_UPLOAD_CHUNK_SIZE,
  ANTSEED_UPLOAD_THRESHOLD_BYTES,
  ANTSEED_UPLOAD_CHUNK_HEADER,
} from '../src/types/http.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { SerializedHttpRequest } from '../src/types/http.js';

function createMux(
  onSend?: (frame: Uint8Array) => void,
  uploadLimits?: Parameters<typeof ProxyMux>[1],
): ProxyMux {
  const conn = {
    send: onSend ?? (() => {}),
  } as unknown as PeerConnection;
  return new ProxyMux(conn, uploadLimits);
}

function decodeFrameHeader(buf: Uint8Array): { type: number; payloadLength: number; payload: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    type: view.getUint8(0),
    payloadLength: view.getUint32(5),
    payload: buf.slice(9),
  };
}

describe('ProxyMux chunked upload — buyer side', () => {
  it('sends a single HttpRequest frame for small bodies (≤ threshold)', () => {
    const sent: Uint8Array[] = [];
    const mux = createMux((f) => sent.push(f));

    mux.sendProxyRequest(
      { requestId: 'r1', method: 'POST', path: '/v1/messages', headers: {}, body: new Uint8Array(100) },
      () => {},
      () => {},
    );

    expect(sent).toHaveLength(1);
    expect(decodeFrameHeader(sent[0]!).type).toBe(MessageType.HttpRequest);
  });

  it('switches to chunked mode for bodies larger than ANTSEED_UPLOAD_THRESHOLD_BYTES', () => {
    const sent: Uint8Array[] = [];
    const mux = createMux((f) => sent.push(f));

    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 1);
    body.fill(0xAB);

    mux.sendProxyRequest(
      { requestId: 'r2', method: 'POST', path: '/upload', headers: {}, body },
      () => {},
      () => {},
    );

    // Expect: HttpRequest header + at least one HttpRequestChunk + HttpRequestEnd
    expect(sent.length).toBeGreaterThanOrEqual(3);

    const types = sent.map((f) => decodeFrameHeader(f).type);
    expect(types[0]).toBe(MessageType.HttpRequest);
    expect(types.slice(1, -1).every((t) => t === MessageType.HttpRequestChunk)).toBe(true);
    expect(types[types.length - 1]).toBe(MessageType.HttpRequestEnd);
  });

  it('header frame carries the upload marker and an empty body', () => {
    const sent: Uint8Array[] = [];
    const mux = createMux((f) => sent.push(f));

    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 1);
    mux.sendProxyRequest(
      { requestId: 'r3', method: 'POST', path: '/img', headers: { 'content-type': 'image/png' }, body },
      () => {},
      () => {},
    );

    const headerFrame = sent[0]!;
    const req = decodeHttpRequest(decodeFrameHeader(headerFrame).payload);

    expect(req.headers[ANTSEED_UPLOAD_CHUNK_HEADER]).toBe('chunked');
    expect(req.body.length).toBe(0);
    expect(req.headers['content-type']).toBe('image/png');
  });

  it('chunk frames together reconstitute the original body', () => {
    const sent: Uint8Array[] = [];
    const mux = createMux((f) => sent.push(f));

    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 512);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xFF;

    mux.sendProxyRequest(
      { requestId: 'r4', method: 'POST', path: '/upload', headers: {}, body },
      () => {},
      () => {},
    );

    // Collect data from chunk frames (skip header frame)
    const chunkFrames = sent.slice(1);
    const pieces: Uint8Array[] = [];
    for (const frame of chunkFrames) {
      const { payload } = decodeFrameHeader(frame);
      const chunk = decodeHttpRequestChunk(payload);
      if (chunk.data.length > 0) pieces.push(chunk.data);
    }
    const total = pieces.reduce((n, p) => n + p.length, 0);
    expect(total).toBe(body.length);

    // Verify last decoded chunk has done=true
    const lastChunk = decodeHttpRequestChunk(decodeFrameHeader(sent[sent.length - 1]!).payload);
    expect(lastChunk.done).toBe(true);
  });
});

describe('ProxyMux chunked upload — seller side', () => {
  it('reassembles chunked upload and delivers full body to requestHandler', async () => {
    const received: SerializedHttpRequest[] = [];
    const mux = createMux();
    mux.onProxyRequest((req) => { received.push(req); });

    const requestId = 'upload-seller-1';
    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 256);
    body.fill(0x7F);

    // Simulate buyer: send header frame then chunks
    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId, method: 'POST', path: '/media', headers: { 'content-type': 'image/jpeg' }, body },
      () => {},
      () => {},
    );

    // Feed all buyer frames into seller mux
    for (const frame of buyerSent) {
      const { type, payload } = decodeFrameHeader(frame);
      await mux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.requestId).toBe(requestId);
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/media');
    // Upload marker must be stripped
    expect(req.headers[ANTSEED_UPLOAD_CHUNK_HEADER]).toBeUndefined();
    expect(req.headers['content-type']).toBe('image/jpeg');
    expect(req.body.length).toBe(body.length);
    expect(req.body.every((b) => b === 0x7F)).toBe(true);
  });

  it('handles a multi-chunk upload correctly', async () => {
    const received: SerializedHttpRequest[] = [];
    const mux = createMux();
    mux.onProxyRequest((req) => { received.push(req); });

    const requestId = 'three-chunk';
    const chunkData = [
      new Uint8Array(ANTSEED_UPLOAD_CHUNK_SIZE).fill(0x01),
      new Uint8Array(ANTSEED_UPLOAD_CHUNK_SIZE).fill(0x02),
      new Uint8Array(ANTSEED_UPLOAD_CHUNK_SIZE).fill(0x03),
    ];
    const fullBody = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + ANTSEED_UPLOAD_CHUNK_SIZE);
    const fillCount = 1 + Math.floor((ANTSEED_UPLOAD_THRESHOLD_BYTES - 1) / ANTSEED_UPLOAD_CHUNK_SIZE);
    for (let i = 0; i < fillCount; i++) {
      fullBody.set(chunkData[i % 3]!, i * ANTSEED_UPLOAD_CHUNK_SIZE);
    }

    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId, method: 'POST', path: '/big', headers: {}, body: fullBody },
      () => {},
      () => {},
    );

    for (const frame of buyerSent) {
      const { type, payload } = decodeFrameHeader(frame);
      await mux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(received).toHaveLength(1);
    expect(received[0]!.body.length).toBe(fullBody.length);
  });

  it('ignores HttpRequestChunk frames with no matching header', async () => {
    const received: SerializedHttpRequest[] = [];
    const mux = createMux();
    mux.onProxyRequest((req) => { received.push(req); });

    // Inject an orphan chunk (no prior HttpRequest header)
    await mux.handleFrame({
      type: MessageType.HttpRequestChunk,
      messageId: 0,
      payload: encodeHttpRequestChunk({ requestId: 'orphan', data: new Uint8Array(4), done: false }),
    });

    // Inject an orphan End
    await mux.handleFrame({
      type: MessageType.HttpRequestEnd,
      messageId: 1,
      payload: encodeHttpRequestChunk({ requestId: 'orphan', data: new Uint8Array(0), done: true }),
    });

    expect(received).toHaveLength(0);
  });

  it('abortPendingUploads clears in-progress upload buffers', async () => {
    const received: SerializedHttpRequest[] = [];
    const mux = createMux();
    mux.onProxyRequest((req) => { received.push(req); });

    const requestId = 'aborted-upload';
    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 1);

    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId, method: 'POST', path: '/media', headers: {}, body },
      () => {},
      () => {},
    );

    // Feed only the header frame and first chunk — simulate partial upload
    for (const frame of buyerSent.slice(0, 2)) {
      const { type, payload } = decodeFrameHeader(frame);
      await mux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    // Connection drops — abort
    mux.abortPendingUploads();

    // Feed the remaining frames — should be silently ignored after abort
    for (const frame of buyerSent.slice(2)) {
      const { type, payload } = decodeFrameHeader(frame);
      await mux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(received).toHaveLength(0);
  });
});

describe('ProxyMux upload limits — storage protection', () => {
  it('defaults the per-request upload limit to 64 MiB', () => {
    expect(DEFAULT_MAX_UPLOAD_BODY_BYTES).toBe(64 * 1024 * 1024);
  });

  it('rejects upload that exceeds per-request limit with 413', async () => {
    const statusCodes: number[] = [];
    const maxBytesHeaders: string[] = [];
    // Limit: anything larger than one upload chunk (ANTSEED_UPLOAD_CHUNK_SIZE - 1 bytes)
    const sellerMux = createMux(
      (f) => {
        const { type, payload } = decodeFrameHeader(f);
        if (type === MessageType.HttpResponse) {
          const response = decodeHttpResponse(payload);
          statusCodes.push(response.statusCode);
          const maxBytes = response.headers['x-antseed-max-upload-body-bytes'];
          if (maxBytes) maxBytesHeaders.push(maxBytes);
        }
      },
      { maxUploadBodyBytes: ANTSEED_UPLOAD_CHUNK_SIZE - 1 },
    );
    sellerMux.onProxyRequest(() => {});

    // Body is slightly above chunked threshold → buyer sends header + chunks.
    // The first chunk is ANTSEED_UPLOAD_CHUNK_SIZE bytes which exceeds the limit.
    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + 1).fill(0xAA);
    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId: 'limit-test', method: 'POST', path: '/img', headers: {}, body },
      () => {},
      () => {},
    );

    for (const frame of buyerSent) {
      const { type, payload } = decodeFrameHeader(frame);
      await sellerMux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(statusCodes).toHaveLength(1);
    expect(statusCodes[0]).toBe(413);
    expect(maxBytesHeaders[0]).toBe(String(ANTSEED_UPLOAD_CHUNK_SIZE - 1));
    expect(sellerMux.pendingUploadCount()).toBe(0);
    expect(sellerMux.pendingUploadBytes()).toBe(0);
  });

  it('rejects upload when global budget is exhausted', async () => {
    const statusCodes: number[] = [];
    // Global limit: 1.5 chunks — first upload (1 chunk) fits, second (1 chunk) tips it over.
    const sellerMux = createMux(
      (f) => {
        const { type, payload } = decodeFrameHeader(f);
        if (type === MessageType.HttpResponse) {
          const view = new DataView(payload.buffer, payload.byteOffset);
          const idLen = view.getUint16(0);
          statusCodes.push(view.getUint16(2 + idLen));
        }
      },
      { maxTotalPendingUploadBytes: Math.floor(ANTSEED_UPLOAD_CHUNK_SIZE * 1.5) },
    );
    sellerMux.onProxyRequest(() => {});

    // Collect all frames from both buyers first, then interleave header→header→chunk→chunk
    // so both uploads are pending simultaneously when the second chunk arrives.
    const allFrames: Array<{ requestId: string; frames: Uint8Array[] }> = [];
    for (const id of ['up-1', 'up-2']) {
      const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + ANTSEED_UPLOAD_CHUNK_SIZE).fill(0xBB);
      const frames: Uint8Array[] = [];
      const buyerMux = createMux((f) => frames.push(f));
      buyerMux.sendProxyRequest(
        { requestId: id, method: 'POST', path: '/img', headers: {}, body },
        () => {},
        () => {},
      );
      allFrames.push({ requestId: id, frames });
    }

    // Send both header frames first (opens both uploads simultaneously)
    for (const { frames } of allFrames) {
      const { type, payload } = decodeFrameHeader(frames[0]!);
      await sellerMux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }
    // Send only the HttpRequestChunk frame (frames[1]) for each upload — NOT the End frame.
    // This keeps both uploads in-progress at the same time so the global budget accumulates.
    // up-1 chunk (8KB): total = 8KB < 12KB ✓
    // up-2 chunk (8KB): total = 16KB > 12KB → 413
    for (const { frames } of allFrames) {
      const { type, payload } = decodeFrameHeader(frames[1]!); // HttpRequestChunk
      await sellerMux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(statusCodes.some((s) => s === 413)).toBe(true);
    expect(sellerMux.pendingUploadBytes()).toBeLessThanOrEqual(Math.floor(ANTSEED_UPLOAD_CHUNK_SIZE * 1.5));
  });

  it('aborts stalled upload after timeout and sends 408', async () => {
    vi.useFakeTimers();
    const errorsSent: number[] = [];
    const sellerMux = createMux(
      (f) => {
        const { type, payload } = decodeFrameHeader(f);
        if (type === MessageType.HttpResponse) {
          const view = new DataView(payload.buffer, payload.byteOffset);
          const idLen = view.getUint16(0);
          errorsSent.push(view.getUint16(2 + idLen));
        }
      },
      { uploadTimeoutMs: 5_000 },
    );
    sellerMux.onProxyRequest(() => {});

    // Send only the header frame — never complete the upload
    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + ANTSEED_UPLOAD_CHUNK_SIZE);
    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId: 'stall-test', method: 'POST', path: '/img', headers: {}, body },
      () => {},
      () => {},
    );

    // Deliver only the header frame
    const { type, payload } = decodeFrameHeader(buyerSent[0]!);
    await sellerMux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    expect(sellerMux.pendingUploadCount()).toBe(1);

    // Advance past the timeout
    vi.advanceTimersByTime(6_000);

    expect(errorsSent).toHaveLength(1);
    expect(errorsSent[0]).toBe(408);
    expect(sellerMux.pendingUploadCount()).toBe(0);
    expect(sellerMux.pendingUploadBytes()).toBe(0);

    vi.useRealTimers();
  });

  it('abortPendingUploads zeros chunk buffers', async () => {
    const sellerMux = createMux();
    sellerMux.onProxyRequest(() => {});

    const body = new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + ANTSEED_UPLOAD_CHUNK_SIZE).fill(0xFF);
    const buyerSent: Uint8Array[] = [];
    const buyerMux = createMux((f) => buyerSent.push(f));
    buyerMux.sendProxyRequest(
      { requestId: 'zero-test', method: 'POST', path: '/img', headers: {}, body },
      () => {},
      () => {},
    );

    // Feed header + first chunk only (leave upload incomplete)
    for (const frame of buyerSent.slice(0, 2)) {
      const { type, payload } = decodeFrameHeader(frame);
      await sellerMux.handleFrame({ type: type as MessageType, messageId: 0, payload });
    }

    expect(sellerMux.pendingUploadCount()).toBe(1);
    expect(sellerMux.pendingUploadBytes()).toBeGreaterThan(0);

    sellerMux.abortPendingUploads();

    expect(sellerMux.pendingUploadCount()).toBe(0);
    expect(sellerMux.pendingUploadBytes()).toBe(0);
  });
});

describe('ProxyMux shared upload budget', () => {
  /** The frames a buyer sends for one chunked upload: header, chunks, end. */
  function uploadFrames(requestId: string): Array<{ type: MessageType; messageId: number; payload: Uint8Array }> {
    const frames: Uint8Array[] = [];
    createMux((f) => frames.push(f)).sendProxyRequest(
      { requestId, method: 'POST', path: '/img', headers: {}, body: new Uint8Array(ANTSEED_UPLOAD_THRESHOLD_BYTES + ANTSEED_UPLOAD_CHUNK_SIZE).fill(0xCC) },
      () => {},
      () => {},
    );
    return frames.map((frame) => {
      const { type, payload } = decodeFrameHeader(frame);
      return { type: type as MessageType, messageId: 0, payload };
    });
  }

  function sellerMux(budget: ByteBudget) {
    const responses: Array<{ statusCode: number; headers: Record<string, string> }> = [];
    const mux = createMux((f) => {
      const { type, payload } = decodeFrameHeader(f);
      if (type === MessageType.HttpResponse) responses.push(decodeHttpResponse(payload));
    }, { sharedUploadBudget: budget });
    mux.onProxyRequest(() => {});
    return { mux, responses };
  }

  it('turns away an upload on one connection when uploads on others have filled the budget', async () => {
    // Room for one chunk and a half: the second connection's first chunk no longer fits.
    const budget = new ByteBudget(Math.floor(ANTSEED_UPLOAD_CHUNK_SIZE * 1.5));
    const first = sellerMux(budget);
    const second = sellerMux(budget);

    for (const frame of uploadFrames('up-1').slice(0, 2)) await first.mux.handleFrame(frame);
    for (const frame of uploadFrames('up-2').slice(0, 2)) await second.mux.handleFrame(frame);

    expect(first.responses).toEqual([]);
    expect(second.responses).toHaveLength(1);
    expect(second.responses[0]!.statusCode).toBe(503);
    expect(second.responses[0]!.headers['retry-after']).toBe('1');
    expect(second.mux.pendingUploadCount()).toBe(0);
    expect(budget.usedBytes).toBe(ANTSEED_UPLOAD_CHUNK_SIZE);

    // The first connection drops: its bytes are free for others again.
    first.mux.abortPendingUploads();
    expect(budget.usedBytes).toBe(0);
  });

  it('hands the bytes back when an upload completes', async () => {
    const budget = new ByteBudget(1024 * 1024);
    const { mux, responses } = sellerMux(budget);
    const received: SerializedHttpRequest[] = [];
    mux.onProxyRequest((request) => { received.push(request); });

    const frames = uploadFrames('up-1');
    for (const frame of frames.slice(0, -1)) await mux.handleFrame(frame);
    // The last chunk arrives with the end frame.
    expect(budget.usedBytes).toBe(ANTSEED_UPLOAD_THRESHOLD_BYTES);

    await mux.handleFrame(frames.at(-1)!);
    expect(received).toHaveLength(1);
    expect(responses).toEqual([]);
    expect(budget.usedBytes).toBe(0);
  });
});
