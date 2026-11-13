import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
  SerializedHttpRequestChunk,
} from "./http.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode an HTTP request into binary format:
 * [requestIdLen:2][requestId:N][methodLen:1][method:N][pathLen:2][path:N]
 * [headerCount:2][for each header: keyLen:2, key:N, valLen:2, val:N]
 * [bodyLen:4][body:N]
 */
export function encodeHttpRequest(req: SerializedHttpRequest): Uint8Array {
  const requestIdBytes = encoder.encode(req.requestId);
  const methodBytes = encoder.encode(req.method);
  const pathBytes = encoder.encode(req.path);

  const headerEntries = Object.entries(req.headers);
  const encodedHeaders: Array<{ key: Uint8Array; val: Uint8Array }> = [];
  let headersSize = 0;
  for (const [key, val] of headerEntries) {
    const keyBytes = encoder.encode(key);
    const valBytes = encoder.encode(val);
    encodedHeaders.push({ key: keyBytes, val: valBytes });
    headersSize += 2 + keyBytes.length + 2 + valBytes.length;
  }

  const totalSize =
    2 + requestIdBytes.length +
    1 + methodBytes.length +
    2 + pathBytes.length +
    2 + headersSize +
    4 + req.body.length;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  // requestId
  view.setUint16(offset, requestIdBytes.length);
  offset += 2;
  buf.set(requestIdBytes, offset);
  offset += requestIdBytes.length;

  // method
  view.setUint8(offset, methodBytes.length);
  offset += 1;
  buf.set(methodBytes, offset);
  offset += methodBytes.length;

  // path
  view.setUint16(offset, pathBytes.length);
  offset += 2;
  buf.set(pathBytes, offset);
  offset += pathBytes.length;

  // headers
  view.setUint16(offset, headerEntries.length);
  offset += 2;
  for (const { key, val } of encodedHeaders) {
    view.setUint16(offset, key.length);
    offset += 2;
    buf.set(key, offset);
    offset += key.length;
    view.setUint16(offset, val.length);
    offset += 2;
    buf.set(val, offset);
    offset += val.length;
  }

  // body
  view.setUint32(offset, req.body.length);
  offset += 4;
  buf.set(req.body, offset);

  return buf;
}

/**
 * Decode binary data into a SerializedHttpRequest.
 */
export function decodeHttpRequest(data: Uint8Array): SerializedHttpRequest {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // requestId
  const requestIdLen = view.getUint16(offset);
  offset += 2;
  const requestId = decoder.decode(data.slice(offset, offset + requestIdLen));
  offset += requestIdLen;

  // method
  const methodLen = view.getUint8(offset);
  offset += 1;
  const method = decoder.decode(data.slice(offset, offset + methodLen));
  offset += methodLen;

  // path
  const pathLen = view.getUint16(offset);
  offset += 2;
  const path = decoder.decode(data.slice(offset, offset + pathLen));
  offset += pathLen;

  // headers
  const headerCount = view.getUint16(offset);
  offset += 2;
  const headers: Record<string, string> = {};
  for (let i = 0; i < headerCount; i++) {
    const keyLen = view.getUint16(offset);
    offset += 2;
    const key = decoder.decode(data.slice(offset, offset + keyLen));
    offset += keyLen;
    const valLen = view.getUint16(offset);
    offset += 2;
    const val = decoder.decode(data.slice(offset, offset + valLen));
    offset += valLen;
    headers[key] = val;
  }

  // body
  const bodyLen = view.getUint32(offset);
  offset += 4;
  const body = data.slice(offset, offset + bodyLen);

  return { requestId, method, path, headers, body };
}

/**
 * Encode an HTTP response into binary format:
 * [requestIdLen:2][requestId:N][statusCode:2]
 * [headerCount:2][for each header: keyLen:2, key:N, valLen:2, val:N]
 * [bodyLen:4][body:N]
 */
export function encodeHttpResponse(resp: SerializedHttpResponse): Uint8Array {
  if (!resp.body) {
    resp = { ...resp, body: new Uint8Array(0) };
  }
  const requestIdBytes = encoder.encode(resp.requestId);

  const headerEntries = Object.entries(resp.headers);
  const encodedHeaders: Array<{ key: Uint8Array; val: Uint8Array }> = [];
  let headersSize = 0;
  for (const [key, val] of headerEntries) {
    const keyBytes = encoder.encode(key);
    const valBytes = encoder.encode(val);
    encodedHeaders.push({ key: keyBytes, val: valBytes });
    headersSize += 2 + keyBytes.length + 2 + valBytes.length;
  }

  const totalSize =
    2 + requestIdBytes.length +
    2 +
    2 + headersSize +
    4 + resp.body.length;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  // requestId
  view.setUint16(offset, requestIdBytes.length);
  offset += 2;
  buf.set(requestIdBytes, offset);
  offset += requestIdBytes.length;

  // statusCode
  view.setUint16(offset, resp.statusCode);
  offset += 2;

  // headers
  view.setUint16(offset, headerEntries.length);
  offset += 2;
  for (const { key, val } of encodedHeaders) {
    view.setUint16(offset, key.length);
    offset += 2;
    buf.set(key, offset);
    offset += key.length;
    view.setUint16(offset, val.length);
    offset += 2;
    buf.set(val, offset);
    offset += val.length;
  }

  // body
  view.setUint32(offset, resp.body.length);
  offset += 4;
  buf.set(resp.body, offset);

  return buf;
}

