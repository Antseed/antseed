import { describe, expect, it } from 'vitest';
import { ExposedSseStream, exposedJsonBody, type SellerCost } from '../src/utils/response-body.js';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../src/types/http.js';

const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// $1 per million fresh input, $0.5 cached, $4 output.
const cost: SellerCost = (usage) => (usage.freshInputTokens * 1 + usage.cachedInputTokens * 0.5 + usage.outputTokens * 4) / 1_000_000;

const upstreamCompletion = {
  id: 'chatcmpl-1', model: 'm', provider: 'SomeHost', choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7, cost: 0.0001, cost_details: { upstream_inference_cost: 0.0001 }, is_byok: false },
};

describe('exposedJsonBody', () => {
  it('replaces what the upstream says the request cost with the seller\'s price', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode(upstreamCompletion), cost)));
    expect(body.usage).toEqual({ prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 });
    expect(body.provider).toBeUndefined();
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('adds the seller\'s price where the upstream gave none', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode({ usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 } }), cost)));
    expect(body.usage.estimated_cost).toBe(0.00024);
  });

  it('only drops the upstream cost when the price is not per token', () => {
    const body = JSON.parse(decode(exposedJsonBody(encode(upstreamCompletion))));
    expect(body.usage).toEqual({ prompt_tokens: 600, completion_tokens: 300 });
  });

  it('leaves bodies without usage byte for byte', () => {
    const plain = encode({ error: { message: 'x' } });
    expect(exposedJsonBody(plain, cost)).toBe(plain);
    const notJson = encode('not json "usage"');
    expect(exposedJsonBody(notJson, cost)).toBe(notJson);
  });
});

