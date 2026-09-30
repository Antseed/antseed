export const ANTSEED_STREAMING_RESPONSE_HEADER = 'x-antseed-streaming';
export const VIDEO_DOWNLOAD_STREAM_HEADER = 'x-antseed-video-download';
export const VIDEO_DOWNLOAD_STREAM_VERSION = 'video-stream-v1';
/** Keep the first native-video download path bounded and predictable. */
export const VIDEO_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const VIDEO_DOWNLOAD_CHUNK_BYTES = 64 * 1024;
export const ANTSEED_FAULT_ATTRIBUTION_HEADER = 'x-antseed-fault-attribution';
export const ANTSEED_BUYER_FAULT_ERROR_CODE = 'antseed_buyer_fault';
/** Header carrying a pre-signed SpendingAuth for manual payment approval. Base64-encoded JSON. */
export const ANTSEED_SPENDING_AUTH_HEADER = 'x-antseed-spending-auth';
/** Marker header set on HttpRequest frames whose body is sent via HttpRequestChunk/End frames. */
export const ANTSEED_UPLOAD_CHUNK_HEADER = 'x-antseed-upload';
/**
 * Maximum size of a request body that can be sent as a single request frame.
 * Larger bodies are sent as chunked upload frames. WebRTC data channels cap
 * messages at 256 KiB, so this stays below that with headroom for the frame's
 * requestId/method/path/headers.
 */
export const ANTSEED_UPLOAD_THRESHOLD_BYTES = 240 * 1024;
/**
 * Maximum size of each chunk when sending chunked request uploads.
 * Kept small for cross-peer RTC compatibility where max message size can vary
 * across environments.
 */
export const ANTSEED_UPLOAD_CHUNK_SIZE = 8 * 1024;

export interface SerializedHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  streamedBody?: { byteLength: number; responseHash: string };
}

export interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

export interface SerializedHttpRequestChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}
