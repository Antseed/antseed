import { describe, expect, it } from 'vitest';
import { MULTIPART_PRICED_FIELDS, extractImageRequestFacts, parseMultipartFormFields, readPlainMultipartParts } from '../src/utils.js';

const boundary = 'b0undary';
const contentType = `multipart/form-data; boundary=${boundary}`;
const part = (headers: string, content: string) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`;
const closing = `--${boundary}--\r\n`;
const body = (text: string) => new TextEncoder().encode(text);
const named = (name: string, content: string) => part(`Content-Disposition: form-data; name="${name}"`, content);

describe('readPlainMultipartParts', () => {
  it('reads each part without copying its content', () => {
    const bytes = body(`${named('model', 'svc')}${part('Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG')}${closing}`);
    const parts = readPlainMultipartParts(bytes, contentType)!;
    expect(parts.map(({ name, billedText }) => [name, billedText])).toEqual([['model', true], ['image', false]]);
    expect(parts.map(({ content }) => new TextDecoder().decode(content))).toEqual(['svc', 'PNG']);
    expect(parts[0]!.content.buffer).toBe(bytes.buffer);
  });

  it('says which parts billing reads as text', () => {
    const unquoted = part('Content-Disposition: form-data; name=prompt', 'x');
    const oversized = named('long', 'x'.repeat(4097));
    const extendedFile = part("Content-Disposition: form-data; name=\"file\"; filename*=UTF-8''a.png", 'PNG');
    const parts = readPlainMultipartParts(body(`${unquoted}${oversized}${extendedFile}${closing}`), contentType)!;
    expect(parts.map(({ name, billedText }) => [name, billedText])).toEqual([['prompt', false], ['long', false], ['file', false]]);
  });

  it.each<[string, string, boolean]>([
    ['no other headers', '', true],
    ['plain text', 'Content-Type: text/plain', true],
    ['UTF-8 text with a length', 'Content-Type: text/plain; charset=utf-8\r\nContent-Length: 3', true],
    ['Latin-1 text in 8bit', 'Content-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: 8bit', true],
    ['another charset', 'Content-Type: text/plain; charset=utf-16', false],
    ['an unknown charset', 'Content-Type: text/plain; charset=x', false],
    ['another type', 'Content-Type: application/json', false],
    ['a transfer encoding', 'Content-Transfer-Encoding: base64', false],
    ['another header', 'X-Other: 1', false],
    ['a length that matches', 'Content-Length: 3', true],
    ['a length that does not', 'Content-Length: 2', false],
  ])('calls a text part with %s billed text: %s', (_name, extra, billedText) => {
    const headers = `Content-Disposition: form-data; name="model"${extra ? `\r\n${extra}` : ''}`;
    expect(readPlainMultipartParts(body(`${part(headers, 'svc')}${closing}`), contentType)?.[0]?.billedText).toBe(billedText);
  });

  it.each<[string, string, string?]>([
    ['a closing delimiter alone', `${named('model', 'svc')}${closing}`],
    ['no line end after the closing delimiter', `${named('model', 'svc')}--${boundary}--`],
    ['a blank line after the closing delimiter', `${named('model', 'svc')}${closing}\r\n`],
    ['whitespace before the first delimiter', ` \t\r\n${named('model', 'svc')}${closing}`],
    ['a CRLF before the first delimiter', `\r\n${named('model', 'svc')}${closing}`],
    ['a charset before the boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; charset=utf-8; boundary=${boundary}`],
    ['a charset after the boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; boundary=${boundary}; charset=UTF-8`],
    ['a quoted boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; boundary="${boundary}"`],
    ['headers in another case', `${part('content-disposition: form-data; name="model"\r\nCONTENT-TYPE: text/plain', 'svc')}${closing}`],
    ['the filename first', `${part('Content-Disposition: form-data; filename="a.png"; name="image"', 'PNG')}${closing}`],
    ['a backslash in a filename', `${part('Content-Disposition: form-data; name="image"; filename="dir\\file.png"', 'PNG')}${closing}`],
    ['an escaped quote in a filename', `${part('Content-Disposition: form-data; name="image"; filename="a\\"b.png"', 'PNG')}${closing}`],
    ['another disposition parameter', `${part('Content-Disposition: form-data; name="a"; size=1', 'svc')}${closing}`],
    ['another header on a file part', `${part('Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\nX-Note: taken today', 'PNG')}${closing}`],
    ['a disposition line quoted in a part\'s content', `${named('prompt', 'Content-Disposition: form-data; name="model"')}${closing}`],
    ['a file named after the header', `${part('Content-Disposition: form-data; name="image"; filename="content-disposition.png"', 'PNG')}${closing}`],
    ['the header name without a colon in another header', `${part('Content-Disposition: form-data; name="image"; filename="a.png"\r\nX-Note: no content-disposition here', 'PNG')}${closing}`],
    ['a filename in continuations', `${part('Content-Disposition: form-data; name="image"; filename*0="a"; filename*1=".png"', 'PNG')}${closing}`],
    ['another parameter before a quoted name', `${part('Content-Disposition: form-data; x="1"; name="a"', 'svc')}${closing}`],
  ])('reads %s', (_name, text, type = contentType) => {
    expect(readPlainMultipartParts(body(text), type)).not.toBeNull();
  });

  it.each<[string, string, string?]>([
    ['not multipart', named('model', 'svc'), 'application/json'],
    ['no boundary', named('model', 'svc'), 'multipart/form-data'],
    ['a non-empty preamble', `Preamble.\r\n${named('model', 'svc')}${closing}`],
    ['a preamble with another form', `--other\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n--other--\r\n${named('model', 'svc')}${closing}`],
    ['a first delimiter inside a line', `x${named('model', 'svc')}${closing}`],
    ['a bare LF after a delimiter', `--${boundary}\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`],
    ['text after a delimiter', `--${boundary}x\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`],
    ['more after the closing delimiter', `${named('model', 'svc')}${closing}${named('model', 'other')}`],
    ['no closing delimiter', `${named('model', 'svc')}`],
    ['the delimiter inside a part', `${named('prompt', `x\n--${boundary}\ny`)}${closing}`],
    ['two boundary parameters', `${named('model', 'svc')}${closing}`, `${contentType}; boundary=other`],
    ['another parameter ending in boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; xboundary=${boundary}; boundary=other`],
    ['a boundary with a space', `${named('model', 'svc')}${closing}`, `multipart/form-data; boundary=" ${boundary}"`],
    ['a folded header', `${part('Content-Disposition: form-data;\r\n name="model"', 'svc')}${closing}`],
    ['a bare LF in the headers', `${part('Content-Disposition: form-data; name="a"\nX: y', 'svc')}${closing}`],
    ['two dispositions', `${part('Content-Disposition: form-data; name="a"\r\nContent-Disposition: form-data; name="b"', 'svc')}${closing}`],
    ['no disposition', `${part('Content-Type: text/plain', 'svc')}${closing}`],
    ['a disposition that is not form-data', `${part('Content-Disposition: attachment; name="a"', 'svc')}${closing}`],
    ['an upper-case parameter', `${part('Content-Disposition: form-data; NAME="a"', 'svc')}${closing}`],
    ['an extended name', `${part("Content-Disposition: form-data; name*=UTF-8''a", 'svc')}${closing}`],
    ['a name in continuations', `${part('Content-Disposition: form-data; name*0="a"; name*1="b"', 'svc')}${closing}`],
    ['two names', `${part('Content-Disposition: form-data; name="a"; name="b"', 'svc')}${closing}`],
    ['an escaped name', `${part('Content-Disposition: form-data; name="a\\b"', 'svc')}${closing}`],
    ['a percent-encoded name', `${part('Content-Disposition: form-data; name="a%62"', 'svc')}${closing}`],
    ['an encoded-word name', `${part('Content-Disposition: form-data; name="=?utf-8?q?a?="', 'svc')}${closing}`],
    ['a filename ending in a backslash', `${part('Content-Disposition: form-data; name="a"; filename="b\\"; name="c"', 'svc')}${closing}`],
    ['a parameter ending in name', `${part('Content-Disposition: form-data; xname="b"; name="a"', 'svc')}${closing}`],
    ['a non-ASCII name', `${part('Content-Disposition: form-data; name="a\u00e9"', 'svc')}${closing}`],
    ['an escaped quote hiding a parameter', `${part('Content-Disposition: form-data; name="a"; filename="b\\"; x=y; c="', 'svc')}${closing}`],
    ['a UTF-7 body', `${named('model', 'svc')}${closing}`, `multipart/form-data; charset=utf-7; boundary=${boundary}`],
    ['an unknown content type parameter', `${named('model', 'svc')}${closing}`, `${contentType}; x=y`],
    ['a nested multipart', `${part('Content-Disposition: form-data; name="a"\r\nContent-Type: multipart/mixed; boundary=c', '--c--')}${closing}`],
    ['a field setting the charset of the others', `${named('_charset_', 'utf-16')}${closing}`],
    ['another header quoting a disposition line', `${part('X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"', 'PNG')}${closing}`],
    ['a quoted disposition line after the real one', `${part('Content-Disposition: form-data; name="image"; filename="a.png"\r\nX-Note: Content-Disposition: form-data; name="model"', 'PNG')}${closing}`],
    ['a disposition line quoted in a Content-Type parameter', `${part('Content-Type: image/png; content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"', 'PNG')}${closing}`],
    ['a disposition line quoted in upper case', `${part('X-Note: CONTENT-DISPOSITION:\tFORM-DATA;NAME="model"\r\nContent-Disposition: form-data; name="prompt"', 'x')}${closing}`],
    ['the header name and a colon in another header', `${part('X-Note: see content-disposition : x\r\nContent-Disposition: form-data; name="prompt"', 'x')}${closing}`],
    ['the header name and a colon in a filename', `${part('Content-Disposition: form-data; name="image"; filename="content-disposition: form-data; .png"', 'PNG')}${closing}`],
    ['a parameter that starts like filename and ends in name', `${part('Content-Disposition: form-data; filenamename="size"; name="user"', 'x')}${closing}`],
    ['such a parameter after an unquoted name', `${part('Content-Disposition: form-data; name=user; filename-x-name="quality"', 'x')}${closing}`],
    ['a parameter value billing would read as the name', `${part('Content-Disposition: form-data; x="name="; y="size"; name="user"', 'x')}${closing}`],
  ])('refuses %s', (_name, text, type = contentType) => {
    expect(readPlainMultipartParts(body(text), type)).toBeNull();
  });
});