describe('ExposedSseStream', () => {
  it('prices a usage event even when it is split across chunks', () => {
    const stream = new ExposedSseStream(cost);
    const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7 } })}\n\n` + 'data: [DONE]\n\n';
    const cut = text.indexOf('estimated');
    const out = decode(stream.push(encode(text.slice(0, cut)))) + decode(stream.push(encode(text.slice(cut)))) + decode(stream.flush());
    expect(out).toBe('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 } })}\n\n` + 'data: [DONE]\n\n');
  });

  it('prices an Anthropic stream on its running totals', () => {
    const stream = new ExposedSseStream(cost);
    const start = `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 } } })}\n`;
    const delta = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } })}\n`;
    const events = decode(stream.push(encode(start + delta))).split('\n').filter(Boolean).map((line) => JSON.parse(line.slice(6)));
    expect(events[1].usage.estimated_cost).toBe(0.00024);
  });

  it('prices an event whose JSON spans several data lines, split across chunks', () => {
    const stream = new ExposedSseStream(cost);
    const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + 'event: usage\ndata: {"choices":[],"provider":"SomeHost","usage":\ndata: {"prompt_tokens":600,"completion_tokens":300,"cost":0.01}}\n\n'
      + 'data: [DONE]\n\n';
    const out = [text.indexOf('"usage"'), text.indexOf('"cost"')].concat(text.length)
      .reduce<{ at: number; out: string }>((acc, cut) => ({ at: cut, out: acc.out + decode(stream.push(encode(text.slice(acc.at, cut)))) }), { at: 0, out: '' })
      .out + decode(stream.flush());
    expect(out).toBe('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
      + `event: usage\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 } })}\n\n`
      + 'data: [DONE]\n\n');
  });

  it('sends a single-line event as soon as its line ends', () => {
    const stream = new ExposedSseStream(cost);
    expect(decode(stream.push(encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n')))).toBe('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
  });

  it('leaves multi-line events that are not JSON as they were', () => {
    const stream = new ExposedSseStream(cost);
    const text = 'data: first\ndata: second\n\ndata: [DONE]\n\n';
    expect(decode(stream.push(encode(text))) + decode(stream.flush())).toBe(text);
  });

  it('rewrites a held event that the stream ends without a blank line', () => {
    const stream = new ExposedSseStream(cost);
    const out = decode(stream.push(encode('data: {"usage":\n'))) + decode(stream.push(encode('data: {"prompt_tokens":600,"completion_tokens":300,"cost":0.01}}'))) + decode(stream.flush());
    expect(out).toBe(`data: ${JSON.stringify({ usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 } })}`);
  });

  it('handles CR, LF and CRLF line endings, a CRLF split across chunks included', () => {
    const usage = (key: string) => JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, [key]: key === 'cost' ? 0.01 : 0.0018 } });
    for (const eol of ['\r', '\n', '\r\n']) {
      const text = `data: {"choices":[]}${eol}${eol}data: ${usage('cost')}${eol}${eol}data: [DONE]${eol}${eol}`;
      const expected = text.replace(usage('cost'), usage('estimated_cost'));
      for (let cut = 1; cut < text.length; cut++) {
        const stream = new ExposedSseStream(cost);
        const first = decode(stream.push(encode(text.slice(0, cut))));
        const out = first + decode(stream.push(encode(text.slice(cut)))) + decode(stream.flush());
        expect(out).toBe(expected);
      }
      // Whole CR-only events are sent as soon as they arrive, not at the end.
      expect(decode(new ExposedSseStream(cost).push(encode(text)))).toBe(expected);
    }
  });

  it('never drops a final line it could not parse', () => {
    const stream = new ExposedSseStream(cost);
    expect(decode(stream.push(encode('data: {"partial":')))).toBe('');
    expect(decode(stream.flush())).toBe('data: {"partial":');
  });

  it('keeps a character split across chunks intact while other streams decode in between', () => {
    const [a, b] = [new ExposedSseStream(cost), new ExposedSseStream(cost)];
    const textA = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n';
    const textB = 'data: {"choices":[{"delta":{"content":"wörld"}}]}\n';
    const [bytesA, bytesB] = [encode(textA), encode(textB)];
    // Cut both streams inside their two-byte character.
    const cutA = textA.indexOf('é') + 1;
    const cutB = textB.indexOf('ö') + 1;
    let outA = decode(a.push(bytesA.slice(0, cutA)));
    let outB = decode(b.push(bytesB.slice(0, cutB)));
    exposedJsonBody(encode(upstreamCompletion), cost);
    outB += decode(b.push(bytesB.slice(cutB))) + decode(b.flush());
    outA += decode(a.push(bytesA.slice(cutA))) + decode(a.flush());
    expect(outA).toBe(textA);
    expect(outB).toBe(textB);
  });
});

describe('seller response bodies', () => {
  const request: SerializedHttpRequest = { requestId: 'r1', method: 'POST', path: '/v1/chat/completions', headers: {}, body: new Uint8Array(0) };
  const execute = (provider: Partial<Provider>, callbacks?: ProviderStreamCallbacks, req = request) =>
    (Object.create(SellerRequestHandler.prototype) as { _executeRequest: (p: Partial<Provider>, r: SerializedHttpRequest, c?: SellerCost, s?: ProviderStreamCallbacks) => Promise<SerializedHttpResponse> })
      ._executeRequest(provider, req, cost, callbacks);

  it('carry the seller\'s price in a JSON response', async () => {
    const response = await execute({ handleRequest: async () => ({ requestId: 'r1', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encode(upstreamCompletion) }) });
    expect(JSON.parse(decode(response.body)).usage.estimated_cost).toBe(0.0018);
  });

  it('carry it in a stream, and return exactly the bytes the buyer was sent', async () => {
    const usageEvent = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 9e-7 } })}\n\n`;
    const parts = ['data: {"choices":[]}\n', '\n' + usageEvent.slice(0, 20), usageEvent.slice(20) + 'data: [DONE]\n\n'];
    const sent: SerializedHttpResponseChunk[] = [];
    const response = await execute({
      handleRequest: async () => { throw new Error('unused'); },
      handleRequestStream: async (_request, callbacks) => {
        const start = { requestId: 'r1', statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: new Uint8Array(0) };
        callbacks.onResponseStart(start);
        parts.forEach((part, index) => callbacks.onResponseChunk({ requestId: 'r1', data: encode(part), done: index === parts.length - 1 }));
        return { ...start, body: encode(parts.join('')) };
      },
    }, { onResponseStart: () => {}, onResponseChunk: (chunk) => { sent.push(chunk); } });
    const delivered = sent.map((chunk) => decode(chunk.data)).join('');
    expect(delivered).toContain('"estimated_cost":0.0018');
    expect(delivered).not.toContain('9e-7');
    expect(sent.at(-1)?.done).toBe(true);
    expect(decode(response.body)).toBe(delivered);
  });

  it('carry it in a stream without a content type to a request that accepts one', async () => {
    const usageEvent = `data: ${JSON.stringify({ choices: [], provider: 'SomeHost', usage: { prompt_tokens: 600, completion_tokens: 300, cost: 0.0001, estimated_cost: 9e-7 } })}\n\n`;
    const sent: SerializedHttpResponseChunk[] = [];
    const stream = (headers: Record<string, string>) => async (_request: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => {
      const start = { requestId: 'r1', statusCode: 200, headers, body: new Uint8Array(0) };
      callbacks.onResponseStart(start);
      callbacks.onResponseChunk({ requestId: 'r1', data: encode(usageEvent), done: true });
      return { ...start, body: encode(usageEvent) };
    };
    const callbacks: ProviderStreamCallbacks = { onResponseStart: () => {}, onResponseChunk: (chunk) => { sent.push(chunk); } };
    const sse = { ...request, headers: { Accept: 'text/event-stream' } };
    const response = await execute({ handleRequest: async () => { throw new Error('unused'); }, handleRequestStream: stream({ 'x-antseed-streaming': '1' }) }, callbacks, sse);
    const delivered = sent.map((chunk) => decode(chunk.data)).join('');
    expect(delivered).toContain('"estimated_cost":0.0018');
    expect(delivered).not.toContain('"cost":');
    expect(delivered).not.toContain('SomeHost');
    expect(decode(response.body)).toBe(delivered);

    // A binary download without a content type passes through byte for byte.
    sent.length = 0;
    await execute({ handleRequest: async () => { throw new Error('unused'); }, handleRequestStream: stream({ 'x-antseed-streaming': '1' }) }, callbacks);
    expect(decode(sent[0]!.data)).toBe(usageEvent);
  });

  it('carry it in JSON a provider streams, sent whole instead of streamed', async () => {
    const bytes = encode(upstreamCompletion);
    const sent: SerializedHttpResponseChunk[] = [];
    let started = false;
    const response = await execute({
      handleRequest: async () => { throw new Error('unused'); },
      handleRequestStream: async (_request, callbacks) => {
        const start = { requestId: 'r1', statusCode: 200, headers: { 'content-type': 'application/json' }, body: bytes.slice(0, 10) };
        callbacks.onResponseStart(start);
        callbacks.onResponseChunk({ requestId: 'r1', data: bytes.slice(10), done: true });
        return { ...start, body: bytes };
      },
    }, { onResponseStart: () => { started = true; }, onResponseChunk: (chunk) => { sent.push(chunk); } });
    expect(started).toBe(false);
    expect(sent).toEqual([]);
    expect(JSON.parse(decode(response.body)).usage).toEqual({ prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 });
  });

  it('carry it in a whole event stream a provider returns', async () => {
    const usageEvent = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, cost: 0.0001 } })}\n\ndata: [DONE]\n\n`;
    const response = await execute({ handleRequest: async () => ({ requestId: 'r1', statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: encode(usageEvent) }) });
    expect(decode(response.body)).toBe(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 } })}\n\ndata: [DONE]\n\n`);
  });

  it('carry it in an event stream whose start already holds events', async () => {
    const usageEvent = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 600, completion_tokens: 300, cost: 0.0001 } })}\n\n`;
    let startBody = '';
    const sent: SerializedHttpResponseChunk[] = [];
    const response = await execute({
      handleRequest: async () => { throw new Error('unused'); },
      handleRequestStream: async (_request, callbacks) => {
        const start = { requestId: 'r1', statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: encode(usageEvent) };
        callbacks.onResponseStart(start);
        callbacks.onResponseChunk({ requestId: 'r1', data: encode('data: [DONE]\n\n'), done: true });
        return { ...start, body: encode(usageEvent + 'data: [DONE]\n\n') };
      },
    }, { onResponseStart: (start) => { startBody = decode(start.body); }, onResponseChunk: (chunk) => { sent.push(chunk); } });
    expect(startBody).toContain('"estimated_cost":0.0018');
    expect(startBody).not.toContain('"cost":');
    expect(decode(response.body)).toBe(startBody + sent.map((chunk) => decode(chunk.data)).join(''));
  });

  it('carry it even when the buyer marks a normal request as a video download', async () => {
    const marked = { ...request, headers: { 'x-antseed-video-download': 'video-stream-v1' } };
    const response = await execute({ handleRequest: async () => ({ requestId: 'r1', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encode(upstreamCompletion) }) }, undefined, marked);
    const body = JSON.parse(decode(response.body));
    expect(body.usage).toEqual({ prompt_tokens: 600, completion_tokens: 300, estimated_cost: 0.0018 });
    expect(body.provider).toBeUndefined();
  });
});
