import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  VIDEO_DOWNLOAD_CHUNK_BYTES,
  VIDEO_DOWNLOAD_MAX_BYTES,
  VIDEO_DOWNLOAD_STREAM_HEADER,
  VIDEO_DOWNLOAD_STREAM_VERSION,
  type ProviderStreamCallbacks,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from '@antseed/node';

export function videoDownloadError(request: SerializedHttpRequest, statusCode: number, code: string, message: string): SerializedHttpResponse {
  return {
    requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: { code, message } })),
  };
}

const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Keep downloads bounded by the ordinary request timeout. */
export function videoDownloadSignal(callerSignal: AbortSignal): { signal: AbortSignal; progress: () => void; done: () => void } {
  return {
    signal: AbortSignal.any([callerSignal, AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS)]),
    progress: () => {},
    done: () => {},
  };
}

/**
 * Validates an upstream MP4 response and streams it to the buyer in bounded
 * chunks. Returns an error response (nothing sent yet) when the upstream answer
 * is not a usable video. Throws once bytes have started so the buyer never sees
 * a truncated file as complete.
 */
export async function streamVideoResponse(
  request: SerializedHttpRequest,
  upstream: Response,
  callbacks: ProviderStreamCallbacks,
  download: { signal: AbortSignal; progress: () => void },
): Promise<SerializedHttpResponse> {
  const lengthHeader = upstream.headers.get('content-length');
  const length = lengthHeader === null ? null : Number(lengthHeader);
  const validLength = lengthHeader === null || (length !== null && /^[1-9][0-9]*$/.test(lengthHeader) && Number.isSafeInteger(length) && length <= VIDEO_DOWNLOAD_MAX_BYTES);
  if (upstream.status !== 200 || !validLength
    || upstream.headers.get('content-type')?.split(';')[0]?.trim() !== 'video/mp4'
    || ![null, 'identity'].includes(upstream.headers.get('content-encoding'))) {
    await upstream.body?.cancel();
    return videoDownloadError(request, length !== null && length > VIDEO_DOWNLOAD_MAX_BYTES ? 413 : [404, 410].includes(upstream.status) ? upstream.status : 502, 'video_download_unavailable', 'Video is unavailable or exceeds download limits');
  }
  const reader = upstream.body?.getReader();
  if (!reader) return videoDownloadError(request, 502, 'video_download_unavailable', 'Empty video response');
  const response: SerializedHttpResponse = { requestId: request.requestId, statusCode: 200, headers: {
    'content-type': 'video/mp4', ...(length === null ? {} : { 'content-length': String(length) }), 'cache-control': 'no-store',
    [ANTSEED_STREAMING_RESPONSE_HEADER]: '1', [VIDEO_DOWNLOAD_STREAM_HEADER]: VIDEO_DOWNLOAD_STREAM_VERSION,
  }, body: new Uint8Array(0) };
  let received = 0;
  // A stalled read does not observe the signal, so cancel the reader directly.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  download.signal.addEventListener('abort', cancel, { once: true });
  try {
    callbacks.onResponseStart(response);
    while (true) {
      download.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > VIDEO_DOWNLOAD_MAX_BYTES || (length !== null && received > length)) throw new Error('Video exceeds download limit');
      for (let offset = 0; offset < value.length; offset += VIDEO_DOWNLOAD_CHUNK_BYTES) {
        download.signal.throwIfAborted();
        await callbacks.onResponseChunk({ requestId: request.requestId, data: value.subarray(offset, offset + VIDEO_DOWNLOAD_CHUNK_BYTES), done: false });
        download.progress();
      }
    }
    if (length !== null && received !== length) throw new Error('Incomplete video');
    await callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
    return response;
  } catch {
    throw new Error('Video download interrupted');
  } finally {
    download.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
