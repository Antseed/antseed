import { describe, expect, it } from 'vitest';
import { requestBodyService } from '../src/requested-service.js';

const encoder = new TextEncoder();
const boundary = 'form-boundary';
const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${boundary}` };

const json = (fields: unknown, contentType = 'application/json') => ({
  headers: { 'content-type': contentType },
  body: encoder.encode(JSON.stringify(fields)),
});
const rawJson = (text: string) => ({ headers: { 'content-type': 'application/json' }, body: encoder.encode(text) });

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
      ['a null service', { service: null, model: 'svc' }],
      ['other fields with similar names', { model: 'svc', service_tier: 'default', model_name: 'x', modelish: 'y' }],
      ['fields of the same name in nested objects', { model: 'svc', tools: [{ model: 'x' }], metadata: { service: 'y', modelId: 'z' } }],
    ])('%s', (_name, body) => {
      expect(requestBodyService(json(body))).toBe('svc');
    });

    it.each<[string, string]>([
      ['a charset', 'application/json; charset=utf-8'],
      ['another case', 'Application/JSON'],
      ['a structured suffix', 'application/vnd.api+json'],
    ])('with a JSON content type: %s', (_name, contentType) => {
      expect(requestBodyService(json({ model: 'svc' }, contentType))).toBe('svc');
    });

    it('with no content type', () => {
      expect(requestBodyService({ headers: {}, body: encoder.encode('{"model":"svc"}') })).toBe('svc');
    });

    it.each<[string, string]>([
      ['white space around the tokens', ' { "model" : "svc" , "n" : 1 } '],
      ['escapes and text that looks like fields', '{"prompt":"he said \\"model\\": {\\"","model":"svc"}'],
      ['a value ending in a backslash', '{"prompt":"a\\\\","model":"svc"}'],
      ['non-ASCII text', '{"prompt":"caf\u00e9 \u{1f600}","model":"svc"}'],
      ['a key written with an escape', '{"\\u006dodel":"svc"}'],
    ])('with %s', (_name, text) => {
      expect(requestBodyService(rawJson(text))).toBe('svc');
    });
  });

  describe('refuses buyer-supplied upstream model selection', () => {
    const selectors = [
      'models', 'route', 'fallbacks', 'default_fallbacks', 'context_window_fallbacks',
      'content_policy_fallbacks', 'mock_testing_fallbacks', 'model_list', 'model_group', 'deployment_id',
    ];

    it.each(selectors)('refuses the JSON selector %s regardless of its value', (name) => {
      for (const value of [['other'], { model: 'other' }, 'fallback', false, null, []]) {
        expect(requestBodyService(json({ model: 'svc', [name]: value }))).toBeNull();
      }
    });

    it.each(selectors)('refuses the multipart selector %s', (name) => {
      expect(requestBodyService(multipart(model, field(name, 'other')))).toBeNull();
    });

    it.each(['MODELS', ' route ', 'fallbacks[]', 'models[0]', 'context_window_fallbacks[svc]'])('refuses a selector spelled %j', (name) => {
      expect(requestBodyService(json({ model: 'svc', [name]: ['other'] }))).toBeNull();
      expect(requestBodyService(multipart(model, field(name, 'other')))).toBeNull();
    });

    it('leaves nested application data and same-model provider preferences alone', () => {
      expect(requestBodyService(json({
        model: 'svc',
        metadata: { models: ['other'], route: 'note', fallbacks: ['other'] },
        tools: [{ type: 'function', function: { name: 'route', parameters: { models: ['other'] } } }],
        provider: { order: ['example'], allow_fallbacks: false },
      }))).toBe('svc');
    });
  });

  describe('reads the one service a multipart body names', () => {
    it.each<[string, ReturnType<typeof raw>]>([
      ['a model field', multipart(model, field('prompt', 'x'))],
      ['a service field', multipart(field('service', 'svc'))],
      ['service and model the same', multipart(field('service', 'svc'), model)],
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
      ['a Latin-1 text part with an 8bit encoding', multipart([
        'Content-Disposition: form-data; name="model"\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: 8bit',
        'svc',
      ])],
      ['another field in its own charset', multipart(model, ['Content-Disposition: form-data; name="prompt"\r\nContent-Type: text/plain; charset=utf-16', 'x'])],
      ['an unquoted name on another field', multipart(model, ['Content-Disposition: form-data; name=prompt', 'x'])],
      ['an empty part', multipart(model, field('prompt', ''))],
      ['a CRLF before the first delimiter', raw(`\r\n${frame([model])}${closing}`)],
      ['a MIME preamble', raw(`This is a multipart message.\r\n${frame([model])}${closing}`)],
      ['another disposition parameter on a file', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a.png"; size=3\r\nContent-Type: image/png', 'PNG'])],
      ['an escaped quote in a filename', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a\\"b.png"', 'png'])],
      ['no CRLF after the closing delimiter', raw(`${frame([model])}--${boundary}--`)],
      ['a blank line after the closing delimiter', raw(`${frame([model])}${closing}\r\n`)],
      ['a quoted boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary="${boundary}"` })],
      ['a charset before the boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; charset=utf-8; boundary=${boundary}` })],
      ['a capitalized header', raw(`${frame([model])}${closing}`, { 'Content-Type': `multipart/form-data; boundary=${boundary}` })],
      ['no space before the boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data;boundary=${boundary}` })],
      ['a charset after the boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; charset=UTF-8` })],
      ['an extended filename', multipart(model, ["Content-Disposition: form-data; name=\"image\"; filename*=UTF-8''%E2%82%AC.png", 'png'])],
      ['both filename forms', multipart(model, ["Content-Disposition: form-data; name=\"image\"; filename=\"a.png\"; filename*=UTF-8''a.png", 'png'])],
      ['a backslash in a filename', multipart(model, ['Content-Disposition: form-data; name="image"; filename="dir\\file.png"', 'png'])],
      ['a field name containing a service field', multipart(model, field('model_version', '2'), field('service_tier', 'default'))],
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

    it.each(['dir\\file.png', 'quote"file.png', 'semi;colon.png', 'caf\u00e9.png', 'line\nbreak.png', 'name="model".png'])('reads a FormData with a file named %j', async (filename) => {
      const request = await encoded((form) => {
        form.append('model', 'svc');
        form.append('image', png(), filename);
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
      ['a padded model', { model: ' svc ' }],
      ['a padded service', { service: 'svc ' }],
      ['a padded model next to a service', { service: 'svc', model: ' svc' }],
      ['a null model next to a service', { service: 'svc', model: null }],
      ['model as an array name', { model: 'svc', 'model[]': 'other' }],
    ])('%s', (_name, body) => {
      expect(requestBodyService(json(body))).toBeNull();
    });
  });

  it.each<[string, string]>([
    ['repeated', '{"model":"other","model":"svc"}'],
    ['repeated with the same value', '{"model":"svc","model":"svc"}'],
    ['repeated through an escape', '{"\\u006dodel":"other","model":"svc"}'],
    ['repeated after nested objects', '{"model":"other","tools":[{"a":{"b":"c"}}],"model":"svc"}'],
  ])('names no service when a JSON model key is %s', (_name, text) => {
    expect(requestBodyService(rawJson(text))).toBeNull();
  });

  it.each<[string, string]>([
    ['a form', 'application/x-www-form-urlencoded'],
    ['a form with a charset', 'application/x-www-form-urlencoded; charset=utf-8'],
    ['text', 'text/plain'],
    ['another multipart', 'multipart/mixed; boundary=x'],
    ['JSON followed by another type', 'application/json, application/x-www-form-urlencoded'],
    ['JSON in UTF-7', 'application/json; charset=utf-7'],
    ['JSON in another charset', 'application/json; charset=cp037'],
    ['JSON with an unknown parameter', 'application/json; x=y'],
  ])('names no service when a JSON body is labelled %s', (_name, contentType) => {
    expect(requestBodyService(json({ model: 'svc', prompt: '&model=other&' }, contentType))).toBeNull();
  });

  describe('names no service when a multipart body could read as another', () => {
    it.each<[string, ReturnType<typeof raw>]>([
      ['service and model differ', multipart(field('service', 'svc'), field('model', 'other'))],
      ['a padded model', multipart(field('model', '  svc  '))],
      ['a BOM before the model', multipart(field('model', '\uFEFFsvc'))],
      ['a BOM before the service beside a model', multipart(field('service', 'svc'), field('model', '\uFEFFsvc'))],
      ['service and Venice modelId', multipart(field('service', 'svc'), field('modelId', 'svc'))],
      ['a service part whose length is wrong', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Length: 2', 'svc'])],
      ['a non-ASCII byte in a field name', multipart(model, field('model\u00A0', 'other'))],
      ['a body charset that is not ASCII-compatible', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; charset=utf-7; boundary=${boundary}` })],
      ['an EBCDIC body charset', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; charset=cp037` })],
      ['an escaped quote hiding a parameter', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a\\"; size=1; b="', 'png'])],
      ['a filename ending in an escape before a second name', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a\\"; name="model"', 'other'])],
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
      ['a bare LF in a service part', multipart(model, ['Content-Disposition: form-data; name="service"\n\nother', 'svc'])],
      ['a part named like a field but sent as a file', multipart(model, ['Content-Disposition: form-data; name="service"; filename=""', 'other'])],
      ['a service part with an extended filename', multipart(['Content-Disposition: form-data; name="model"; filename*=UTF-8\'\'a', 'svc'])],
      ['a first delimiter inside a line', raw(`x${frame([model])}${closing}`)],
      ['a bare LF after the first delimiter', raw(`--${boundary}\n${frame([model])}${closing}`)],
      ['more after the closing delimiter', raw(`${frame([model])}--${boundary}--\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`)],
      ['a closing delimiter with parts behind it', raw(`${frame([model])}--${boundary}--x\r\n${frame([field('model', 'other')])}${closing}`)],
      ['a delimiter with text after it', raw(`--${boundary}x\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`)],
      ['no closing delimiter', raw(frame([model, field('prompt', 'x')]))],
      ['two boundary parameters', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; boundary=other` })],
      ['an escaped boundary', raw(`--a\\\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n--a\\--\r\n`, { 'content-type': 'multipart/form-data; boundary="a\\"b"' })],
      ['a boundary with a leading space', raw(`--abc\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n--abc--\r\n`, { 'content-type': 'multipart/form-data; boundary=" abc"' })],
      ['another parameter ending in boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; xboundary=${boundary}; boundary*=us-ascii''other` })],
      ['a space before the boundary sign', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; xboundary=${boundary}; boundary =other` })],
      ['an unknown content type parameter', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; x=y` })],
      ['a name in continuations', multipart(['Content-Disposition: form-data; name*0="mod"; name*1="el"', 'other'], model)],
      ['a name with a trailing space', multipart(model, field('model ', 'other'))],
      ['a name in array form', multipart(model, field('model[]', 'other'))],
      ['a name with a control character', multipart(model, field('model\u0000x', 'other'))],
      ['a parameter ending in name', multipart(model, ['Content-Disposition: form-data; xname="model"; name="prompt"', 'other'])],
      ['a part with no disposition', multipart(model, ['Content-Type: text/plain', 'other'])],
      ['a service part in an unknown charset', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Type: text/plain; charset=x', 'svc'])],
      ['a service part in another charset', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Type: text/plain; charset=utf-16', 'svc'])],
      ['a service part that is not text', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Type: application/json', 'svc'])],
      ['a service part in base64', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Transfer-Encoding: base64', 'svc'])],
      ['a service part with an unknown header', multipart(['Content-Disposition: form-data; name="model"\r\nX-Other: 1', 'svc'])],
      ['a field setting the charset of the others', multipart(model, field('_charset_', 'utf-16'))],
      ['a nested multipart part', multipart(model, ['Content-Disposition: form-data; name="files"\r\nContent-Type: multipart/mixed; boundary=inner', '--inner--'])],
      ['the delimiter inside a part', multipart(model, field('prompt', `x\n--${boundary}\nContent-Disposition: form-data; name="model"\n\nother\n--${boundary}\ny`))],
      ['two Content-Type headers', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'Content-Type': 'multipart/form-data; boundary=other' })],
    ])('%s', (_name, request) => {
      expect(requestBodyService(request)).toBeNull();
    });
  });

  it('never reads a service another multipart parser would read differently', async () => {
    let seed = 20261110;
    const random = (limit: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    const pieces = [
      '\r\n', '\n', '\r', ' ', '"', ';', '\\', '%', `--${boundary}`, `--${boundary}--`, 'name="model"', 'NAME="model"', 'name=model', 'name*=x', 'name*0="model"',
      'filename=""', 'Content-Disposition: form-data; name="model"', 'Content-Disposition: form-data; name="service"', 'other', 'model', 'service', '\uFEFF', '\u00A0',
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`,
    ];
    const seeds = [frame([model, field('prompt', 'x')]) + closing, frame([field('service', 'svc'), model]) + closing];
    const contentTypes = [
      `multipart/form-data; boundary=${boundary}`, `multipart/form-data; boundary="${boundary}"`, `multipart/form-data; charset=utf-8; boundary=${boundary}`,
      `multipart/form-data; charset=utf-7; boundary=${boundary}`, `multipart/form-data; boundary=" ${boundary}"`, `multipart/form-data; xboundary=${boundary}; boundary=other`,
    ];
    let accepted = 0;
    let read = 0;
    for (let round = 0; round < 4000; round += 1) {
      let text = seeds[random(seeds.length)]!;
      for (let edit = random(3) + 1; edit > 0; edit -= 1) {
        const at = random(text.length + 1);
        text = random(4) === 0
          ? text.slice(0, at) + text.slice(Math.min(text.length, at + 1 + random(6)))
          : text.slice(0, at) + pieces[random(pieces.length)]! + text.slice(at);
      }
      const request = raw(text, { 'content-type': contentTypes[random(contentTypes.length)]! });
      const service = requestBodyService(request);
      if (service === null) continue;
      accepted += 1;
      // A parser that refuses the body serves nothing, so only one that reads it can disagree.
      const form = await new Response(request.body, { headers: request.headers }).formData().catch(() => null);
      if (!form) continue;
      read += 1;
      for (const name of ['service', 'model', 'modelId']) {
        for (const value of form.getAll(name)) expect(value).toBe(service);
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(2500);
    expect(read).toBeGreaterThan(50);
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
