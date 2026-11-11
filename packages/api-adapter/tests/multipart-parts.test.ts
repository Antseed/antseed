import { describe, expect, it } from 'vitest';
import { multipartTextFieldName, parseMultipartFormFields, readMultipartParts } from '../src/utils.js';

const boundary = 'b0undary';
const contentType = `multipart/form-data; boundary=${boundary}`;
const part = (headers: string, content: string) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`;
const closing = `--${boundary}--\r\n`;
const body = (text: string) => new TextEncoder().encode(text);
const named = (name: string, content: string) => part(`Content-Disposition: form-data; name="${name}"`, content);

describe('readMultipartParts', () => {
  it('splits a body into its parts without copying their content', () => {
    const bytes = body(`${named('model', 'svc')}${part('Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG')}${closing}`);
    const read = readMultipartParts(bytes, contentType)!;
    expect(read.unambiguous).toBe(true);
    expect(read.parts.map((entry) => new TextDecoder().decode(entry.content))).toEqual(['svc', 'PNG']);
    expect(read.parts[0]!.content.buffer).toBe(bytes.buffer);
    expect(read.parts[1]!.headers).toContain('filename="a.png"');
  });

  it('returns null without a multipart content type or boundary', () => {
    expect(readMultipartParts(body('x'), undefined)).toBeNull();
    expect(readMultipartParts(body('x'), 'application/json')).toBeNull();
    expect(readMultipartParts(body('x'), 'multipart/form-data')).toBeNull();
  });

  it.each<[string, string, string?]>([
    ['a closing delimiter alone', `${named('model', 'svc')}${closing}`],
    ['no line end after the closing delimiter', `${named('model', 'svc')}--${boundary}--`],
    ['a blank line after the closing delimiter', `${named('model', 'svc')}${closing}\r\n`],
    ['a CRLF before the first delimiter', `\r\n${named('model', 'svc')}${closing}`],
    ['a charset parameter', `${named('model', 'svc')}${closing}`, `multipart/form-data; charset=utf-8; boundary=${boundary}`],
  ])('calls %s unambiguous', (_name, text, type = contentType) => {
    expect(readMultipartParts(body(text), type)!.unambiguous).toBe(true);
  });

  it.each<[string, string, string?]>([
    ['text before the first delimiter', `preamble\r\n${named('model', 'svc')}${closing}`],
    ['a first delimiter inside a line', `x${named('model', 'svc')}${closing}`],
    ['a bare LF after a delimiter', `--${boundary}\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`],
    ['text after a delimiter', `--${boundary}x\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`],
    ['more after the closing delimiter', `${named('model', 'svc')}${closing}${named('model', 'other')}`],
    ['no closing delimiter', `${named('model', 'svc')}`],
    ['two boundary parameters', `${named('model', 'svc')}${closing}`, `${contentType}; boundary=other`],
    ['another parameter ending in boundary', `${named('model', 'svc')}${closing}`, `multipart/form-data; xboundary=${boundary}; boundary=other`],
  ])('calls %s ambiguous', (_name, text, type = contentType) => {
    expect(readMultipartParts(body(text), type)?.unambiguous).toBe(false);
  });
});

describe('multipartTextFieldName', () => {
  const nameOf = (headers: string, content = 'x') => multipartTextFieldName({ headers: `\r\n${headers}`, content: body(content) });

  it('reads the name of a text part', () => {
    expect(nameOf('Content-Disposition: form-data; name="model"')).toBe('model');
    expect(nameOf('content-disposition: form-data; name="model"')).toBe('model');
    expect(nameOf('Content-Type: text/plain\r\nContent-Disposition: form-data; name="model"')).toBe('model');
  });

  it('reads no name for a file, an unnamed part or an oversized field', () => {
    expect(nameOf('Content-Disposition: form-data; name="image"; filename="a.png"')).toBeUndefined();
    expect(nameOf('Content-Type: text/plain')).toBeUndefined();
    expect(nameOf('Content-Disposition: form-data; other="x"')).toBeUndefined();
    expect(nameOf('Content-Disposition: form-data; name="prompt"', 'x'.repeat(4097))).toBeUndefined();
  });
});

describe('parseMultipartFormFields', () => {
  it('keeps the first of each text field and skips files and oversized fields', () => {
    const text = `${named('model', 'first')}${named('model', 'second')}${named('prompt', 'x'.repeat(4097))}${part('Content-Disposition: form-data; name="image"; filename="a.png"', 'PNG')}${closing}`;
    expect(parseMultipartFormFields(body(text), contentType)).toEqual({ model: 'first' });
  });

  it('still reads the fields of a body it would call ambiguous', () => {
    expect(parseMultipartFormFields(body(`preamble\r\n${named('model', 'svc')}${closing}`), contentType)).toEqual({ model: 'svc' });
  });
});
