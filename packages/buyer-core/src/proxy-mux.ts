import { MessageType, type FramedMessage } from '@antseed/protocol/messages';
import type { BuyerConnection } from './interfaces.js';
import { encodeFrame } from '@antseed/protocol/framing';
import {
  encodeHttpRequest,
  decodeHttpRequest,
  encodeHttpResponse,
  decodeHttpResponse,
  encodeHttpResponseChunk,
  decodeHttpResponseChunk,
  encodeHttpRequestChunk,
  decodeHttpRequestChunk,
} from "@antseed/protocol/request-codec";
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  ANTSEED_UPLOAD_CHUNK_HEADER,
  ANTSEED_UPLOAD_THRESHOLD_BYTES,
  ANTSEED_UPLOAD_CHUNK_SIZE,
  VIDEO_DOWNLOAD_STREAM_HEADER,
  VIDEO_DOWNLOAD_STREAM_VERSION,
  VIDEO_DOWNLOAD_CHUNK_BYTES,
} from '@antseed/protocol/http';
import { debugLog } from './debug.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '@antseed/protocol/http';

type ResponseHandler = (
  response: SerializedHttpResponse,
  metadata: { streamingStart: boolean }
) => void;
type ChunkHandler = (chunk: SerializedHttpResponseChunk) => void | Promise<void>;
type RequestHandler = (request: SerializedHttpRequest) => void | Promise<void>;

/** Per-request upload size cap, total budget, and stall timeout. */
export interface ProxyMuxUploadLimits {
  /** Max body bytes for a single upload. Default: 64 MiB. Buyer receives 413 on violation. */
  maxUploadBodyBytes?: number;
  /**
   * Buyer-side chunked-upload threshold. Default: ANTSEED_UPLOAD_THRESHOLD_BYTES
   * (512 KiB). Transports with smaller message ceilings (e.g. W3C WebRTC's
   * ~256 KiB SCTP default against libdatachannel peers) lower this.
   */
  uploadThresholdBytes?: number;
  /** Max bytes across ALL concurrent in-progress uploads. Default: 256 MiB. */
  maxTotalPendingUploadBytes?: number;
  /** Max ms between the header frame and HttpRequestEnd. Default: 120_000 ms. */
  uploadTimeoutMs?: number;
}

// Codex-style /v1/responses requests can include large repository context.
// Raising the per-request cap to 64 MiB accommodates those requests while the
// separate 256 MiB aggregate pending-upload budget continues to bound seller
// memory exposure across concurrent uploads.
export const DEFAULT_MAX_UPLOAD_BODY_BYTES = 64  * 1024 * 1024; // 64 MiB
const DEFAULT_MAX_TOTAL_PENDING_BYTES      = 256 * 1024 * 1024; // 256 MiB
const DEFAULT_UPLOAD_TIMEOUT_MS            = 120_000;            // 2 min

interface PendingUpload {
  headerReq: SerializedHttpRequest;
  chunks: Uint8Array[];
  byteCount: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Request/response multiplexer over a peer connection (encrypted TCP
 * preferred; WebRTC DataChannel for TCP-incapable peers).
 * Handles both buyer-side and seller-side proxy communication.
 */
export class ProxyMux {
  private readonly _connection: BuyerConnection;
  private _messageIdCounter = 0;

  // Buyer side: pending requests awaiting responses
  private readonly _responseHandlers = new Map<string, ResponseHandler>();
  private readonly _chunkHandlers = new Map<string, ChunkHandler>();
  private readonly _downloads = new Set<string>();
  private readonly _consumingDownloads = new Set<string>();
  private readonly _downloadControllers = new Map<string, AbortController>();
  private readonly _downloadAcks = new Map<string, { messageId: number; resolve: () => void }>();

  // Seller side: handler for incoming proxy requests
  private _requestHandler: RequestHandler | null = null;

  // Seller side: in-progress chunked uploads with size tracking and timeouts
  private readonly _pendingUploads = new Map<string, PendingUpload>();
  private _totalPendingUploadBytes = 0;

  private readonly _maxUploadBodyBytes: number;
  private readonly _uploadThresholdBytes: number;
  private readonly _maxTotalPendingUploadBytes: number;
  private readonly _uploadTimeoutMs: number;

