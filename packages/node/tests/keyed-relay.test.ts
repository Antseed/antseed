import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { KeyedRelayEvent, KeyedRelayProcess, KeyedRelaySellerStart } from '@antseed/keyed-relay';
import { keyedRequestTailFields, type KeyedRequestTerms } from '@antseed/protocol/blind-relay';
import { keyedRelayEstimatedUsage, keyedRelayModelMatches, readKeyedRelayReveal } from '../src/keyed-relay-billing.js';
import { checkKeyedRequest } from '../src/keyed-relay-request.js';
import { SellerBlindRelay, keyedRelayHead, type BlindRelayCharge, type KeyedRequestAdmission, type KeyedRequestDecision } from '../src/seller-blind-relay.js';
import type { KeyedRelayTarget, Provider } from '../src/interfaces/seller-provider.js';

const BUYER = 'aa'.repeat(20);
const OTHER = 'bb'.repeat(20);
const b64 = (text: string): string => Buffer.from(text).toString('base64');

const TARGET: KeyedRelayTarget = {
  host: 'api.example.com',
  port: 443,
  baseUrl: 'https://api.example.com/v1',
  path: '/v1/chat/completions',
  model: 'org/open-model',
  headers: [['Authorization', 'Bearer sk-seller-secret']],
  request: { maxTokensField: 'max_tokens', maxTokens: 1000 },
};

describe('keyedRelayHead', () => {
  it('writes the request line, Host and the credential, and ends with Connection: close', () => {
    expect(new TextDecoder().decode(keyedRelayHead(TARGET))).toBe(
      'POST /v1/chat/completions HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer sk-seller-secret\r\nConnection: close\r\n',
    );
    expect(new TextDecoder().decode(keyedRelayHead({ ...TARGET, port: 8443 }))).toContain('Host: api.example.com:8443\r\n');
  });

  it('refuses a target that could split the head', () => {
    expect(() => keyedRelayHead({ ...TARGET, headers: [['Authorization', 'Bearer x\r\nX-Evil: 1']] })).toThrow('malformed header');
    expect(() => keyedRelayHead({ ...TARGET, headers: [['Bad Name', 'x']] })).toThrow('malformed header');
    expect(() => keyedRelayHead({ ...TARGET, path: '/v1/chat completions' })).toThrow('malformed');
    expect(() => keyedRelayHead({ ...TARGET, host: 'a\r\nb' })).toThrow('malformed');
  });
});

describe('readKeyedRelayReveal', () => {
  const sse = 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n'
    + '5a\r\ndata: {"model":"org/open-model","choices":[{"delta":{"content":"hi"}}]}\n\n\r\n'
    + '60\r\ndata: {"model":"org/open-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n\r\n0\r\n\r\n';
  const usageAt = sse.lastIndexOf('data: {"model":"org/open-model","choices":[]');

  it('reads the status, the usage and the model from a stream tail, chunk framing and all', () => {
    const tail = sse.slice(usageAt);
    expect(readKeyedRelayReveal({ length: sse.length, ranges: [{ offset: 0, data: b64('HTTP/1.1 200 OK') }, { offset: usageAt, data: b64(tail) }] })).toEqual({
      statusCode: 200,
      usage: { inputTokens: 12, freshInputTokens: 12, cachedInputTokens: 0, outputTokens: 3 },
      model: 'org/open-model',
      streamed: true,
    });
  });

  it('reads the usage of a JSON body from its "usage" key', () => {
    const json = 'HTTP/1.1 200 OK\r\n\r\n{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}';
    const at = json.indexOf('"usage":');
    expect(readKeyedRelayReveal({ length: json.length, ranges: [{ offset: at, data: b64(json.slice(at)) }] })).toMatchObject({ usage: { inputTokens: 7, outputTokens: 2 }, streamed: false });
  });

  it('reads a stream with no usage from its end marker', () => {
    const end = 'data: [DONE]\n\n';
    expect(readKeyedRelayReveal({ length: 100 + end.length, ranges: [{ offset: 100, data: b64(end) }] })).toMatchObject({ usage: null, streamed: true });
  });

  it('ignores a tail that stops short of the end or starts anywhere but a stream event or the usage key', () => {
    const tail = sse.slice(usageAt, sse.length - 4);
    expect(readKeyedRelayReveal({ length: sse.length, ranges: [{ offset: usageAt, data: b64(tail) }] }).usage).toBeNull();
    const inside = sse.indexOf('"prompt_tokens"');
    expect(readKeyedRelayReveal({ length: sse.length, ranges: [{ offset: inside, data: b64(sse.slice(inside)) }] }).usage).toBeNull();
  });

  it('reads an error status, and nothing from bytes not at offset 0 for it', () => {
    expect(readKeyedRelayReveal({ length: 40, ranges: [{ offset: 0, data: b64('HTTP/1.1 401 Unauthorized') }] }).statusCode).toBe(401);
    expect(readKeyedRelayReveal({ length: 40, ranges: [{ offset: 3, data: b64('HTTP/1.1 401 Unauthorized') }] }).statusCode).toBeNull();
  });
});