describe('parseMultipartFormFields', () => {
  it('reads disposition headers only at the start of their own line', () => {
    const prompt = part('X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="prompt"', 'keep this prompt');
    expect(parseMultipartFormFields(body(`${prompt}${named('model', 'svc')}${closing}`), contentType))
      .toEqual({ prompt: 'keep this prompt', model: 'svc' });
  });

  it('keeps the first of each text field and skips files and oversized fields', () => {
    const text = `${named('model', 'first')}${named('model', 'second')}${named('prompt', 'x'.repeat(4097))}${part('Content-Disposition: form-data; name="image"; filename="a.png"', 'PNG')}${closing}`;
    expect(parseMultipartFormFields(body(text), contentType)).toEqual({ model: 'first' });
  });

  it('still reads the fields of a body written another way', () => {
    expect(parseMultipartFormFields(body(`x${named('model', 'svc')}${closing}`), contentType)).toEqual({ model: 'svc' });
    expect(parseMultipartFormFields(body(`${named('model', 'svc')}${closing}`), `${contentType}; boundary=other`)).toEqual({ model: 'svc' });
  });
});

describe('MULTIPART_PRICED_FIELDS', () => {
  it('lists every form field an image request is priced by, beside its service', () => {
    const read = new Set<string>();
    const form = new Proxy({} as Record<string, unknown>, {
      get: (_fields, name) => { read.add(String(name)); return undefined; },
    });
    for (const path of ['/v1/images/edits', '/v1/images/generations', '/v1/chat/completions']) {
      extractImageRequestFacts({ path, method: 'POST', body: form });
    }
    // `prompt` only sizes the buyer's own estimate, and `model` and `service` have their own check.
    for (const name of ['model', 'service', 'prompt']) read.delete(name);
    expect([...read].sort()).toEqual([...MULTIPART_PRICED_FIELDS].sort());
  });

  it('prices a form by those fields as it prices JSON', () => {
    const contentType = 'multipart/form-data; boundary=b';
    const text = ['model', 'size', 'quality', 'resolution', 'n'].map((name, index) => `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${['svc', '1024x1024', 'high', '2K', '3'][index]}\r\n`).join('');
    const fields = parseMultipartFormFields(new TextEncoder().encode(`${text}--b--\r\n`), contentType)!;
    expect(extractImageRequestFacts({ path: '/v1/images/edits', body: fields }))
      .toEqual(extractImageRequestFacts({ path: '/v1/images/edits', body: { model: 'svc', size: '1024x1024', quality: 'high', resolution: '2K', n: 3 } }));
  });
});
