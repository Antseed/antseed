import { describe, it, expect } from 'vitest';
import { AbiCoder, Wallet, getAddress } from 'ethers';
import { createResponseAuthPayload } from '@antseed/buyer-core';
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/protocol/request-codec';
import {
  isShapeRequest,
  jsonSafeContent,
  pairDelta,
  promptTokensOfBody,
  receiptPromptTokens,
  receiptTuple,
  roundTuple,
  shapeRequestBody,
  tokenizerServiceHash,
  type SignedReceipt,
} from './tokenizer-audits-client.js';

const seller = new Wallet('0x' + '11'.repeat(32));
const buyer = new Wallet('0x' + '22'.repeat(32));
const SHAPE = { path: '/v1/chat/completions', head: '{"model":"', mid: '","messages":[{"role":"user","content":"', tail: '"}],"max_tokens":64}' };
const encoder = new TextEncoder();

function signed(requestId: string, requestBody: string, responseBody: string, statusCode = 200, path = SHAPE.path): SignedReceipt {
  const request = { requestId, method: 'POST', path, headers: { 'content-type': 'application/json' }, body: encoder.encode(requestBody) };
  const response = { requestId, statusCode, headers: { 'content-type': 'application/json' }, body: encoder.encode(responseBody) };
  const payload = createResponseAuthPayload({
    request, response, buyerPeerId: buyer.address, sellerPeerId: seller.address, advertisedService: 'example-model',
    provider: 'openai', responseStartedAt: 1, responseCompletedAt: 2,
  }, seller);
  return { payload, request: encodeHttpRequest(request), response: encodeHttpResponse(response) };
}

const usage = (tokens: number) => JSON.stringify({ usage: { prompt_tokens: tokens, completion_tokens: 2 } });

describe('promptTokensOfBody', () => {
  const read = (body: string) => promptTokensOfBody(encoder.encode(body));

  it('reads OpenAI prompt_tokens, with or without spaces', () => {
    expect(read('{"usage":{"prompt_tokens":15,"completion_tokens":3}}')).toBe(15);
    expect(read('{"usage": {"prompt_tokens" :  67, "total_tokens": 70}}')).toBe(67);
  });

  it('adds Anthropic cache tokens to input_tokens', () => {
    expect(read('{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}')).toBe(16);
    expect(read('{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4}}}')).toBe(12);
  });

  it('ignores usage keys quoted inside answer text', () => {
    expect(read('{"choices":[{"message":{"content":"\\"prompt_tokens\\": 999"}}],"usage":{"prompt_tokens":15}}')).toBe(15);
  });

  it('reads only the top-level usage object, as a Responses answer needs', () => {
    expect(read('{"object":"response","output":[{"content":[{"text":"{\\"usage\\":{\\"input_tokens\\":7}}"}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"items":{"m":{"input_tokens":2}}},"tool_usage":{"image_gen":{"input_tokens":0}},"x":{"prompt_tokens":20}}')).toBe(12);
  });

  it('reads whole integer token counts only, as the contract does', () => {
    expect(read('{"usage":{"prompt_tokens": 1000 }}')).toBe(1000);
    expect(read('{"usage":{"prompt_tokens":1e3}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":15.0,"completion_tokens":2}}')).toBeNull();
    expect(read('{"usage":{"input_tokens":12x}}')).toBeNull();
  });

  it('refuses ambiguous or missing usage, as the contract does', () => {
    expect(read('{"usage":{"prompt_tokens":15,"prompt_tokens":20}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":15},"usage":{"prompt_tokens":20}}')).toBeNull();
    expect(read('{"x":{"usage":{"prompt_tokens":15}}}')).toBeNull();
    expect(read('{"usage":{"completion_tokens":15}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":1234567890123456}}')).toBeNull();
  });
});

describe('request shapes', () => {
  it('builds the shape body and recognizes it in a signed receipt', () => {
    const a = 'Plan a trip to Lisbon?';
    const b = ' Budget 450 € 😅';
    const body = shapeRequestBody(SHAPE, 'example-model', a + b);
    expect(JSON.parse(body)).toEqual({ model: 'example-model', messages: [{ role: 'user', content: a + b }], max_tokens: 64 });
    const base = signed('a', shapeRequestBody(SHAPE, 'example-model', a), usage(20));
    const probed = signed('b', body, usage(149));
    expect(isShapeRequest(base, SHAPE, a)).toBe(true);
    expect(isShapeRequest(probed, SHAPE, a + b)).toBe(true);
    expect(isShapeRequest(probed, SHAPE, a)).toBe(false);
    expect(pairDelta({ shapeId: '0x', base, probed })).toBe(129);
  });

  it('needs the shape path as well as its body', () => {
    const elsewhere = signed('a', shapeRequestBody(SHAPE, 'example-model', 'x'), usage(15), 200, '/v1/responses');
    expect(isShapeRequest(elsewhere, SHAPE, 'x')).toBe(false);
  });

  it('keeps generated text inside the JSON string', () => {
    const text = jsonSafeContent('He said "hi"\nthen C:\\path and "x');
    expect(text).not.toMatch(/["\\\n]/);
    expect(JSON.parse(shapeRequestBody(SHAPE, 'm', text)).messages[0].content).toBe(text);
  });

  it('reads no tokens from a failed response', () => {
    expect(receiptPromptTokens(signed('a', shapeRequestBody(SHAPE, 'example-model', 'x'), usage(15), 500))).toBeNull();
  });

  it('encodes rounds as the contract tuple', () => {
    const pair = { shapeId: '0x' + 'ab'.repeat(32), base: signed('a', shapeRequestBody(SHAPE, 'example-model', 'x'), usage(15)), probed: signed('b', shapeRequestBody(SHAPE, 'example-model', 'xy'), usage(16)) };
    expect(receiptTuple(pair.base)[4]).toBe(getAddress(seller.address));
    const RECEIPT = 'tuple(uint32,string,string,address,address,string,string,uint16,uint64,uint64,bytes,bytes,bytes)';
    const PAIR = `tuple(bytes32,${RECEIPT},${RECEIPT})`;
    const encoded = AbiCoder.defaultAbiCoder().encode(
      [`tuple(bytes,bytes,${PAIR},${PAIR}[])`],
      [roundTuple({ a: 'x', b: 'y', suspect: pair, references: [pair, pair, pair] })],
    );
    expect(encoded.length).toBeGreaterThan(2);
  });
});

describe('tokenizerServiceHash', () => {
  it('trims and lowercases like the results layer', () => {
    expect(tokenizerServiceHash('  Example-Model ')).toBe(tokenizerServiceHash('example-model'));
  });
});