/** A keyed request as the buyer writes it: its header block, then `{<rest>,<checked fields>}`. */
function keyedRequest(options: { terms?: KeyedRequestTerms; model?: string; maxTokens?: number | null; stream?: boolean; rest?: string; headers?: string; fields?: string } = {}) {
  const terms = options.terms ?? TARGET.request;
  const fields = options.fields ?? keyedRequestTailFields(terms, { model: options.model ?? TARGET.model, maxTokens: options.maxTokens === undefined ? 500 : options.maxTokens, stream: options.stream ?? true });
  const rest = options.rest ?? '{"messages":[{"role":"user","content":"hidden"}]';
  const body = rest === '{' ? `{${fields}}` : `${rest},${fields}}`;
  const tail = rest === '{' ? body : `,${fields}}`;
  const headers = options.headers ?? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  const text = headers + body;
  const length = Buffer.byteLength(text);
  return {
    length,
    ranges: [{ offset: 0, data: b64(headers) }, { offset: length - Buffer.byteLength(tail), data: b64(tail) }],
  };
}

describe('checkKeyedRequest', () => {
  it('admits the headers the seller relays and the checked fields at the end of the body', () => {
    expect(checkKeyedRequest(keyedRequest(), TARGET.model, TARGET.request)).toMatchObject({ ok: true, maxTokens: 500, stream: true });
    // A body of the checked fields only, revealed whole.
    expect(checkKeyedRequest(keyedRequest({ rest: '{', stream: false }), TARGET.model, TARGET.request)).toMatchObject({ ok: true, stream: false });
  });

  it('refuses another model, a limit over the cap or none under a cap', () => {
    expect(checkKeyedRequest(keyedRequest({ model: 'org/very-expensive-model' }), TARGET.model, TARGET.request)).toMatchObject({ ok: false, reason: expect.stringContaining('names model') });
    expect(checkKeyedRequest(keyedRequest({ maxTokens: 1001 }), TARGET.model, TARGET.request)).toMatchObject({ ok: false, reason: expect.stringContaining('at most 1000') });
    expect(checkKeyedRequest(keyedRequest({ maxTokens: null }), TARGET.model, TARGET.request)).toMatchObject({ ok: false, reason: expect.stringContaining('at most 1000') });
    // Without a cap a request may leave the limit out.
    const uncapped: KeyedRequestTerms = { maxTokensField: 'max_tokens' };
    expect(checkKeyedRequest(keyedRequest({ terms: uncapped, maxTokens: null }), TARGET.model, uncapped)).toMatchObject({ ok: true, maxTokens: null });
  });

  it('refuses checked fields that are not exactly the canonical ones', () => {
    const variants = [
      '"model":"org/open-model","model":"org/very-expensive-model","max_tokens":500,"n":1,"stream":true,"stream_options":{"include_usage":true}',
      '"model": "org/open-model","max_tokens":500,"n":1,"stream":true,"stream_options":{"include_usage":true}',
      '"mod\\u0065l":"org/open-model","max_tokens":500,"n":1,"stream":true,"stream_options":{"include_usage":true}',
      '"model":"org/open-model","max_tokens":500,"n":1,"stream":true',
      '"model":"org/open-model","max_tokens":500,"n":1,"stream":true,"stream_options":{"include_usage":true},"service_tier":"priority"',
    ];
    for (const fields of variants) {
      expect(checkKeyedRequest(keyedRequest({ fields }), TARGET.model, TARGET.request), fields).toMatchObject({ ok: false });
    }
    const pinned: KeyedRequestTerms = { maxTokensField: 'max_tokens', pinned: { service_tier: 'default' } };
    expect(checkKeyedRequest(keyedRequest({ terms: pinned }), TARGET.model, pinned)).toMatchObject({ ok: true });
    expect(checkKeyedRequest(keyedRequest(), TARGET.model, pinned)).toMatchObject({ ok: false });
  });

  it('refuses headers the seller does not relay, repeats, line tricks and a wrong length', () => {
    const body = (headers: string) => checkKeyedRequest(keyedRequest({ headers }), TARGET.model, TARGET.request);
    const length = Buffer.byteLength(`{"messages":[{"role":"user","content":"hidden"}],${keyedRequestTailFields(TARGET.request, { model: TARGET.model, maxTokens: 500, stream: true })}}`);
    const ok = `Content-Type: application/json\r\nContent-Length: ${length}\r\n`;
    expect(body(`${ok}\r\n`)).toMatchObject({ ok: true });
    expect(body(`${ok}anthropic-beta: x\r\n\r\n`)).toMatchObject({ ok: false, reason: expect.stringContaining('"anthropic-beta"') });
    expect(body(`${ok}Transfer-Encoding: chunked\r\n\r\n`)).toMatchObject({ ok: false });
    expect(body(`${ok}Accept: a\r\naccept: b\r\n\r\n`)).toMatchObject({ ok: false, reason: expect.stringContaining('repeats') });
    expect(body(`${ok}Accept: a\nX-Cost: 1\r\n\r\n`)).toMatchObject({ ok: false });
    expect(body(`${ok} folded: 1\r\n\r\n`)).toMatchObject({ ok: false });
    expect(body(`Content-Type: text/plain\r\nContent-Length: ${length}\r\n\r\n`)).toMatchObject({ ok: false });
    expect(body(`Content-Type: application/json\r\nContent-Length: ${length - 1}\r\n\r\n`)).toMatchObject({ ok: false });
  });

  it('refuses a reveal without the whole header block or without the end of the body', () => {
    const request = keyedRequest();
    expect(checkKeyedRequest({ ...request, ranges: [request.ranges[1]!] }, TARGET.model, TARGET.request)).toMatchObject({ ok: false });
    const head = Buffer.from(request.ranges[0]!.data, 'base64').toString();
    expect(checkKeyedRequest({ ...request, ranges: [{ offset: 0, data: b64(head.slice(0, -2)) }, request.ranges[1]!] }, TARGET.model, TARGET.request)).toMatchObject({ ok: false });
    // The checked fields, but not at the very end.
    expect(checkKeyedRequest({ ...request, length: request.length + 1 }, TARGET.model, TARGET.request)).toMatchObject({ ok: false });
  });
});

