import { describe, expect, it } from 'vitest';
import { parseMultipartFormFields, readPlainMultipartParts } from '../src/utils.js';

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
  ])('calls a text part with %s billed text: %s', (_name, extra, billedText) => {
    const headers = `Content-Disposition: form-data; name="model"${extra ? `\r\n${extra}` : ''}`;
    expect(readPlainMultipartParts(body(`${part(headers, 'svc')}${closing}`), contentType)?.[0]?.billedText).toBe(billedText);
  });

  it.each<[string, string, string?]>([
    ['a closing delimiter alone', `${named('model', 'svc')}${closing}`],
    ['no line end after the closing delimiter', `${named('model', 'svc')}--${boundary}--`],
    ['a blank line after the closing delimiter', `${named('model', 'svc')}${closing}\r\n`],
    ['a CRLF before the first delimiter', `\r\n${named('model', 'svc')}${closing}`],
    ['a charset before the boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; charset=utf-8; boundary=${boundary}`],
    ['a charset after the boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; boundary=${boundary}; charset=UTF-8`],
    ['a quoted boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; boundary="${boundary}"`],
    ['headers in another case', `${part('content-disposition: form-data; name="model"\r\nCONTENT-TYPE: text/plain', 'svc')}${closing}`],
    ['the filename first', `${part('Content-Disposition: form-data; filename="a.png"; name="image"', 'PNG')}${closing}`],
  ])('reads %s', (_name, text, type = contentType) => {
    expect(readPlainMultipartParts(body(text), type)).not.toBeNull();
  });

  it.each<[string, string, string?]>([
    ['not multipart', named('model', 'svc'), 'application/json'],
    ['no boundary', named('model', 'svc'), 'multipart/form-data'],
    ['text before the first delimiter', `preamble\r\n${named('model', 'svc')}${closing}`],
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
    ['an escaped filename', `${part('Content-Disposition: form-data; name="a"; filename="b\\"; name=\\"c"', 'svc')}${closing}`],
    ['an unknown parameter', `${part('Content-Disposition: form-data; name="a"; size=1', 'svc')}${closing}`],
    ['a nested multipart', `${part('Content-Disposition: form-data; name="a"\r\nContent-Type: multipart/mixed; boundary=c', '--c--')}${closing}`],
    ['a field setting the charset of the others', `${named('_charset_', 'utf-16')}${closing}`],
  ])('refuses %s', (_name, text, type = contentType) => {
    expect(readPlainMultipartParts(body(text), type)).toBeNull();
  });
});

describe('parseMultipartFormFields', () => {
  it('keeps the first of each text field and skips files and oversized fields', () => {
    const text = `${named('model', 'first')}${named('model', 'second')}${named('prompt', 'x'.repeat(4097))}${part('Content-Disposition: form-data; name="image"; filename="a.png"', 'PNG')}${closing}`;
    expect(parseMultipartFormFields(body(text), contentType)).toEqual({ model: 'first' });
  });

  it('still reads the fields of a body written another way', () => {
    expect(parseMultipartFormFields(body(`preamble\r\n${named('model', 'svc')}${closing}`), contentType)).toEqual({ model: 'svc' });
    expect(parseMultipartFormFields(body(`${named('model', 'svc')}${closing}`), `${contentType}; boundary=other`)).toEqual({ model: 'svc' });
  });
});
