import { describe, expect, it } from 'vitest';
import { requestBodyService } from '../src/requested-service.js';

const encoder = new TextEncoder();
const boundary = 'form-boundary';
const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${boundary}` };

const json = (fields: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: encoder.encode(JSON.stringify(fields)),
});

type Part = [headers: string, content: string];
const field = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
const frame = (parts: Part[]) => parts.map(([headers, content]) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`).join('');
const raw = (text: string, headers: Record<string, string> = multipartHeaders) => ({ headers, body: encoder.encode(text) });
const multipart = (...parts: Part[]) => raw(`${frame(parts)}--${boundary}--\r\n`);

async function encoded(fill: (form: FormData) => void) {
  const form = new FormData();
  fill(form);
  const response = new Response(form);
  return { headers: { 'content-type': response.headers.get('content-type')! }, body: new Uint8Array(await response.arrayBuffer()) };
}

const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
const closing = `--${boundary}--\r\n`;
const model = field('model', 'svc');

describe('requestBodyService', () => {
  describe('reads the one service a JSON body names', () => {
    it.each<[string, unknown]>([
      ['only model', { model: 'svc', messages: [] }],
      ['only service', { service: 'svc', messages: [] }],
      ['service and model the same', { service: 'svc', model: 'svc' }],
      ['padded names', { service: ' svc ', model: 'svc  ' }],
      ['a null service', { service: null, model: 'svc' }],
      ['other fields with similar names', { model: 'svc', service_tier: 'default', model_name: 'x', modelish: 'y' }],
    ])('%s', (_name, body) => {
      expect(requestBodyService(json(body))).toBe('svc');
    });
  });

  describe('reads the one service a multipart body names', () => {
    it.each<[string, ReturnType<typeof raw>]>([
      ['a model field', multipart(model, field('prompt', 'x'))],
      ['a service field', multipart(field('service', 'svc'))],
      ['service and model the same', multipart(field('service', 'svc'), model)],
      ['service and Venice modelId', multipart(field('service', 'svc'), field('modelId', 'svc'))],
      ['a padded value', multipart(field('model', '  svc  '))],
      ['a prompt over the 4 KiB field limit', multipart(model, field('prompt', 'x'.repeat(5000)))],
      ['a prompt quoting a part header', multipart(model, field('prompt', 'Content-Disposition: form-data; name="model"'))],
      ['a repeated text field', multipart(model, field('timestamp_granularities[]', 'word'), field('timestamp_granularities[]', 'segment'))],
      ['files whose names mention the fields', multipart(
        model,
        ['Content-Disposition: form-data; name="image"; filename="model.png"\r\nContent-Type: image/png', 'png'],
        ['Content-Disposition: form-data; name="image[]"; filename="service"\r\nContent-Type: image/png', 'png'],
      )],
      ['the filename before the name', multipart(model, ['Content-Disposition: form-data; filename="a.png"; name="image"', 'png'])],
      ['lower-case part headers', multipart(['content-disposition: form-data; name="model"', 'svc'])],
      ['part headers around the disposition', multipart([
        'Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: form-data; name="model"\r\nContent-Length: 3',
        'svc',
      ])],
      ['an unquoted name on another field', multipart(model, ['Content-Disposition: form-data; name=prompt', 'x'])],
      ['an empty part', multipart(model, field('prompt', ''))],
      ['a CRLF before the first delimiter', raw(`\r\n${frame([model])}${closing}`)],
      ['no CRLF after the closing delimiter', raw(`${frame([model])}--${boundary}--`)],
      ['a blank line after the closing delimiter', raw(`${frame([model])}${closing}\r\n`)],
      ['a quoted boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary="${boundary}"` })],
      ['a charset before the boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; charset=utf-8; boundary=${boundary}` })],
      ['a capitalized header', raw(`${frame([model])}${closing}`, { 'Content-Type': `multipart/form-data; boundary=${boundary}` })],
    ])('%s', (_name, request) => {
      expect(requestBodyService(request)).toBe('svc');
    });

    it('reads a browser or Node FormData', async () => {
      const request = await encoded((form) => {
        form.append('model', 'svc');
        form.append('prompt', 'x');
        form.append('image', png(), 'model.png');
        form.append('image[]', png(), 'service.png');
      });
      expect(requestBodyService(request)).toBe('svc');
    });

    // These bytes were captured from each client against a local server, boundaries aside.
    it.each<[string, string, string]>([
      ['curl', '------------------------abc123', 'Content-Type: image/png'],
      ['Go mime/multipart', '3eab641fc4fd2cf6', 'Content-Type: image/png'],
      ['Ruby Net::HTTP', 'Hvvabuite1rfQuUI-TF4', 'Content-Type: image/png'],
      ['undici and the OpenAI SDK', '----formdata-undici-067440839376', 'Content-Type: image/png'],
    ])('reads a body written by %s', (_client, clientBoundary, fileType) => {
      const delimiter = `--${clientBoundary}`;
      const body = `${delimiter}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n`
        + `${delimiter}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it blue\r\n`
        + `${delimiter}\r\nContent-Disposition: form-data; name="image"; filename="model.png"\r\n${fileType}\r\n\r\nPNG\r\n`
        + `${delimiter}--\r\n`;
      expect(requestBodyService(raw(body, { 'content-type': `multipart/form-data; boundary=${clientBoundary}` }))).toBe('svc');
    });
  });

  describe('names no service when a JSON body could read as another', () => {
    it.each<[string, unknown]>([
      ['service and model differ', { service: 'svc', model: 'other' }],
      ['model is not text', { service: 'svc', model: 123 }],
      ['model in upper case', { model: 'svc', MODEL: 'other' }],
      ['service in mixed case', { model: 'svc', Service: 'other' }],
      ['model in upper case, same value', { model: 'svc', MODEL: 'svc' }],
      ['modelId differs', { model: 'svc', modelId: 'other' }],
      ['modelId next to model', { model: 'svc', modelId: 'svc' }],
      ['modelId next to service', { service: 'svc', modelId: 'svc' }],
    ])('%s', (_name, body) => {
      expect(requestBodyService(json(body))).toBeNull();
    });
  });

  describe('names no service when a multipart body could read as another', () => {
    it.each<[string, ReturnType<typeof raw>]>([
      ['service and model differ', multipart(field('service', 'svc'), field('model', 'other'))],
      ['a service field over the 4 KiB limit', multipart(model, field('service', `${' '.repeat(5000)}other`))],
      ['a model field over the 4 KiB limit', multipart(model, field('model', `${' '.repeat(5000)}other`))],
      ['an upper-case name parameter on service', multipart(model, ['Content-Disposition: form-data; NAME="service"', 'other'])],
      ['an upper-case name parameter on model', multipart(model, ['Content-Disposition: form-data; NAME="model"', 'other'])],
      ['a field name in upper case', multipart(model, field('MODEL', 'other'))],
      ['a repeated model', multipart(model, field('model', 'other'))],
      ['a repeated model, same value', multipart(model, model)],
      ['modelId differs', multipart(field('service', 'svc'), field('modelId', 'other'))],
      ['modelId next to model', multipart(model, field('modelId', 'svc'))],
      ['an unquoted name', multipart(model, ['Content-Disposition: form-data; name=model', 'other'])],
      ['an extended name parameter', multipart(model, ["Content-Disposition: form-data; name*=UTF-8''model", 'other'])],
      ['a percent-encoded name', multipart(model, ['Content-Disposition: form-data; name="m%6Fdel"', 'other'])],
      ['an escaped name', multipart(model, ['Content-Disposition: form-data; name="mo\\del"', 'other'])],
      ['an encoded-word name', multipart(model, ['Content-Disposition: form-data; name="=?utf-8?q?model?="', 'other'])],
      ['two name parameters', multipart(model, ['Content-Disposition: form-data; name="prompt"; name="model"', 'other'])],
      ['a second disposition header', multipart(model, ['Content-Disposition: form-data; name="prompt"\r\nContent-Disposition: form-data; name="model"', 'other'])],
      ['a folded disposition header', multipart(model, ['Content-Disposition: form-data;\r\n name="model"', 'other'])],
      ['a part named like a field but sent as a file', multipart(model, ['Content-Disposition: form-data; name="service"; filename=""', 'other'])],
      ['text before the first delimiter', raw(`preamble\r\n${frame([model])}${closing}`)],
      ['a first delimiter inside a line', raw(`x${frame([model])}${closing}`)],
      ['a bare LF after the first delimiter', raw(`--${boundary}\n${frame([model])}${closing}`)],
      ['more after the closing delimiter', raw(`${frame([model])}--${boundary}--\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`)],
      ['a closing delimiter with parts behind it', raw(`${frame([model])}--${boundary}--x\r\n${frame([field('model', 'other')])}${closing}`)],
      ['a delimiter with text after it', raw(`--${boundary}x\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`)],
      ['no closing delimiter', raw(frame([model, field('prompt', 'x')]))],
      ['two boundary parameters', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; boundary=other` })],
      ['an escaped boundary', raw(`--a\\\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n--a\\--\r\n`, { 'content-type': 'multipart/form-data; boundary="a\\"b"' })],
      ['two Content-Type headers', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'Content-Type': 'multipart/form-data; boundary=other' })],
    ])('%s', (_name, request) => {
      expect(requestBodyService(request)).toBeNull();
    });
  });

  it('names no service for a body with no usable name', () => {
    expect(requestBodyService(json({ messages: [] }))).toBeNull();
    expect(requestBodyService(json({ service: '', model: 'svc' }))).toBeNull();
    expect(requestBodyService(json({ service: 5 }))).toBeNull();
    expect(requestBodyService(json([]))).toBeNull();
    expect(requestBodyService(multipart(field('modelId', 'svc')))).toBeNull();
    expect(requestBodyService({ headers: {}, body: new Uint8Array(0) })).toBeNull();
  });
});