describe('keyedRelayModelMatches', () => {
  it('accepts the forms upstreams answer with and refuses another model', () => {
    expect(keyedRelayModelMatches('gpt-4o-mini-2024-07-18', 'gpt-4o-mini')).toBe(true);
    expect(keyedRelayModelMatches('openai/gpt-4o-mini', 'gpt-4o-mini')).toBe(true);
    expect(keyedRelayModelMatches('Org/Open-Model', 'org/open-model')).toBe(true);
    expect(keyedRelayModelMatches('gpt-4o', 'gpt-4o-mini')).toBe(false);
    expect(keyedRelayModelMatches('org/big-model', 'org/open-model')).toBe(false);
  });
});

describe('keyedRelayEstimatedUsage', () => {
  it('estimates about four bytes a token each way', () => {
    expect(keyedRelayEstimatedUsage(401, 8)).toEqual({ inputTokens: 101, freshInputTokens: 101, cachedInputTokens: 0, outputTokens: 2 });
  });
});

/** A stand-in for the seller's sidecar: records its start and its decisions, and lets the test emit its events. */
function fakeSidecar() {
  const emitter = new EventEmitter() as EventEmitter & { peer: PassThrough; starts: KeyedRelaySellerStart[]; decisions: string[] };
  emitter.peer = new PassThrough();
  emitter.starts = [];
  emitter.decisions = [];
  Object.assign(emitter, {
    startSeller: (config: KeyedRelaySellerStart) => emitter.starts.push(config),
    admit: () => emitter.decisions.push('admit'),
    refuse: (reason: string) => emitter.decisions.push(`refuse: ${reason}`),
  });
  return emitter;
}

