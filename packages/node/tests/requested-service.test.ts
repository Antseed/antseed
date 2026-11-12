import { describe, expect, it } from 'vitest';
import { billedRequestBody, requestBodyFields, requestBodyService } from '../src/requested-service.js';

const encoder = new TextEncoder();
const boundary = 'form-boundary';
const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${boundary}` };

type Request = { headers: Record<string, string>; body: Uint8Array };

const json = (fields: unknown, contentType = 'application/json'): Request => ({
  headers: { 'content-type': contentType },
  body: encoder.encode(JSON.stringify(fields)),
});
const rawJson = (text: string): Request => ({ headers: { 'content-type': 'application/json' }, body: encoder.encode(text) });

type Part = [headers: string, content: string];
const field = (name: string, value: string): Part => [`Content-Disposition: form-data; name="${name}"`, value];
const frame = (parts: Part[]) => parts.map(([headers, content]) => `--${boundary}\r\n${headers}\r\n\r\n${content}\r\n`).join('');
const raw = (text: string, headers: Record<string, string> = multipartHeaders): Request => ({ headers, body: encoder.encode(text) });
const multipart = (...parts: Part[]) => raw(`${frame(parts)}--${boundary}--\r\n`);
const closing = `--${boundary}--\r\n`;
const model = field('model', 'svc');
const file = (name: string): Part => [`Content-Disposition: form-data; name="${name}"; filename="value.txt"`, 'first'];

async function encoded(fill: (form: FormData) => void): Promise<Request> {
  const form = new FormData();
  fill(form);
  const response = new Response(form);
  return { headers: { 'content-type': response.headers.get('content-type')! }, body: new Uint8Array(await response.arrayBuffer()) };
}
const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

/** The body the seller hands its provider, which must exist: the request is served. */
function written(request: Request) {
  const billed = billedRequestBody(request);
  if (billed.service === null) throw new Error(`refused: ${billed.refusal.code} ${billed.refusal.message}`);
  return { service: billed.service, request: { headers: { 'content-type': billed.contentType }, body: billed.body } };
}

/** The entries of a form as the platform's own FormData parser reads them, files as `file:<name>:<text>`. */
async function formEntries(request: Request): Promise<Array<[string, string]>> {
  const form = await new Response(request.body, { headers: request.headers }).formData();
  return Promise.all([...form.entries()].map(async ([name, value]): Promise<[string, string]> => [name, typeof value === 'string' ? value : `file:${value.name}:${await value.text()}`]));
}

const PRICED = ['n', 'size', 'quality', 'resolution'];

/** Serves `request` and checks the form the seller wrote: the platform parser finds exactly the service and priced values billing read. */
async function expectFormReadAlike(request: Request, context = '') {
  const { service, request: sent } = written(request);
  const entries = await formEntries(sent);
  const billed = requestBodyFields(sent) ?? {};
  expect(requestBodyService(sent), context).toBe(service);
  for (const name of ['service', 'model']) {
    expect(entries.filter(([key]) => key === name).every(([, value]) => value === service), context).toBe(true);
  }
  expect(entries.some(([key]) => /^model(?:id)?$/i.test(key) && key !== 'model'), context).toBe(false);
  for (const name of PRICED) {
    expect(entries.filter(([key]) => key === name).map(([, value]) => value), context).toEqual(name in billed ? [billed[name]] : []);
  }
  return entries;
}

describe('billedRequestBody', () => {
  describe('serves the one service a JSON body names, and hands on the JSON it read', () => {
    it.each<[string, string]>([
      ['only model', '{"model":"svc","messages":[]}'],
      ['only service', '{"service":"svc","messages":[]}'],
      ['service and model the same', '{"service":"svc","model":"svc"}'],
      ['a null service', '{"service":null,"model":"svc"}'],
      ['other fields with similar names', '{"model":"svc","service_tier":"default","model_name":"x","modelish":"y"}'],
      ['fields of the same name in nested objects', '{"model":"svc","tools":[{"model":"x"}],"metadata":{"service":"y","modelId":"z","models":["o"]}}'],
      ['provider preferences that keep the model', '{"model":"svc","provider":{"order":["example"],"allow_fallbacks":false}}'],
      ['white space around the tokens', ' { "model" : "svc" , "n" : 1 } '],
      ['escapes and text that looks like fields', '{"prompt":"he said \\"model\\": {\\"","model":"svc"}'],
      ['non-ASCII text', '{"prompt":"caf\u00E9 \u{1f600}","model":"svc"}'],
      ['a key written with an escape', '{"\\u006dodel":"svc"}'],
      ['billing inputs spelled plainly and other fields in any case', '{"model":"svc","n":2,"size":"1024x1024","quality":"high","resolution":"2K","duration":5,"aspect_ratio":"16:9","audio":{"voice":"a"},"input":"x","prompt":"x","aspectRatio":"16:9","User":"a","Temperature":1,"stop[]":"x"}'],
      ['other keys that differ only by letter case', '{"model":"svc","user":"a","User":"b"}'],
      ['fields an upstream may act on, which its plugin refuses or removes', '{"model":"svc","models":["x"],"route":"fallback","fallbacks":["x"],"deployment_id":"x"}'],
    ])('%s', (_name, text) => {
      const { service, request } = written(rawJson(text));
      expect(service).toBe('svc');
      expect(request.headers['content-type']).toBe('application/json');
      expect(new TextDecoder().decode(request.body)).toBe(JSON.stringify(JSON.parse(text)));
    });

    // The seller labels what it wrote as JSON, so the label a buyer sent decides nothing.
    it.each([
      'application/json; charset=utf-8', 'Application/JSON', 'application/vnd.api+json', 'application/x-www-form-urlencoded',
      'text/plain;charset=UTF-8', 'multipart/mixed; boundary=x', 'application/json, application/x-www-form-urlencoded', 'application/json; charset=utf-7',
    ])('reads JSON labelled %j as JSON and labels it so', (contentType) => {
      const { request } = written(json({ model: 'svc', prompt: '&model=other&' }, contentType));
      expect(request.headers['content-type']).toBe('application/json');
    });

    it('reads JSON with no content type, or with two', () => {
      expect(requestBodyService({ headers: {}, body: encoder.encode('{"model":"svc"}') })).toBe('svc');
      expect(requestBodyService({ headers: { 'content-type': 'application/json', 'Content-Type': 'multipart/form-data; boundary=x' }, body: encoder.encode('{"model":"svc"}') })).toBe('svc');
    });

    it.each<[string, string, string]>([
      ['a repeated model', '{"model":"other","model":"svc"}', 'svc'],
      ['a model repeated through an escape', '{"\\u006dodel":"other","model":"svc"}', 'svc'],
      ['a model repeated after nested objects', '{"model":"other","tools":[{"a":{"b":"c"}}],"model":"svc"}', 'svc'],
    ])('hands on one value for %s: the one billed', (_name, text, service) => {
      const sent = written(rawJson(text));
      expect(sent.service).toBe(service);
      expect(new TextDecoder().decode(sent.request.body)).not.toContain('other');
    });

    it('hands on one value for a repeated priced field: the one billed', () => {
      const sent = written(rawJson('{"model":"svc","n":1,"quality":"low","n":4,"quality":"high"}'));
      expect(JSON.parse(new TextDecoder().decode(sent.request.body))).toEqual({ model: 'svc', n: 4, quality: 'high' });
      expect(requestBodyFields(sent.request)).toMatchObject({ n: 4, quality: 'high' });
    });
  });

  describe('serves the one service a form names, and hands on a form every reader reads alike', () => {
    it.each<[string, Request]>([
      ['a model field', multipart(model, field('prompt', 'x'))],
      ['a service field', multipart(field('service', 'svc'))],
      ['service and model the same', multipart(field('service', 'svc'), model)],
      ['priced fields', multipart(model, field('n', '2'), field('size', '1024x1024'), field('quality', 'high'), field('resolution', '2K'))],
      ['a prompt over the 4 KiB field limit', multipart(model, field('prompt', 'x'.repeat(5000)))],
      ['a prompt quoting a part header', multipart(model, field('prompt', 'Content-Disposition: form-data; name="model"'))],
      ['a repeated collection field', multipart(model, field('timestamp_granularities[]', 'word'), field('timestamp_granularities[]', 'segment'))],
      ['files whose names mention the fields', multipart(model, ['Content-Disposition: form-data; name="image"; filename="model.png"\r\nContent-Type: image/png', 'png'], ['Content-Disposition: form-data; name="image[]"; filename="service"\r\nContent-Type: image/png', 'png'])],
      ['the filename before the name', multipart(model, ['Content-Disposition: form-data; filename="a.png"; name="image"', 'png'])],
      ['lower-case part headers', multipart(['content-disposition: form-data; name="model"', 'svc'])],
      ['part headers around the disposition', multipart(['Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: form-data; name="model"\r\nContent-Length: 3', 'svc'])],
      ['a text part in another charset', multipart(model, ['Content-Disposition: form-data; name="prompt"\r\nContent-Type: text/plain; charset=utf-16', 'x'])],
      ['an unquoted name', multipart(model, ['Content-Disposition: form-data; name=prompt', 'x'])],
      ['an empty part', multipart(model, field('prompt', ''))],
      ['a field name containing a service field', multipart(model, field('model_version', '2'), field('service_tier', 'default'))],
      ['a file or long text named after a JSON-only billing input', multipart(model, ['Content-Disposition: form-data; name="audio"; filename="clip.bin"\r\nContent-Type: application/octet-stream', 'RIFF'], field('input', 'x'.repeat(5000)))],
      ['a CRLF before the first delimiter', raw(`\r\n${frame([model])}${closing}`)],
      ['a preamble', raw(`This is a multipart message.\r\n${frame([model])}${closing}`)],
      ['another form in the preamble', raw(`--other\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n--other--\r\n${frame([model])}${closing}`)],
      ['more after the closing delimiter', raw(`${frame([model])}--${boundary}--\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`)],
      ['no CRLF after the closing delimiter', raw(`${frame([model])}--${boundary}--`)],
      ['the delimiter inside a part on bare line feeds', multipart(model, field('prompt', `x\n--${boundary}\nContent-Disposition: form-data; name="model"\n\nother\n--${boundary}\ny`))],
      ['a quoted boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary="${boundary}"` })],
      ['a charset around the boundary', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; charset=utf-7; boundary=${boundary}` })],
      ['two boundary parameters', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; boundary=other` })],
      ['an unknown content type parameter', raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; boundary=${boundary}; x=y` })],
      ['a header quoting a disposition line', multipart(model, ['X-Note: content-disposition: form-data; name="model"\r\nContent-Disposition: form-data; name="image"; filename="a.png"', 'PNG'])],
      ['a Content-Type quoting a disposition line on a file', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png; content-disposition: form-data; name="model"', 'PNG'])],
      ['another disposition parameter', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a.png"; size=3\r\nContent-Type: image/png', 'PNG'])],
      ['an extended filename', multipart(model, ["Content-Disposition: form-data; name=\"image\"; filename*=UTF-8''%E2%82%AC.png", 'png'])],
      ['an extended filename with no charset', multipart(model, ['Content-Disposition: form-data; name="file"; filename*=speech.mp3', 'RIFF'])],
      ['a backslash in a filename', multipart(model, ['Content-Disposition: form-data; name="image"; filename="dir\\file.png"', 'png'])],
      ['a nested multipart file', multipart(model, ['Content-Disposition: form-data; name="files"; filename="a"\r\nContent-Type: multipart/mixed; boundary=inner', '--inner--'])],
      ['a service part with a length, a charset or an unknown header', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Length: 2\r\nContent-Type: text/plain; charset=utf-16\r\nX-Other: 1', 'svc'])],
      // Decoys that some parser reads as another field: the seller writes only the name it read.
      ['an escaped quote hiding a name', multipart(model, ['Content-Disposition: form-data; name="decoy"; foo="a\\\\"; bar="x; name=model; y"', 'other'])],
      ['an escaped quote hiding a priced name', multipart(model, field('quality', 'low'), ['Content-Disposition: form-data; name="decoy"; foo="a\\\\"; bar="x; name=quality; y"', 'high'])],
      ['a name in continuations beside a name', multipart(model, ['Content-Disposition: form-data; name="prompt"; name*0="mod"; name*1="el"', 'other'])],
      ['an extended name beside a name', multipart(model, ["Content-Disposition: form-data; name=\"prompt\"; name*=UTF-8''model", 'other'])],
      ['a parameter ending in name', multipart(model, ['Content-Disposition: form-data; xname="model"; name="prompt"', 'other'])],
      ['an extra parameter on a priced part', multipart(model, ['Content-Disposition: form-data; name="quality"; x=a/b', 'low'])],
    ])('%s', async (_name, request) => {
      expect(requestBodyService(request)).toBe('svc');
      await expectFormReadAlike(request);
    });

    it('hands on the decoys under the name the seller read, and no other', async () => {
      const entries = await expectFormReadAlike(multipart(model, ['Content-Disposition: form-data; name="decoy"; foo="a\\\\"; bar="x; name=model; y"', 'other']));
      expect(entries).toEqual([['model', 'svc'], ['decoy', 'other']]);
    });

    it('keeps a file\'s name, read from either filename form, with quotes and backslashes made plain', async () => {
      const entries = await expectFormReadAlike(multipart(
        model,
        ['Content-Disposition: form-data; name="file"; filename*=speech.mp3', 'RIFF'],
        ["Content-Disposition: form-data; name=\"image\"; filename*=UTF-8''caf%C3%A9.png", 'png'],
        ['Content-Disposition: form-data; name="mask"; filename="a\\"b.png"', 'png'],
      ));
      expect(entries).toEqual([['model', 'svc'], ['file', 'file:speech.mp3:RIFF'], ['image', 'file:caf\u00E9.png:png'], ['mask', 'file:a_b.png:png']]);
    });

    it('reads a browser or Node FormData, files and repeated fields included', async () => {
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
      const entries = await expectFormReadAlike(request);
      expect(entries).toEqual(await formEntries(request));
    });

    it.each(['dir\\file.png', 'quote"file.png', 'semi;colon.png', 'caf\u00E9.png', 'line\nbreak.png', 'name="model".png'])('reads a FormData with a file named %j', async (filename) => {
      const request = await encoded((form) => {
        form.append('model', 'svc');
        form.append('image', png(), filename);
      });
      await expectFormReadAlike(request);
    });

    // These bytes were captured from each client against a local server, boundaries aside.
    it.each<[string, string]>([
      ['curl', '------------------------abc123'],
      ['Go mime/multipart', '3eab641fc4fd2cf6'],
      ['Ruby Net::HTTP', 'Hvvabuite1rfQuUI-TF4'],
      ['undici and the OpenAI SDK', '----formdata-undici-067440839376'],
    ])('reads a body written by %s', async (_client, clientBoundary) => {
      const delimiter = `--${clientBoundary}`;
      const body = `${delimiter}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n`
        + `${delimiter}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it blue\r\n`
        + `${delimiter}\r\nContent-Disposition: form-data; name="image"; filename="model.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n`
        + `${delimiter}--\r\n`;
      const entries = await expectFormReadAlike(raw(body, { 'content-type': `multipart/form-data; boundary=${clientBoundary}` }));
      expect(entries).toEqual([['model', 'svc'], ['prompt', 'make it blue'], ['image', 'file:model.png:PNG']]);
    });
  });

  describe('says why it serves no service', () => {
    it.each(['n', 'size', 'quality', 'resolution', 'duration', 'aspect_ratio', 'audio', 'generate_audio', 'reference_video', 'reference_video_urls', 'video_urls', 'prompt', 'input'])('refuses the billing input %s spelled another way, and repeated in a form', (name) => {
      for (const spelled of [name.toUpperCase(), `${name}[]`, ` ${name}`, `${name[0]!.toUpperCase()}${name.slice(1)}`]) {
        expect(billedRequestBody(json({ model: 'svc', [spelled]: 'x' })), spelled).toMatchObject({ refusal: { code: 'invalid_billing_field' } });
      }
      expect(billedRequestBody(multipart(model, field(name.toUpperCase(), 'x')))).toMatchObject({ refusal: { code: 'invalid_billing_field' } });
      expect(billedRequestBody(multipart(model, field(`${name}[]`, 'x')))).toMatchObject({ refusal: { code: 'invalid_billing_field' } });
      for (const next of ['second', 'first']) {
        expect(billedRequestBody(multipart(model, field(name, 'first'), field(name, next)))).toMatchObject({ refusal: { code: 'repeated_field' } });
      }
    });

    it.each<[string, Request, string, string?]>([
      ['no service field', json({ messages: [] }), 'model_required'],
      ['an empty body', { headers: {}, body: new Uint8Array(0) }, 'model_required'],
      ['a JSON array', json([]), 'model_required'],
      ['a body that is not JSON', raw('model=svc', { 'content-type': 'application/x-www-form-urlencoded' }), 'model_required'],
      ['JSON in UTF-16', { headers: { 'content-type': 'application/json; charset=utf-16' }, body: new Uint8Array([0xff, 0xfe, ...[...'{"model":"svc"}'].flatMap((c) => [c.charCodeAt(0), 0])]) }, 'model_required'],
      ['a service that is not text', json({ service: 5 }), 'model_required'],
      ['an empty model', json({ model: '' }), 'model_required'],
      ['a form with no service field', multipart(field('prompt', 'x')), 'model_required'],
      ['JSON service and model that differ', json({ service: 'svc', model: 'other' }), 'ambiguous_service'],
      ['a JSON model that is not text beside a service', json({ service: 'svc', model: 123 }), 'ambiguous_service'],
      ['an empty service beside a model', json({ service: '', model: 'svc' }), 'ambiguous_service'],
      ['a null model beside a service', json({ service: 'svc', model: null }), 'ambiguous_service'],
      ['a padded JSON model', json({ model: ' svc' }), 'ambiguous_service'],
      ['a JSON model only in another case', json({ MODEL: 'svc' }), 'ambiguous_service', '"MODEL"'],
      ['a JSON model in two cases', json({ model: 'svc', Model: 'svc' }), 'ambiguous_service', '"Model"'],
      ['a JSON service written with a long s', json({ model: 'svc', '\u017Fervice': 'other' }), 'ambiguous_service'],
      ['a JSON model in array form', json({ model: 'svc', 'model[]': 'other' }), 'ambiguous_service'],
      ['a JSON model followed by a NUL', json({ model: 'svc', 'model\u0000': 'other' }), 'ambiguous_service'],
      ['a JSON model followed by a zero-width space', json({ model: 'svc', 'model\u200B': 'other' }), 'ambiguous_service'],
      ['a JSON modelId', json({ model: 'svc', modelId: 'svc' }), 'ambiguous_service', '"modelId"'],
      ['multipart service and model that differ', multipart(field('service', 'svc'), field('model', 'other')), 'ambiguous_service'],
      ['a padded multipart model', multipart(field('model', ' svc ')), 'ambiguous_service'],
      ['a BOM before a multipart model', multipart(field('model', '\uFEFFsvc')), 'ambiguous_service'],
      ['a multipart model sent as a file', multipart(file('model')), 'ambiguous_service', '"model"'],
      ['a multipart model over the field limit', multipart(model, field('service', `${' '.repeat(5000)}svc`)), 'ambiguous_service'],
      ['a multipart modelId', multipart(field('modelId', 'svc')), 'ambiguous_service', '"modelId"'],
      ['a multipart model in upper case', multipart(model, field('MODEL', 'other')), 'ambiguous_service'],
      ['a repeated multipart model', multipart(model, model), 'repeated_field', '"model"'],
      ['an unquoted second model', multipart(model, ['Content-Disposition: form-data; name=model', 'other']), 'repeated_field'],
      ['a field setting the charset of the others', multipart(model, field('_charset_', 'utf-16')), 'unsupported_multipart_body'],
      ['a JSON body labelled a form', json({ model: 'svc' }, 'multipart/form-data; boundary=x'), 'unsupported_multipart_body'],
      ['a form with no boundary', raw(`${frame([model])}${closing}`, { 'content-type': 'multipart/form-data' }), 'unsupported_multipart_body'],
      ['no closing delimiter', raw(frame([model, field('prompt', 'x')])), 'unsupported_multipart_body'],
      ['a delimiter with text after it', raw(`--${boundary}x\r\nContent-Disposition: form-data; name="model"\r\n\r\nsvc\r\n${closing}`), 'unsupported_multipart_body'],
      ['a bare LF after the first delimiter', raw(`--${boundary}\n${frame([model])}${closing}`), 'unsupported_multipart_body'],
      ['a part with no disposition', multipart(model, ['Content-Type: text/plain', 'other']), 'unsupported_multipart_body'],
      ['a second disposition header', multipart(model, ['Content-Disposition: form-data; name="prompt"\r\nContent-Disposition: form-data; name="model"', 'other']), 'unsupported_multipart_body'],
      ['a folded disposition header', multipart(model, ['Content-Disposition: form-data;\r\n name="model"', 'other']), 'unsupported_multipart_body'],
      ['a bare LF inside part headers', multipart(model, ['Content-Disposition: form-data; name="service"\n\nother', 'svc']), 'unsupported_multipart_body'],
      ['an escaped quote ending a filename before a name', multipart(model, ['Content-Disposition: form-data; name="image"; filename="a\\"; name="model"', 'other']), 'unsupported_multipart_body'],
      ['two name parameters', multipart(model, ['Content-Disposition: form-data; name="prompt"; name="model"', 'other']), 'unsupported_multipart_body'],
      ['a name parameter in two cases', multipart(model, ['Content-Disposition: form-data; name="prompt"; NAME="model"', 'other']), 'unsupported_multipart_body'],
      ['only an extended name', multipart(model, ["Content-Disposition: form-data; name*=UTF-8''model", 'other']), 'unsupported_multipart_body'],
      ['a parameter key padded with a control byte', multipart(model, ['Content-Disposition: form-data; name="decoy"; name\x1f="model"', 'other']), 'unsupported_multipart_body'],
      ['a percent-encoded name', multipart(model, field('m%6Fdel', 'other')), 'unsupported_multipart_body'],
      ['an encoded-word name', multipart(model, field('=?utf-8?q?model?=', 'other')), 'unsupported_multipart_body'],
      ['a non-ASCII name', multipart(model, field('model\u00A0', 'other')), 'unsupported_multipart_body'],
      ['a name with a space', multipart(model, field('model ', 'other')), 'unsupported_multipart_body'],
      ['a transfer-encoded part', multipart(['Content-Disposition: form-data; name="model"\r\nContent-Transfer-Encoding: base64', 'c3Zj']), 'unsupported_multipart_body'],
      ['a multipart quality sent as a file', multipart(model, file('quality')), 'invalid_billing_field', '"quality"'],
      ['a multipart size over the field limit', multipart(model, field('size', 'x'.repeat(4097))), 'invalid_billing_field', '"size"'],
      ['a multipart n that is not UTF-8', raw(`${frame([model])}--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n\xff\r\n${closing}`), 'invalid_billing_field'],
    ])('%s', (_name, request, code, named) => {
      const read = billedRequestBody(request);
      expect(read).toMatchObject({ service: null, refusal: { code } });
      if (read.service === null && named) expect(read.refusal.message).toContain(named);
      expect(requestBodyService(request)).toBeNull();
    });
  });

  describe('refuses a priced value billing would not read', () => {
    it.each<[string, string]>([
      ['a count with letters', '"n":"4abc"'],
      ['a fractional count', '"n":4.5'],
      ['a count too large to read', '"n":1e400'],
      ['a count in a list', '"n":[4]'],
      ['a zero count', '"n":0'],
      ['a quality in a list', '"quality":["high"]'],
      ['a quality in an object', '"quality":{"tier":"high"}'],
      ['a numeric size', '"size":1024'],
      ['a padded size', '"size":" 1024x1024"'],
      ['an empty resolution', '"resolution":""'],
    ])('in JSON: %s', (_name, member) => {
      expect(billedRequestBody(rawJson(`{"model":"svc",${member}}`))).toMatchObject({ refusal: { code: 'invalid_billing_field' } });
    });

    it.each(['4abc', '4.5', '0', '04', ' 4', '1e3'])('in a form: n %j', (n) => {
      expect(billedRequestBody(multipart(model, field('n', n)))).toMatchObject({ refusal: { code: 'invalid_billing_field' } });
    });

    it('serves plain priced values, and a count written as text', () => {
      expect(requestBodyService(json({ model: 'svc', n: '4', size: '1024x1024', quality: 'high', resolution: '4K' }))).toBe('svc');
      expect(requestBodyService(json({ model: 'svc', n: null, quality: null }))).toBe('svc');
    });

  });

  describe('reads any body in time linear in its size', () => {
    const fast = (request: Request) => {
      const started = performance.now();
      billedRequestBody(request);
      return performance.now() - started;
    };

    it('reads padded JSON keys and form names quickly', () => {
      // A pattern that backtracked took seconds on these.
      expect(fast(rawJson(`{"model":"svc","model${' '.repeat(80_000)}x":1}`))).toBeLessThan(250);
      expect(fast(rawJson(`{"model":"svc",${Array.from({ length: 500 }, (_, index) => `"models${' '.repeat(8000)}${index}":1`).join(',')}}`))).toBeLessThan(1000);
      expect(fast(multipart(model, field(`models${' '.repeat(80_000)}x`, '1')))).toBeLessThan(250);
      expect(fast(multipart(model, [`Content-Disposition: form-data; name="a"; f="${'\\a'.repeat(40_000)}"`, '1']))).toBeLessThan(250);
    });

    it('reads a form with many parts in one pass, and refuses one with too many', () => {
      const parts = (count: number) => Array.from({ length: count }, (_, index) => field(`metadata[${index}]`, 'x'));
      expect(requestBodyService(multipart(model, ...parts(999)))).toBe('svc');
      expect(fast(multipart(model, ...parts(999)))).toBeLessThan(250);
      expect(billedRequestBody(multipart(model, ...parts(1000)))).toMatchObject({ refusal: { code: 'unsupported_multipart_body' } });
    });

    // Bodies a buyer could send to make the seller spend time and memory before any payment.
    it('refuses hostile forms quickly', () => {
      const started = performance.now();
      expect(billedRequestBody(multipart(model, [`Content-Disposition: form-data; name="image"; filename="${'a'.repeat(4 * 1024 * 1024)}"`, 'png']))).toMatchObject({ refusal: { code: 'unsupported_multipart_body' } });
      expect(billedRequestBody(raw(`${frame([model])}${`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\n\r\n`.repeat(200_000)}${closing}`))).toMatchObject({ refusal: { code: 'unsupported_multipart_body' } });
      expect(billedRequestBody(multipart(model, [`Content-Disposition: form-data; name="x"\r\n${'X-A: b\r\n'.repeat(2000)}`, '1']))).toMatchObject({ refusal: { code: 'unsupported_multipart_body' } });
      expect(billedRequestBody(raw(`${frame([model])}${closing}`, { 'content-type': `multipart/form-data; ${'x=1; '.repeat(300)}boundary=${boundary}` }))).toMatchObject({ refusal: { code: 'unsupported_multipart_body' } });
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('refuses a JSON body nested too deeply to write again, without throwing', () => {
      const depth = 100_000;
      expect(billedRequestBody(rawJson(`{"model":"svc","x":${'['.repeat(depth)}${']'.repeat(depth)}}`))).toMatchObject({ refusal: { code: 'request_too_large' } });
    });

    it('serves an honest body however large, and a form whose rewrite grows only by its part headers', () => {
      const large = billedRequestBody(rawJson(`{"model":"svc","input":"${'x'.repeat(65 * 1024 * 1024)}"}`));
      expect(large.service).toBe('svc');
      const tiny = 'b';
      const parts = Array.from({ length: 999 }, (_, index) => `--${tiny}\r\nContent-Disposition: form-data; name=m${index}\r\n\r\n\r\n`).join('');
      const form = billedRequestBody(raw(`--${tiny}\r\nContent-Disposition: form-data; name=model\r\n\r\nsvc\r\n${parts}--${tiny}--`, { 'content-type': `multipart/form-data; boundary=${tiny}` }));
      expect(form.service).toBe('svc');
    });

    it('refuses a body that grows much larger once written', () => {
      // `1e20` is written out as 21 digits, so this 16 MiB body would be written as about 70 MiB.
      const numbers = Array.from({ length: 3_300_000 }, () => '1e20').join(',');
      expect(billedRequestBody(rawJson(`{"model":"svc","input":[${numbers}]}`))).toMatchObject({ refusal: { code: 'request_too_large' } });
    });
  });

  it('hands on a form every reader reads alike, however the buyer wrote it', async () => {
    let seed = 20261111;
    const random = (limit: number) => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    const image: Part = ['Content-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png', 'PNG'];
    const seeds = [
      frame([image, model, field('quality', 'high'), field('n', '2')]) + closing,
      frame([field('prompt', 'x'), image, model, field('size', '1024x1024')]) + closing,
      frame([field('service', 'svc'), image, field('resolution', '2K')]) + closing,
    ];
    const pieces = [
      'X-Note: content-disposition: form-data; name="model"\r\n', 'X-Note: CONTENT-DISPOSITION:\tFORM-DATA;NAME="n"\r\n',
      'Content-Type: image/png; content-disposition: form-data; name="modelId"\r\n', '\r\nX-Note: content-disposition: form-data; name="model"',
      '; content-disposition: form-data; name="size"', 'content-disposition:', 'form-data; name="model"', '\r\nContent-Type: text/plain', '\r\nContent-Length: 4',
      '; filename=""', '; filename="b"', 'name="quality"', 'name="n"', 'name="image"', '\r\n', '\n', ' ', '"', ';', '\\', '%', '\x1f', '\uFEFF', '\u00A0',
      ' filenamename="size";', '; foo="a\\\\"; bar="x; name=model; y"', '; name*=UTF-8\'\'model', '; x=a/b', 'NAME="model"', 'name=model', 'file', 'x',
      `--${boundary}`, `--${boundary}--`, `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nother\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="quality"\r\n\r\nlow\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n9\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="size"; filename=""\r\n\r\n512x512\r\n`,
    ];
    const contentTypes = [
      `multipart/form-data; boundary=${boundary}`, `multipart/form-data; boundary="${boundary}"`, `multipart/form-data; charset=utf-7; boundary=${boundary}`,
      `multipart/form-data; xboundary=${boundary}; boundary=other`,
    ];
    let served = 0;
    for (let round = 0; round < 4000; round += 1) {
      let text = seeds[random(seeds.length)]!;
      for (let edit = random(3) + 1; edit > 0; edit -= 1) {
        // Most edits land at the start of a line, where a part's headers are.
        const lines = [...text.matchAll(/\r\n/g)].map((match) => match.index + 2);
        const at = random(3) === 0 ? random(text.length + 1) : lines[random(lines.length)]!;
        text = random(6) === 0
          ? text.slice(0, at) + text.slice(Math.min(text.length, at + 1 + random(6)))
          : text.slice(0, at) + pieces[random(pieces.length)]! + text.slice(at);
      }
      const request = raw(text, { 'content-type': contentTypes[random(contentTypes.length)]! });
      // Any other name is not a service this seller would serve.
      if (billedRequestBody(request).service !== 'svc') continue;
      served += 1;
      await expectFormReadAlike(request, JSON.stringify(text));
    }
    expect(served).toBeGreaterThan(400);
  });
});
