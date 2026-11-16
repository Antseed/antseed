import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { exposedResponseHeaders } from './response-headers.js';

/**
 * A data provider's answer for the buyer: the headers `exposedResponseHeaders` lets through, and
 * its body decoded when the provider sent it compressed (gzip, deflate or br), since the encoding
 * header is not exposed. Nothing else in the body changes: it is the provider's own API answer,
 * so it is exempt from the cost rewrite inference answers get (`withExposedBody`), as a video
 * download is. An answer that does not decode is passed on as sent, with its Content-Encoding.
 */
export function exposedDataResponse<T extends { headers: Record<string, string>; body: Uint8Array }>(response: T): T {
  const headers = exposedResponseHeaders(response.headers);
  const encodingHeader = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-encoding');
  const encodings = (encodingHeader?.[1] ?? '').split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value !== 'identity');
  if (encodings.length === 0 || response.body.length === 0) return { ...response, headers };
  // Encodings are listed in the order they were applied: undo them last first. An encoding this
  // node cannot undo, or a body that does not decode, goes on as sent with its Content-Encoding.
  const asSent = { ...response, headers: { ...headers, [encodingHeader![0]]: encodingHeader![1] } };
  let body: Uint8Array = response.body;
  for (const encoding of [...encodings].reverse()) {
    const decode = encoding === 'gzip' || encoding === 'x-gzip' ? gunzipSync
      : encoding === 'deflate' ? inflateSync
      : encoding === 'br' ? brotliDecompressSync
      : null;
    if (!decode) return asSent;
    try {
      body = new Uint8Array(decode(body));
    } catch {
      return asSent;
    }
  }
  return { ...response, headers, body };
}