/**
 * Encode every HTTP response field before the body bytes, using the supplied
 * body length. Streaming callers hash this prefix and then append body chunks.
 */
export function encodeHttpResponsePrefix(
  resp: Omit<SerializedHttpResponse, 'body'>,
  bodyLength: number,
): Uint8Array {
  if (!Number.isInteger(bodyLength) || bodyLength < 0 || bodyLength > 0xffff_ffff) {
    throw new RangeError('HTTP response body length must fit in uint32');
  }
  const encoded = encodeHttpResponse({ ...resp, body: new Uint8Array(0) });
  new DataView(encoded.buffer).setUint32(encoded.length - 4, bodyLength);
  return encoded;
}

/**
 * Decode binary data into a SerializedHttpResponse.
 */
export function decodeHttpResponse(data: Uint8Array): SerializedHttpResponse {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // requestId
  const requestIdLen = view.getUint16(offset);
  offset += 2;
  const requestId = decoder.decode(data.slice(offset, offset + requestIdLen));
  offset += requestIdLen;

  // statusCode
  const statusCode = view.getUint16(offset);
  offset += 2;

  // headers
  const headerCount = view.getUint16(offset);
  offset += 2;
  const headers: Record<string, string> = {};
  for (let i = 0; i < headerCount; i++) {
    const keyLen = view.getUint16(offset);
    offset += 2;
    const key = decoder.decode(data.slice(offset, offset + keyLen));
    offset += keyLen;
    const valLen = view.getUint16(offset);
    offset += 2;
    const val = decoder.decode(data.slice(offset, offset + valLen));
    offset += valLen;
    headers[key] = val;
  }

  // body
  const bodyLen = view.getUint32(offset);
  offset += 4;
  const body = data.slice(offset, offset + bodyLen);

  return { requestId, statusCode, headers, body };
}

/**
 * Encode an HTTP response chunk into binary format:
 * [requestIdLen:2][requestId:N][done:1][dataLen:4][data:N]
 */
export function encodeHttpResponseChunk(
  chunk: SerializedHttpResponseChunk
): Uint8Array {
  const requestIdBytes = encoder.encode(chunk.requestId);

  const totalSize =
    2 + requestIdBytes.length +
    1 +
    4 + chunk.data.length;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  // requestId
  view.setUint16(offset, requestIdBytes.length);
  offset += 2;
  buf.set(requestIdBytes, offset);
  offset += requestIdBytes.length;

  // done
  view.setUint8(offset, chunk.done ? 1 : 0);
  offset += 1;

  // data
  view.setUint32(offset, chunk.data.length);
  offset += 4;
  buf.set(chunk.data, offset);

  return buf;
}

/**
 * Decode binary data into a SerializedHttpResponseChunk.
 */
export function decodeHttpResponseChunk(
  data: Uint8Array
): SerializedHttpResponseChunk {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  // requestId
  const requestIdLen = view.getUint16(offset);
  offset += 2;
  const requestId = decoder.decode(data.slice(offset, offset + requestIdLen));
  offset += requestIdLen;

  // done
  const done = view.getUint8(offset) === 1;
  offset += 1;

  // data
  const dataLen = view.getUint32(offset);
  offset += 4;
  const chunkData = data.slice(offset, offset + dataLen);

  return { requestId, data: chunkData, done };
}

/**
 * Encode an HTTP request chunk into binary format:
 * [requestIdLen:2][requestId:N][done:1][dataLen:4][data:N]
 */
export function encodeHttpRequestChunk(
  chunk: SerializedHttpRequestChunk
): Uint8Array {
  const requestIdBytes = encoder.encode(chunk.requestId);

  const totalSize =
    2 + requestIdBytes.length +
    1 +
    4 + chunk.data.length;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  view.setUint16(offset, requestIdBytes.length);
  offset += 2;
  buf.set(requestIdBytes, offset);
  offset += requestIdBytes.length;

  view.setUint8(offset, chunk.done ? 1 : 0);
  offset += 1;

  view.setUint32(offset, chunk.data.length);
  offset += 4;
  buf.set(chunk.data, offset);

  return buf;
}

/**
 * Decode binary data into a SerializedHttpRequestChunk.
 */
export function decodeHttpRequestChunk(
  data: Uint8Array
): SerializedHttpRequestChunk {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const requestIdLen = view.getUint16(offset);
  offset += 2;
  const requestId = decoder.decode(data.slice(offset, offset + requestIdLen));
  offset += requestIdLen;

  const done = view.getUint8(offset) === 1;
  offset += 1;

  const dataLen = view.getUint32(offset);
  offset += 4;
  const chunkData = data.slice(offset, offset + dataLen);

  return { requestId, data: chunkData, done };
}