function keyedRelay(target: KeyedRelayTarget | null = TARGET, admitKeyedRequest?: (request: KeyedRequestAdmission) => KeyedRequestDecision) {
  const charges: BlindRelayCharge[] = [];
  const sidecars: ReturnType<typeof fakeSidecar>[] = [];
  const blind = new SellerBlindRelay({
    charge: (charge) => charges.push(charge),
    spawnKeyedRelay: () => {
      const sidecar = fakeSidecar();
      sidecars.push(sidecar);
      return sidecar as unknown as KeyedRelayProcess;
    },
    usageCostUsdc: (_provider, _service, usage) => BigInt(usage.inputTokens + usage.outputTokens * 10),
    ...(admitKeyedRequest ? { admitKeyedRequest } : {}),
  });
  const provider = { keyedRelayTarget: () => target } as unknown as Provider;
  return { blind, charges, sidecars, provider };
}

const emit = (sidecar: EventEmitter, event: KeyedRelayEvent): boolean => sidecar.emit('event', event);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const revealed = (status: string, usage?: string, model = 'org/open-model') => {
  const tail = usage ? `data: {"model":"${model}","choices":[],"usage":${usage}}\n\n` : '';
  const length = 200 + tail.length;
  return { type: 'revealed' as const, length, ranges: [{ offset: 0, data: b64(status) }, ...(usage ? [{ offset: 200, data: b64(tail) }] : [])] };
};

