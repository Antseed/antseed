/**
 * A frozen copy of how `HttpRelay` in `@antseed/provider-core` read and rewrote a
 * multipart body before it matched `Content-Disposition` only at the start of a
 * header line. Installed plugins pin their own copy of the relay, so sellers keep
 * running this code until their plugins refresh. The three functions are copied
 * as they were; `relayMultipartBody` is the relay's own use of them. Never update
 * this file to follow the relay: it stands for the plugins already installed.
 */

function multipartBoundary(contentType: string): string {
  const match = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType.trim());
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function readMultipartTextFields(
  body: Uint8Array,
  contentType: string,
  fieldNames: readonly string[],
): Map<string, string> {
  const fields = new Map<string, string>();
  const boundary = multipartBoundary(contentType);
  if (!boundary) return fields;
  const wanted = new Set(fieldNames);
  const text = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  let index = text.indexOf(delimiter);
  while (index !== -1 && fields.size < wanted.size) {
    index += delimiter.length;
    if (text.startsWith('--', index)) break;
    const headerEnd = text.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;
    const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next === -1) break;
    const headers = text.slice(index, headerEnd);
    const params = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(params)?.[1] ?? '';
    if (wanted.has(name) && !fields.has(name) && !/filename\s*=/i.test(params)) {
      fields.set(name, new TextDecoder().decode(body.subarray(headerEnd + 4, next)).trim());
    }
    index = next + 2;
  }
  return fields;
}

function setMultipartTextField(
  body: Uint8Array,
  contentType: string,
  fieldName: string,
  value: string,
): Uint8Array | null {
  const boundary = multipartBoundary(contentType);
  if (!boundary || !/^[A-Za-z0-9_.-]+$/.test(fieldName)) return null;
  const text = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  let index = text.indexOf(delimiter);
  while (index !== -1) {
    index += delimiter.length;
    if (text.startsWith('--', index)) break;
    const headerEnd = text.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;
    const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next === -1) break;
    const headers = text.slice(index, headerEnd);
    const params = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(params)?.[1] ?? '';
    if (name === fieldName && !/filename\s*=/i.test(params)) {
      const replacement = new TextEncoder().encode(value);
      const out = new Uint8Array(headerEnd + 4 + replacement.length + body.length - next);
      out.set(body.subarray(0, headerEnd + 4), 0);
      out.set(replacement, headerEnd + 4);
      out.set(body.subarray(next), headerEnd + 4 + replacement.length);
      return out;
    }
    index = next + 2;
  }

  const finalDelimiter = `${delimiter}--`;
  const finalIndex = text.lastIndexOf(finalDelimiter);
  if (finalIndex === -1) return null;
  const insertion = new TextEncoder().encode(
    `${delimiter}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`,
  );
  const out = new Uint8Array(finalIndex + insertion.length + body.length - finalIndex);
  out.set(body.subarray(0, finalIndex), 0);
  out.set(insertion, finalIndex);
  out.set(body.subarray(finalIndex), finalIndex + insertion.length);
  return out;
}

/**
 * The multipart body that relay sends its upstream for a request the seller
 * handed it: the seller's `x-antseed-service` header names the service, and
 * `aliases` is the plugin's alias map (lowercase service to upstream model).
 */
export function relayMultipartBody(
  request: { headers: Record<string, string>; body: Uint8Array },
  aliases: Record<string, string>,
): Uint8Array {
  const header = (name: string) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
  const contentType = header('content-type');
  const fields = readMultipartTextFields(request.body, contentType, ['service', 'model', 'modelId']);
  const requestedService = header('x-antseed-service').trim() || fields.get('service') || fields.get('model') || '';
  if (!requestedService) return request.body;
  const upstreamModel = aliases[requestedService.toLowerCase()]?.trim() || requestedService;
  const modelField = !fields.has('model') && fields.has('modelId') ? 'modelId' : 'model';
  return setMultipartTextField(request.body, contentType, modelField, upstreamModel) ?? request.body;
}