  constructor(connection: BuyerConnection, uploadLimits?: ProxyMuxUploadLimits) {
    this._connection = connection;
    this._maxUploadBodyBytes       = uploadLimits?.maxUploadBodyBytes       ?? DEFAULT_MAX_UPLOAD_BODY_BYTES;
    this._uploadThresholdBytes     = uploadLimits?.uploadThresholdBytes     ?? ANTSEED_UPLOAD_THRESHOLD_BYTES;
    this._maxTotalPendingUploadBytes = uploadLimits?.maxTotalPendingUploadBytes ?? DEFAULT_MAX_TOTAL_PENDING_BYTES;
    this._uploadTimeoutMs          = uploadLimits?.uploadTimeoutMs          ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  /** Buyer side: send a proxy request and register response/chunk handlers. */
  sendProxyRequest(
    request: SerializedHttpRequest,
    onResponse: ResponseHandler,
    onChunk: ChunkHandler
  ): void {
    const useChunkedUpload = request.body.length > this._uploadThresholdBytes;
    debugLog(
      `[ProxyMux] send request reqId=${request.requestId.slice(0, 8)} bytes=${request.body.length} chunked=${useChunkedUpload ? "true" : "false"}`,
    );
    this._responseHandlers.set(request.requestId, onResponse);
    this._chunkHandlers.set(request.requestId, onChunk);
    if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] === VIDEO_DOWNLOAD_STREAM_VERSION) this._downloads.add(request.requestId);

    if (useChunkedUpload) {
      this._sendChunkedRequest(request);
    } else {
      const payload = encodeHttpRequest(request);
      this._connection.send(encodeFrame({
        type: MessageType.HttpRequest,
        messageId: this._nextMessageId(),
        payload,
      }));
    }
  }

  /** Buyer side: split a large request body into HttpRequest + HttpRequestChunk* + HttpRequestEnd. */
  private _sendChunkedRequest(request: SerializedHttpRequest): void {
    // Header frame: metadata only, empty body, upload marker
    const headerRequest: SerializedHttpRequest = {
      ...request,
      headers: { ...request.headers, [ANTSEED_UPLOAD_CHUNK_HEADER]: 'chunked' },
      body: new Uint8Array(0),
    };
    this._connection.send(encodeFrame({
      type: MessageType.HttpRequest,
      messageId: this._nextMessageId(),
      payload: encodeHttpRequest(headerRequest),
    }));

    // Stream body in ANTSEED_UPLOAD_CHUNK_SIZE slices
    const body = request.body;
    let offset = 0;
    while (offset < body.length) {
      const end = Math.min(offset + ANTSEED_UPLOAD_CHUNK_SIZE, body.length);
      const isLast = end >= body.length;
      const payload = encodeHttpRequestChunk({
        requestId: request.requestId,
        data: body.slice(offset, end),
        done: isLast,
      });
      this._connection.send(encodeFrame({
        type: isLast ? MessageType.HttpRequestEnd : MessageType.HttpRequestChunk,
        messageId: this._nextMessageId(),
        payload,
      }));
      offset = end;
    }
  }

  /** Buyer side: cancel handlers for an in-flight request. */
  cancelProxyRequest(requestId: string): void {
    debugLog(`[ProxyMux] cancel request reqId=${requestId.slice(0, 8)}`);
    this._responseHandlers.delete(requestId);
    this._chunkHandlers.delete(requestId);
    if (this._downloads.delete(requestId)) {
      this._safeSendFrame(encodeFrame({
        type: MessageType.HttpRequestCancel,
        messageId: this._nextMessageId(),
        payload: encodeHttpResponseChunk({ requestId, data: new Uint8Array(0), done: false }),
      }), 'cancel', requestId);
    }
  }

  downloadSignal(requestId: string): AbortSignal | undefined {
    return this._downloadControllers.get(requestId)?.signal;
  }

  finishDownload(requestId: string): void {
    this._downloadControllers.get(requestId)?.abort();
    this._downloadControllers.delete(requestId);
    this._downloadAcks.delete(requestId);
  }