describe('SellerBlindRelay', () => {
  it('hands out a handle with no credential, and keeps the key for its own sidecar', async () => {
    const { blind, sidecars, provider } = keyedRelay();
    const minted = blind.mint(BUYER, 'open-model', provider);
    expect(minted).toMatchObject({ upstream: { host: 'api.example.com', path: '/v1/chat/completions', model: 'org/open-model' }, request: TARGET.request });
    expect(JSON.stringify(minted)).not.toContain('sk-seller-secret');
    const grant = await blind.authorize(BUYER, 'stream-1', minted.credentialId);
    grant.open();
    expect(sidecars[0]!.starts[0]).toMatchObject({ host: 'api.example.com', port: 443, serverName: 'api.example.com' });
    expect(new TextDecoder().decode(sidecars[0]!.starts[0]!.head)).toContain('Authorization: Bearer sk-seller-secret');
  });

  it('bills the usage the buyer revealed, and nothing for an error', async () => {
    const { blind, charges, sidecars, provider } = keyedRelay();
    const first = blind.mint(BUYER, 'open-model', provider);
    (await blind.authorize(BUYER, 'ok', first.credentialId)).open();
    emit(sidecars[0]!, { type: 'responseEnd', length: 300, bytesUp: 400, bytesDown: 800 });
    emit(sidecars[0]!, revealed('HTTP/1.1 200 OK', '{"prompt_tokens":12,"completion_tokens":3}'));
    sidecars[0]!.emit('exit', { code: 0, stderr: '' });
    expect(charges).toEqual([{ buyerPeerId: BUYER, requestId: 'ok', service: 'open-model', costUsdc: 42n }]);

    (await blind.authorize(BUYER, 'refused', first.credentialId)).open();
    emit(sidecars[1]!, { type: 'responseEnd', length: 100, bytesUp: 400, bytesDown: 100 });
    emit(sidecars[1]!, revealed('HTTP/1.1 401 Unauthorized'));
    sidecars[1]!.emit('exit', { code: 0, stderr: '' });
    expect(charges).toHaveLength(1);
  });

  it('bills a delivered answer the buyer never revealed by the bytes relayed', async () => {
    const { blind, charges, sidecars, provider } = keyedRelay();
    const minted = blind.mint(BUYER, 'open-model', provider);
    (await blind.authorize(BUYER, 'hidden', minted.credentialId)).open();
    emit(sidecars[0]!, { type: 'responseEnd', length: 300, bytesUp: 400, bytesDown: 800 });
    sidecars[0]!.emit('exit', { code: 1, stderr: 'no reveal from the buyer' });
    expect(charges).toEqual([{ buyerPeerId: BUYER, requestId: 'hidden', service: 'open-model', costUsdc: 100n + 200n * 10n }]);
  });

  it('charges nothing when the stream ends before an answer', async () => {
    const { blind, charges, sidecars, provider } = keyedRelay();
    const minted = blind.mint(BUYER, 'open-model', provider);
    (await blind.authorize(BUYER, 'early', minted.credentialId)).open();
    sidecars[0]!.emit('exit', { code: 1, stderr: 'handshake timed out' });
    expect(charges).toEqual([]);
  });

  it('forwards a request only once it passes the check and the payment checks, holding its usage until it is billed', async () => {
    const admissions: KeyedRequestAdmission[] = [];
    const finished: number[] = [];
    let decision: KeyedRequestDecision = { admitted: true, finish: (tokens) => finished.push(tokens) };
    const { blind, charges, sidecars, provider } = keyedRelay(TARGET, (request) => { admissions.push(request); return decision; });
    const minted = blind.mint(BUYER, 'open-model', provider);

    (await blind.authorize(BUYER, 'ok', minted.credentialId)).open();
    const request = keyedRequest();
    emit(sidecars[0]!, { type: 'request', ...request });
    await settle();
    expect(sidecars[0]!.decisions).toEqual(['admit']);
    expect(admissions[0]).toMatchObject({ buyerPeerId: BUYER, service: 'open-model', maxOutputTokens: 500 });
    expect(admissions[0]!.inputTokens).toBeGreaterThan(0);
    emit(sidecars[0]!, { type: 'responseEnd', length: 300, bytesUp: 400, bytesDown: 800 });
    emit(sidecars[0]!, revealed('HTTP/1.1 200 OK', '{"prompt_tokens":12,"completion_tokens":3}'));
    sidecars[0]!.emit('exit', { code: 0, stderr: '' });
    expect(finished).toEqual([15]);
    expect(charges).toHaveLength(1);

    // The check refuses before the payment checks run; a payment refusal is passed on.
    (await blind.authorize(BUYER, 'swap', minted.credentialId)).open();
    emit(sidecars[1]!, { type: 'request', ...keyedRequest({ model: 'org/very-expensive-model' }) });
    await settle();
    expect(sidecars[1]!.decisions).toEqual([expect.stringContaining('refuse: the request names model')]);
    expect(admissions).toHaveLength(1);
    sidecars[1]!.emit('exit', { code: 0, stderr: '' });

    decision = { admitted: false, reason: 'the locked reserve has 0 left' };
    (await blind.authorize(BUYER, 'broke', minted.credentialId)).open();
    emit(sidecars[2]!, { type: 'request', ...keyedRequest() });
    await settle();
    expect(sidecars[2]!.decisions).toEqual(['refuse: the locked reserve has 0 left']);
    sidecars[2]!.emit('exit', { code: 0, stderr: '' });
    expect(charges).toHaveLength(1);
  });

  it('refuses further handles to a buyer whose answer contradicts the checked request', async () => {
    const { blind, charges, sidecars, provider } = keyedRelay();
    const minted = blind.mint(BUYER, 'open-model', provider);
    (await blind.authorize(BUYER, 'hidden-stream-false', minted.credentialId)).open();
    emit(sidecars[0]!, { type: 'request', ...keyedRequest({ stream: true }) });
    await settle();
    emit(sidecars[0]!, { type: 'responseEnd', length: 300, bytesUp: 400, bytesDown: 800 });
    const json = '"usage":{"prompt_tokens":5,"completion_tokens":5}}';
    emit(sidecars[0]!, { type: 'revealed', length: 200 + json.length, ranges: [{ offset: 0, data: b64('HTTP/1.1 200 OK') }, { offset: 200, data: b64(json) }] });
    expect(charges).toHaveLength(1);
    expect(() => blind.mint(BUYER, 'open-model', provider)).toThrow('no longer relays requests');
  });

  it('refuses further handles to a buyer whose request ran another model', async () => {
    const { blind, charges, sidecars, provider } = keyedRelay();
    const minted = blind.mint(BUYER, 'open-model', provider);
    (await blind.authorize(BUYER, 'swap', minted.credentialId)).open();
    emit(sidecars[0]!, { type: 'responseEnd', length: 300, bytesUp: 400, bytesDown: 800 });
    emit(sidecars[0]!, revealed('HTTP/1.1 200 OK', '{"prompt_tokens":5,"completion_tokens":5}', 'org/very-expensive-model'));
    expect(charges).toHaveLength(1);
    expect(() => blind.mint(BUYER, 'open-model', provider)).toThrow('no longer relays requests');
  });

  it('lets only the buyer a handle was minted for open a stream, and one stream at a time', async () => {
    const { blind, sidecars, provider } = keyedRelay();
    const { credentialId } = blind.mint(BUYER, 'open-model', provider);
    await expect(blind.authorize(OTHER, 's0', credentialId)).rejects.toThrow('unknown credential');
    (await blind.authorize(BUYER, 's1', credentialId)).open();
    await expect(blind.authorize(BUYER, 's2', credentialId)).rejects.toThrow('credential busy');
    sidecars[0]!.emit('exit', { code: 0, stderr: '' });
    await expect(blind.authorize(BUYER, 's3', credentialId)).resolves.toBeTruthy();
  });

  it('refuses a fifth live handle for one buyer', () => {
    const { blind, provider } = keyedRelay();
    for (let i = 0; i < 4; i += 1) blind.mint(BUYER, 'open-model', provider);
    expect(() => blind.mint(BUYER, 'open-model', provider)).toThrow('too many live credentials');
    expect(blind.mint(OTHER, 'open-model', provider)).toBeTruthy();
  });

  it('serves only with the sidecar installed and a target named', () => {
    const without = new SellerBlindRelay({ charge: () => {} });
    const provider = { keyedRelayTarget: () => TARGET } as unknown as Provider;
    expect(without.servesKeyed(provider)).toBe(false);
    expect(() => without.mint(BUYER, 'open-model', provider)).toThrow('not served through the blind relay');
    const { blind, provider: noTarget } = keyedRelay(null);
    expect(() => blind.mint(BUYER, 'open-model', noTarget)).toThrow('not served through the blind relay');
    const { blind: badTerms, provider: badProvider } = keyedRelay({ ...TARGET, request: { maxTokensField: 'max_tokens', pinned: { model: 'x' } } });
    expect(() => badTerms.mint(BUYER, 'open-model', badProvider)).toThrow('malformed request terms');
  });
});
