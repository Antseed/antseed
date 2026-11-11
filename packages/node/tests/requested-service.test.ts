import { describe, expect, it } from 'vitest';
import { readRequestBodyService, requestBodyFields, requestBodyService } from '../src/requested-service.js';
import { relayMultipartBody } from './helpers/frozen-relay-multipart.js';

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

  describe('refuses ambiguous multipart billing fields', () => {
    const fields = ['n', 'size', 'quality', 'resolution', 'duration', 'aspect_ratio', 'audio',
      'generate_audio', 'reference_video', 'reference_video_urls', 'video_urls', 'prompt', 'input'];

    it.each(fields)('refuses repeated multipart billing field %s, even with equal values', (name) => {
      for (const next of ['second', 'first']) {
        expect(requestBodyService(multipart(model, field(name, 'first'), field(name, next)))).toBeNull();
      }
    });

    it.each(['n', 'size', 'quality', 'resolution'])('refuses unreadable or differently named billing field %s', (name) => {
      const requests = [
        multipart(model, field(name.toUpperCase(), 'first')),
        multipart(model, field(`${name}[]`, 'first')),
        multipart(model, field(` ${name} `, 'first')),
        multipart(model, field(name, 'x'.repeat(4097))),
        multipart(model, [`Content-Disposition: form-data; name="${name}"; filename="value.txt"`, 'first']),
        multipart(model, [`Content-Disposition: form-data; name="${name}"\r\nContent-Transfer-Encoding: base64`, 'Zmlyc3Q=']),
      ];
      for (const request of requests) expect(requestBodyService(request)).toBeNull();
    });

    // Billing reads these from JSON bodies only, so a form may carry them as a file or as long text.
    it.each(['audio', 'reference_video', 'input', 'prompt', 'duration', 'aspect_ratio', 'generate_audio', 'video_urls'])('reads a form with one file or one long text part named %s', (name) => {
      expect(requestBodyService(multipart(model, [`Content-Disposition: form-data; name="${name}"; filename="clip.bin"\r\nContent-Type: application/octet-stream`, 'RIFF']))).toBe('svc');
      expect(requestBodyService(multipart(model, field(name, 'x'.repeat(5000))))).toBe('svc');
    });

    it.each(['audio', 'reference_video', 'input'])('refuses a form with %s spelled another way or sent twice as a file', (name) => {
      const upload = (as: string): Part => [`Content-Disposition: form-data; name="${as}"; filename="clip.bin"`, 'RIFF'];
      expect(requestBodyService(multipart(model, upload(name.toUpperCase())))).toBeNull();
      expect(requestBodyService(multipart(model, upload(`${name}[]`)))).toBeNull();
      expect(requestBodyService(multipart(model, upload(name), upload(name)))).toBeNull();
    });

    it('allows repeated files and collection fields alongside single billing values', async () => {
      const request = await encoded((form) => {
        form.append('model', 'svc');
        form.append('quality', 'high');
        form.append('n', '2');
        form.append('size', '1024x1024');
        form.append('image', png(), 'first.png');
        form.append('image', png(), 'second.png');
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
      });
      expect(requestBodyService(request)).toBe('svc');
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

  describe('reads a body as JSON under any content type but multipart/form-data', () => {
    // The seller labels what it read as JSON for its provider, so the label a buyer sent decides nothing.
    it.each<[string, string]>([
      ['a form, as curl -d sends', 'application/x-www-form-urlencoded'],
      ['a form with a charset', 'application/x-www-form-urlencoded; charset=utf-8'],
      ['text', 'text/plain'],
      ['text with a charset, as a browser fetch sends', 'text/plain;charset=UTF-8'],
      ['another multipart', 'multipart/mixed; boundary=x'],
      ['JSON followed by another type', 'application/json, application/x-www-form-urlencoded'],
      ['JSON in UTF-7', 'application/json; charset=utf-7'],
      ['JSON in another charset', 'application/json; charset=cp037'],
      ['JSON with an unknown parameter', 'application/json; x=y'],
    ])('a JSON body labelled %s', (_name, contentType) => {
      expect(readRequestBodyService(json({ model: 'svc', prompt: '&model=other&' }, contentType))).toEqual({ service: 'svc', format: 'json' });
    });

    it.each<[string, string, string]>([
      ['a form', 'model=svc&prompt=x', 'application/x-www-form-urlencoded'],
      ['text', 'model: svc', 'text/plain'],
    ])('names no service for a body under such a label that is not JSON: %s', (_name, text, contentType) => {
      expect(readRequestBodyService(raw(text, { 'content-type': contentType }))).toMatchObject({ service: null, refusal: { code: 'model_required' } });
    });

    it('names no service for JSON written in UTF-16, which is not what the label it sets says', () => {
      const body = new Uint8Array([0xff, 0xfe, ...[...'{"model":"svc"}'].flatMap((character) => [character.charCodeAt(0), 0])]);
      expect(readRequestBodyService({ headers: { 'content-type': 'application/json; charset=utf-16' }, body })).toMatchObject({ service: null, refusal: { code: 'model_required' } });
    });

    it.each(['multipart/form-data; boundary=x', 'Multipart/Form-Data', ' multipart/form-data;boundary=x'])('reads a JSON body labelled %j as a form, and refuses it', (contentType) => {
      expect(readRequestBodyService(json({ model: 'svc' }, contentType))).toMatchObject({ service: null, refusal: { code: 'unsupported_multipart_body' } });
    });

    it('says a multipart body was read as a form', () => {
      expect(readRequestBodyService(multipart(model))).toEqual({ service: 'svc', format: 'multipart' });
    });
  });

  describe('names no service when any top-level JSON key is repeated', () => {
    it.each<[string, string]>([
      ['n', '{"model":"svc","n":1,"n":10}'],
      ['quality', '{"model":"svc","quality":"low","quality":"high"}'],
      ['a key with equal values', '{"model":"svc","size":"1024x1024","size":"1024x1024"}'],
      ['a key through an escape', '{"model":"svc","\\u006e":1,"n":10}'],
      ['a key no reader here prices by', '{"model":"svc","messages":[],"messages":[{"role":"user","content":"x"}]}'],
      ['a key after nested objects', '{"n":1,"tools":[{"n":{"n":2}}],"model":"svc","n":10}'],
      ['n in another letter case', '{"model":"svc","n":1,"N":10}'],
      ['quality in another letter case', '{"model":"svc","Quality":"high","quality":"low"}'],
      ['size written with a long s', '{"model":"svc","size":"256x256","\u017fize":"1024x1024"}'],
      ['model in another letter case, same value', '{"model":"svc","Model":"svc"}'],
      ['a key no reader here prices by, in another letter case', '{"model":"svc","user":"a","User":"b"}'],
    ])('%s', (_name, text) => {
      expect(readRequestBodyService(rawJson(text))).toMatchObject({ service: null, refusal: { code: 'repeated_field' } });
    });

    it.each<[string, string]>([
      ['the same key at another depth', '{"model":"svc","n":1,"tools":[{"n":2}],"metadata":{"n":3}}'],
      ['a repeated key inside a nested object', '{"model":"svc","metadata":{"a":1,"a":2}}'],
      ['text that looks like a repeated key', '{"model":"svc","n":1,"prompt":"\\"n\\":10,\\"n\\":11"}'],
      ['keys that differ by more than their letter case', '{"model":"svc","n":1,"n_":2,"size":"a","sizes":"b"}'],
    ])('reads %s', (_name, text) => {
      expect(requestBodyService(rawJson(text))).toBe('svc');
    });
  });

  describe('says why a body names no one service', () => {
    const file = (name: string): Part => [`Content-Disposition: form-data; name="${name}"; filename="value.txt"`, 'first'];
    it.each<[string, ReturnType<typeof raw>, string, string?]>([
      ['no service field', json({ messages: [] }), 'model_required'],
      ['an empty body', { headers: {}, body: new Uint8Array(0) }, 'model_required'],
      ['a JSON array', json([]), 'model_required'],
      ['a service that is not text', json({ service: 5 }), 'model_required'],
      ['an empty model', json({ model: '' }), 'model_required'],
      ['a form with no service field', multipart(field('prompt', 'x')), 'model_required'],
      ['JSON service and model that differ', json({ service: 'svc', model: 'other' }), 'ambiguous_service'],
      ['a JSON model only in another case', json({ MODEL: 'svc' }), 'ambiguous_service', '"MODEL"'],
      ['a JSON model in two cases', json({ model: 'svc', MODEL: 'svc' }), 'repeated_field', '"MODEL"'],
      ['a JSON service written with a long s', json({ model: 'svc', '\u017fervice': 'other' }), 'ambiguous_service'],
      ['a JSON modelId', json({ model: 'svc', modelId: 'svc' }), 'ambiguous_service', '"modelId"'],
      ['a padded JSON model', json({ model: ' svc' }), 'ambiguous_service'],
      ['an empty service beside a model', json({ service: '', model: 'svc' }), 'ambiguous_service'],
      ['multipart service and model that differ', multipart(field('service', 'svc'), field('model', 'other')), 'ambiguous_service'],
      ['a multipart model sent as a file', multipart(file('model')), 'ambiguous_service', '"model"'],
      ['a multipart modelId alone', multipart(field('modelId', 'svc')), 'ambiguous_service', '"modelId"'],
      ['a repeated JSON model', rawJson('{"model":"other","model":"svc"}'), 'repeated_field', '"model"'],
      ['a repeated JSON quality', rawJson('{"model":"svc","quality":"low","quality":"high"}'), 'repeated_field', '"quality"'],
      ['a repeated multipart model', multipart(model, model), 'repeated_field', '"model"'],
      ['a repeated multipart quality', multipart(model, field('quality', 'low'), field('quality', 'high')), 'repeated_field', '"quality"'],
      ['a repeated multipart prompt', multipart(model, field('prompt', 'x'), field('prompt', 'y')), 'repeated_field', '"prompt"'],
      ['a JSON model list', json({ model: 'svc', models: ['other'] }), 'unsupported_model_selector', '"models"'],
      ['a JSON route', json({ model: 'svc', route: 'fallback' }), 'unsupported_model_selector', '"route"'],
      ['a JSON model list written with a long s', json({ model: 'svc', 'model\u017f': ['other'] }), 'unsupported_model_selector'],
      ['a JSON fallback list written with a Kelvin sign', json({ model: 'svc', 'fallbac\u212as': ['other'] }), 'unsupported_model_selector'],
      ['a multipart fallback list', multipart(model, field('fallbacks', 'other')), 'unsupported_model_selector', '"fallbacks"'],
      ['a multipart fallback list sent as a file', multipart(model, file('fallbacks')), 'unsupported_model_selector', '"fallbacks"'],
      ['a multipart model list over the field limit', multipart(model, field('models', 'x'.repeat(4097))), 'unsupported_model_selector', '"models"'],
      ['an empty service and model', json({ service: '', model: '' }), 'model_required'],
      ['a service and model that are not text', json({ service: 5, model: 5 }), 'model_required'],
      ['a JSON size in another letter case', json({ model: 'svc', Size: '1792x1024' }), 'invalid_billing_field', '"Size"'],
      ['a JSON n in another letter case', json({ model: 'svc', N: 8 }), 'invalid_billing_field', '"N"'],
      ['a padded JSON size', json({ model: 'svc', ' size': '1792x1024' }), 'invalid_billing_field'],
      ['a JSON size in array form', json({ model: 'svc', 'size[]': '1792x1024' }), 'invalid_billing_field', '"size[]"'],
      ['a JSON duration in another letter case', json({ model: 'svc', Duration: 10 }), 'invalid_billing_field', '"Duration"'],
      ['a JSON resolution written with a long s', json({ model: 'svc', 're\u017folution': '4K' }), 'invalid_billing_field'],
      ['a multipart prompt in array form', multipart(model, field('prompt[]', 'x')), 'invalid_billing_field', '"prompt[]"'],
      ['a multipart part that billing would read under another name', multipart(model, ['Content-Disposition: form-data; filenamename="size"; name="user"', '1024x1024'], field('size', '1792x1024')), 'unsupported_multipart_body'],
      ['a multipart content type with two boundaries', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; boundary=other` }), 'unsupported_multipart_body'],
      ['a multipart quality in upper case', multipart(model, field('QUALITY', 'high')), 'invalid_billing_field', '"QUALITY"'],
      ['a multipart quality sent as a file', multipart(model, file('quality')), 'invalid_billing_field', '"quality"'],
      ['a multipart size over the field limit', multipart(model, field('size', 'x'.repeat(4097))), 'invalid_billing_field', '"size"'],
      ['a multipart n in array form', multipart(model, field('n[]', '2')), 'invalid_billing_field', '"n[]"'],
      ['a multipart preamble', raw(`This is a multipart message.\r\n${frame([model])}${closing}`), 'unsupported_multipart_body'],
      ['a multipart header quoting a disposition line', multipart(model, ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"', 'PNG']), 'unsupported_multipart_body'],
      ['two Content-Type headers', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'Content-Type': 'application/json' }), 'ambiguous_content_type'],
    ])('%s', (_name, request, code, named) => {
      const read = readRequestBodyService(request);
      expect(read).toMatchObject({ service: null, refusal: { code } });
      if (read.service === null && named) expect(read.refusal.message).toContain(named);
      expect(requestBodyService(request)).toBeNull();
    });
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
      ['a non-empty MIME preamble', raw(`This is a multipart message.\r\n${frame([model])}${closing}`)],
      ['another form in the preamble', raw(`--other\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n--other--\r\n${frame([model])}${closing}`)],
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

  it('never admits a multipart body that billing, another parser or a relay installed earlier would read differently', async () => {
    let seed = 20261111;
    const random = (limit: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    const file: Part = ['Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG'];
    const seeds = [
      frame([file, model, field('quality', 'high'), field('n', '2')]) + closing,
      frame([field('prompt', 'x'), file, model, field('size', '1024x1024')]) + closing,
      frame([field('service', 'svc'), file, field('resolution', '2K')]) + closing,
    ];
    const pieces = [
      'X-Note: content-disposition: form-data; name="model"\r\n', 'X-Note: Content-Disposition: form-data; name="quality"\r\n',
      'X-Note: CONTENT-DISPOSITION:\tFORM-DATA;NAME="n"\r\n', 'Content-Type: image/png; content-disposition: form-data; name="modelId"\r\n',
      '\r\nX-Note: content-disposition: form-data; name="model"', '; content-disposition: form-data; name="size"', 'content-disposition:', 'form-data; name="model"',
      '\r\nContent-Type: text/plain', '\r\nContent-Length: 4', '; filename=""', '; filename="b"', 'name="quality"', 'name="n"', 'name="image"', '\r\n', ' ', '"', ';',
      ' filenamename="size";', ' filenamename="model";', '; filename-x-name="quality"', ' x="name="; y="n";', 'file', 'x',
      `--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nlow\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n9\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="size"; filename=""\r\n\r\n512x512\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`,
    ];
    const read = async (body: Uint8Array) => {
      const form = await new Response(body, { headers: multipartHeaders }).formData().catch(() => null);
      if (!form) return null;
      return Promise.all([...form.entries()].map(async ([name, value]) => [name, typeof value === 'string' ? value : `file:${value.name}:${await value.text()}`]));
    };
    let accepted = 0;
    let compared = 0;
    for (let round = 0; round < 6000; round += 1) {
      let text = seeds[random(seeds.length)]!;
      for (let edit = random(3) + 1; edit > 0; edit -= 1) {
        // Most edits land at the start of a line, where a part's headers are.
        const lines = [...text.matchAll(/\r\n/g)].map((match) => match.index + 2);
        const at = random(3) === 0 ? random(text.length + 1) : lines[random(lines.length)]!;
        text = random(6) === 0
          ? text.slice(0, at) + text.slice(Math.min(text.length, at + 1 + random(6)))
          : text.slice(0, at) + pieces[random(pieces.length)]! + text.slice(at);
      }
      const request = raw(text);
      const service = requestBodyService(request);
      // Any other name is not a service this seller would serve.
      if (service !== 'svc') continue;
      accepted += 1;
      // A parser that refuses the body serves nothing, so only one that reads it can disagree.
      const before = await read(request.body);
      if (!before) continue;
      compared += 1;
      const context = JSON.stringify(text);
      // Billing reads each priced field as the one value every reader finds.
      const billed = requestBodyFields(request) ?? {};
      for (const name of ['n', 'size', 'quality', 'resolution']) {
        expect(before.filter(([field]) => field === name).map(([, value]) => value), context).toEqual(name in billed ? [billed[name]] : []);
      }
      // A relay installed before this change writes its upstream model into the model part, and nowhere else.
      const sent = relayMultipartBody({ headers: { ...request.headers, 'x-antseed-service': service }, body: request.body }, { svc: 'upstream' });
      const named = before.some(([name]) => name === 'model');
      const expected = named ? before.map(([name, value]) => (name === 'model' ? [name, 'upstream'] : [name, value])) : [...before, ['model', 'upstream']];
      expect(await read(sent), context).toEqual(expected);
    }
    expect(accepted).toBeGreaterThan(200);
    expect(compared).toBeGreaterThan(200);
  });

  it('reads JSON billing inputs spelled plainly, and other fields in any case', () => {
    expect(requestBodyService(json({
      model: 'svc', n: 2, size: '1024x1024', quality: 'high', resolution: '2K', duration: 5, aspect_ratio: '16:9',
      audio: { voice: 'a', format: 'wav' }, input: 'x', prompt: 'x', aspectRatio: '16:9', User: 'a', Temperature: 1, 'stop[]': 'x',
    }))).toBe('svc');
  });

  it('finds a repeated field among many in one pass', () => {
    const many = Array.from({ length: 40000 }, (_, index) => field(`model[${index}]`, 'svc'));
    const request = multipart(model, ...many, field('model[0]', 'svc'));
    const started = performance.now();
    expect(readRequestBodyService(request)).toMatchObject({ service: null, refusal: { code: 'repeated_field' } });
    // A search per field took several seconds here; one pass takes a fraction of one.
    expect(performance.now() - started).toBeLessThan(2000);
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