  async sendDownloadChunk(chunk: SerializedHttpResponseChunk): Promise<void> {
    const signal = this.downloadSignal(chunk.requestId);
    if (!signal || signal.aborted) throw new Error('Download cancelled');
    if (chunk.data.length > VIDEO_DOWNLOAD_CHUNK_BYTES || chunk.done) throw new Error('Invalid download chunk');
    if (this._downloadAcks.has(chunk.requestId)) throw new Error('Previous download chunk not acknowledged');
    const messageId = this._nextMessageId();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this._downloadAcks.delete(chunk.requestId);
      };
      const abort = () => { cleanup(); reject(new Error('Download cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Download consumer timed out')); }, 30_000);
      signal.addEventListener('abort', abort, { once: true });
      this._downloadAcks.set(chunk.requestId, { messageId, resolve: () => { cleanup(); resolve(); } });
      try {
        this._connection.send(encodeFrame({ type: MessageType.HttpResponseChunk, messageId, payload: encodeHttpResponseChunk(chunk) }));
      } catch (error) { cleanup(); reject(error); }
    });
  }

  sendProxyError(requestId: string): void {
    this._safeSendFrame(encodeFrame({
      type: MessageType.HttpResponseError,
      messageId: this._nextMessageId(),
      payload: encodeHttpResponse({ requestId, statusCode: 502, headers: {}, body: new Uint8Array(0) }),
    }), 'response-error', requestId);
  }

  /** Seller side: register a handler for incoming proxy requests. */
  onProxyRequest(handler: RequestHandler): void {
    this._requestHandler = handler;
  }

  /** Seller side: send a complete proxy response. */
  sendProxyResponse(response: SerializedHttpResponse): void {
    const payload = encodeHttpResponse(response);
    const frame = encodeFrame({
      type: MessageType.HttpResponse,
      messageId: this._nextMessageId(),
      payload,
    });

    this._safeSendFrame(frame, 'response', response.requestId);
  }

  /** Seller side: send a proxy response chunk. */
  sendProxyChunk(chunk: SerializedHttpResponseChunk): void {
    const type = chunk.done
      ? MessageType.HttpResponseEnd
      : MessageType.HttpResponseChunk;

    const payload = encodeHttpResponseChunk(chunk);
    const frame = encodeFrame({
      type,
      messageId: this._nextMessageId(),
      payload,
    });

    this._safeSendFrame(frame, chunk.done ? 'response-end' : 'response-chunk', chunk.requestId);
  }

  /** Route an incoming frame to the correct handler based on message type. */
  async handleFrame(frame: FramedMessage): Promise<void> {
    try {
      debugLog(`[ProxyMux] handleFrame type=${frame.type} (0x${frame.type.toString(16)}) payloadLen=${frame.payload?.length ?? 0}`);
      switch (frame.type) {
        case MessageType.HttpRequest: {
          // Seller side: incoming request from buyer
          const request = decodeHttpRequest(frame.payload);
          if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] === VIDEO_DOWNLOAD_STREAM_VERSION) {
            // Venice downloads are a small JSON POST naming the job.
            const validBody = request.method === 'POST' && request.body.length <= 4096;
            if (!validBody || request.headers[ANTSEED_UPLOAD_CHUNK_HEADER]) throw new Error('Invalid download request');
            if (this._downloadControllers.has(request.requestId)) throw new Error('Duplicate download request');
            this._downloadControllers.set(request.requestId, new AbortController());
          }
          debugLog(
            `[ProxyMux] recv request reqId=${request.requestId.slice(0, 8)} chunked=${request.headers[ANTSEED_UPLOAD_CHUNK_HEADER] === 'chunked' ? "true" : "false"} bodyBytes=${request.body?.length ?? 0} bodyType=${typeof request.body}`,
          );
          if (request.headers[ANTSEED_UPLOAD_CHUNK_HEADER] === 'chunked') {
            // Body will arrive via HttpRequestChunk/HttpRequestEnd — start buffering.
            // If a duplicate header frame arrives for the same requestId, evict the
            // existing entry first to prevent timer leaks and accounting drift.
            const existing = this._pendingUploads.get(request.requestId);
            if (existing) {
              clearTimeout(existing.timer);
              this._totalPendingUploadBytes -= existing.byteCount;
              for (const c of existing.chunks) c.fill(0);
            }
            const timer = setTimeout(
              () => this._abortUpload(request.requestId, 408, 'Upload timed out'),
              this._uploadTimeoutMs,
            );
            this._pendingUploads.set(request.requestId, {
              headerReq: request,
              chunks: [],
              byteCount: 0,
              timer,
            });
          } else if (this._requestHandler) {
            try { await this._requestHandler(request); }
            finally { this.finishDownload(request.requestId); }
          }
          break;
        }
        case MessageType.HttpRequestChunk: {
          // Seller side: non-final body chunk of a chunked upload
          const chunk = decodeHttpRequestChunk(frame.payload);
          const entry = this._pendingUploads.get(chunk.requestId);
          if (!entry || chunk.data.length === 0) break;
          debugLog(
            `[ProxyMux] recv request chunk reqId=${chunk.requestId.slice(0, 8)} bytes=${chunk.data.length} pending=${entry.byteCount + chunk.data.length}`,
          );

          // Per-request size guard
          if (entry.byteCount + chunk.data.length > this._maxUploadBodyBytes) {
            this._abortUpload(chunk.requestId, 413, 'Upload body exceeds per-request limit');
            break;
          }
          // Global budget guard
          if (this._totalPendingUploadBytes + chunk.data.length > this._maxTotalPendingUploadBytes) {
            this._abortUpload(chunk.requestId, 413, 'Server upload capacity exceeded');
            break;
          }

          entry.chunks.push(chunk.data);
          entry.byteCount += chunk.data.length;
          this._totalPendingUploadBytes += chunk.data.length;
          break;
        }
        case MessageType.HttpRequestEnd: {
          // Seller side: final body chunk — reassemble, zero intermediates, dispatch
          const chunk = decodeHttpRequestChunk(frame.payload);
          const entry = this._pendingUploads.get(chunk.requestId);
          if (!entry) break;
          debugLog(
            `[ProxyMux] recv request end reqId=${chunk.requestId.slice(0, 8)} finalBytes=${chunk.data.length} pendingBefore=${entry.byteCount}`,
          );

          // Check final chunk against limits
          const finalLen = chunk.data.length;
          if (finalLen > 0) {
            if (entry.byteCount + finalLen > this._maxUploadBodyBytes) {
              this._abortUpload(chunk.requestId, 413, 'Upload body exceeds per-request limit');
              break;
            }
            if (this._totalPendingUploadBytes + finalLen > this._maxTotalPendingUploadBytes) {
              this._abortUpload(chunk.requestId, 413, 'Server upload capacity exceeded');
              break;
            }
            entry.chunks.push(chunk.data);
            entry.byteCount += finalLen;
            this._totalPendingUploadBytes += finalLen;
          }

          // Clean up tracking state
          clearTimeout(entry.timer);
          this._pendingUploads.delete(chunk.requestId);
          this._totalPendingUploadBytes -= entry.byteCount;

          if (this._requestHandler) {
            const body = _concatChunks(entry.chunks);
            // Zero intermediates — reduces the window for sensitive data in RAM
            for (const c of entry.chunks) c.fill(0);
            entry.chunks.length = 0;

            const { [ANTSEED_UPLOAD_CHUNK_HEADER]: _marker, ...cleanHeaders } = entry.headerReq.headers;
            await this._requestHandler({ ...entry.headerReq, headers: cleanHeaders, body });
          }
          break;
        }
        case MessageType.HttpResponse: {
          // Buyer side: response from seller (start frame for streams).
          const response = decodeHttpResponse(frame.payload);
          debugLog(
            `[ProxyMux] recv response reqId=${response.requestId.slice(0, 8)} status=${response.statusCode} bytes=${response.body?.length ?? 0} streamingStart=${response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] === '1' ? "true" : "false"}`,
          );
          const handler = this._responseHandlers.get(response.requestId);
          if (handler) {
            const streamingStart = response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] === '1';
            if (!streamingStart) {
              this._downloads.delete(response.requestId);
              this._responseHandlers.delete(response.requestId);
              this._chunkHandlers.delete(response.requestId);
            }
            handler(response, { streamingStart });
          }
          break;
        }
        case MessageType.HttpResponseChunk: {
          // Buyer side: streaming chunk from seller
          const chunk = decodeHttpResponseChunk(frame.payload);
          debugLog(
            `[ProxyMux] recv response chunk reqId=${chunk.requestId.slice(0, 8)} bytes=${chunk.data.length} done=${chunk.done ? "true" : "false"}`,
          );
          const chunkHandler = this._chunkHandlers.get(chunk.requestId);
          if (chunkHandler) {
            if (this._downloads.has(chunk.requestId)) {
              if (chunk.done || chunk.data.length > VIDEO_DOWNLOAD_CHUNK_BYTES || this._consumingDownloads.has(chunk.requestId)) {
                this.cancelProxyRequest(chunk.requestId);
                throw new Error('Invalid download flow control');
              }
              this._consumingDownloads.add(chunk.requestId);
              try {
                await chunkHandler(chunk);
                if (this._downloads.has(chunk.requestId)) this._connection.send(encodeFrame({
                  type: MessageType.HttpResponseAck,
                  messageId: frame.messageId,
                  payload: encodeHttpResponseChunk({ ...chunk, data: new Uint8Array(0) }),
                }));
              } finally { this._consumingDownloads.delete(chunk.requestId); }
            } else { await chunkHandler(chunk); }
          }
          break;
        }
        case MessageType.HttpResponseEnd: {
          // Buyer side: final chunk (done=true) from seller
          const endChunk = decodeHttpResponseChunk(frame.payload);
          if (this._downloads.has(endChunk.requestId) && (endChunk.data.length || this._consumingDownloads.has(endChunk.requestId))) {
            this.cancelProxyRequest(endChunk.requestId);
            throw new Error('Invalid download end');
          }
          debugLog(
            `[ProxyMux] recv response end reqId=${endChunk.requestId.slice(0, 8)} bytes=${endChunk.data.length}`,
          );
          const endHandler = this._chunkHandlers.get(endChunk.requestId);
          if (endHandler) {
            await endHandler(endChunk);
            this._downloads.delete(endChunk.requestId);
            this._responseHandlers.delete(endChunk.requestId);
            this._chunkHandlers.delete(endChunk.requestId);
          }
          break;
        }
        case MessageType.HttpResponseError: {
          // Buyer side: error response from seller
          const errorResponse = decodeHttpResponse(frame.payload);
          const errorHandler = this._responseHandlers.get(errorResponse.requestId);
          if (errorHandler) {
            this._responseHandlers.delete(errorResponse.requestId);
            this._chunkHandlers.delete(errorResponse.requestId);
            this._downloads.delete(errorResponse.requestId);
            errorHandler(errorResponse, { streamingStart: false });
          }
          break;
        }
        case MessageType.HttpResponseAck: {
          const chunk = decodeHttpResponseChunk(frame.payload);
          const pending = this._downloadAcks.get(chunk.requestId);
          if (pending?.messageId === frame.messageId) pending.resolve();
          break;
        }
        case MessageType.HttpRequestCancel: {
          const chunk = decodeHttpResponseChunk(frame.payload);
          this.finishDownload(chunk.requestId);
          break;
        }
        default:
          // Unknown message type — ignore
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to handle proxy frame type ${frame.type}: ${message}`);
    }
  }

  /** Number of in-flight requests (buyer side). */
  activeRequestCount(): number {
    return this._responseHandlers.size;
  }

  /** Number of in-progress chunked uploads buffered on the seller side. */
  pendingUploadCount(): number {
    return this._pendingUploads.size;
  }

  /** Total bytes currently buffered across all in-progress uploads. */
  pendingUploadBytes(): number {
    return this._totalPendingUploadBytes;
  }

  /**
   * Seller side: abort and discard all buffered chunked-upload state.
   * Call on connection close or session end to prevent memory leaks.
   * Zeros all buffered chunk data before discarding.
   */
  abortPendingUploads(): void {
    for (const requestId of this._downloadControllers.keys()) this.finishDownload(requestId);
    for (const entry of this._pendingUploads.values()) {
      clearTimeout(entry.timer);
      for (const c of entry.chunks) c.fill(0);
    }
    this._pendingUploads.clear();
    this._totalPendingUploadBytes = 0;
  }

  /**
   * Abort a single in-progress upload, zero its buffers, and send an error
   * response to the buyer.
   */
  private _abortUpload(requestId: string, statusCode: number, reason: string): void {
    const entry = this._pendingUploads.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this._totalPendingUploadBytes -= entry.byteCount;
    for (const c of entry.chunks) c.fill(0);
    this._pendingUploads.delete(requestId);

    this.sendProxyResponse({
      requestId,
      statusCode,
      headers: {
        'content-type': 'text/plain',
        ...(statusCode === 413 ? { 'x-antseed-max-upload-body-bytes': String(this._maxUploadBodyBytes) } : {}),
      },
      body: new TextEncoder().encode(reason),
    });
  }

  private _safeSendFrame(frame: Uint8Array, kind: 'response' | 'response-chunk' | 'response-end' | 'response-error' | 'cancel', requestId: string): void {
    try {
      this._connection.send(frame);
    } catch (err) {
      debugLog(
        `[ProxyMux] drop ${kind} reqId=${requestId.slice(0, 8)} because connection closed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private _nextMessageId(): number {
    const id = this._messageIdCounter;
    this._messageIdCounter = (this._messageIdCounter + 1) & 0xFFFFFFFF;
    return id;
  }
}

function _concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!.slice();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
