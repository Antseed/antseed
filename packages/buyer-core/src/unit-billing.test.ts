import { describe, expect, it } from 'vitest';
import type { UnitBillingContext, UnitBillingModelV1 } from '@antseed/protocol/billing';
import { validateUnitBillingUsage } from '@antseed/protocol/billing';
import {
  captureUnitBillingContext,
  computeFinalUnitBilling,
  estimateUnitRequestCost,
  extractUnitResponseUsage,
  isUnitBilledProtocol,
  validateUnitBillingModelForProtocolV1,
} from './unit-billing.js';

const videoModel: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] };
const response = (body: object, statusCode = 200) => ({
  requestId: 'request',
  statusCode,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(body)),
});

function capture(
  path = '/api/v1/video/queue',
  body: object = { model: 'wan-2.5', duration: '8s' },
  method = 'POST',
) {
  return captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'venice',
    service: 'wan-2.5',
    serviceApiProtocol: 'venice-video',
    request: {
      requestId: 'request',
      method,
      path,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    },
  });
}

describe('acceptance-based video metering', () => {
  it('bills the requested duration once on acceptance, not on retrieve', () => {
    const captured = capture();
    expect(computeFinalUnitBilling(videoModel, captured.context, response({ queue_id: 'task' }), captured.requestFacts).costUsdc).toBe(800000n);
    const followUp = capture('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'task' });
    expect(computeFinalUnitBilling(videoModel, followUp.context, response({ status: 'SUCCEEDED' }), followUp.requestFacts).costUsdc).toBe(0n);
  });

  it('rejects missing duration and unmatched tiers before submission', () => {
    const missing = capture('/api/v1/video/queue', { model: 'wan-2.5' });
    expect(() => estimateUnitRequestCost(videoModel, missing.context, missing.requestUsage)).toThrow(/duration/);
    const captured = capture();
    const tier: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '1080p' } }] };
    expect(() => estimateUnitRequestCost(tier, captured.context, captured.requestUsage)).toThrow(/No billing component/);
  });

  it('rejects non-video requests priced with a video protocol', () => {
    expect(() => capture('/v1/images/generations', { model: 'wan-2.5' })).toThrow(/native video request/);
  });

  it('allows fixed per-generation prices without duration', () => {
    const captured = capture('/api/v1/video/queue', { model: 'wan-2.5' });
    const fixed: UnitBillingModelV1 = { version: 1, components: [{ unit: 'video_generations', priceUsd: 0.5 }] };
    expect(computeFinalUnitBilling(fixed, captured.context, response({ queue_id: 'task' }), captured.requestFacts).costUsdc).toBe(500000n);
  });

  it('charges zero for rejected or malformed acceptances and rejects inflated reports', () => {
    const captured = capture();
    for (const rejected of [response({ queue_id: 'task' }, 400), response({}), response({ queue_id: 'task', error: 'failed' })]) {
      expect(computeFinalUnitBilling(videoModel, captured.context, rejected, captured.requestFacts).costUsdc).toBe(0n);
    }
    expect(() => validateUnitBillingUsage(
      videoModel,
      captured.context,
      { version: 1, units: { video_seconds: '9' } },
      900000n,
      1,
      { units: { video_seconds: 8 } },
    )).toThrow();
  });
});

describe('unit billing adapters', () => {
  const imageContext: UnitBillingContext = {
    sellerPeerId: 'a'.repeat(40),
    provider: 'openai',
    service: 'image',
    serviceApiProtocol: 'openai-images',
  };

  it('bills one completed request per well-formed routing response', () => {
    const model: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] };
    const context: UnitBillingContext = { ...imageContext, serviceApiProtocol: 'irp-suggest', unitLimits: { completed_requests: 1 } };
    const response = (statusCode: number, body: unknown) => ({
      requestId: 'r', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)),
    });
    const ranked = { id: 'r', object: 'routing.ranking', created: 1, router: { id: 'a', version: '1' }, ranked: [{ candidate_id: 'c' }] };

    expect(isUnitBilledProtocol('irp-suggest')).toBe(true);
    expect(validateUnitBillingModelForProtocolV1('irp-suggest', model)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', model)).toEqual(['completed_requests is not supported for openai-images']);
    const facts = { kind: 'routing' as const, protocol: 'irp-suggest' as const, candidateIds: ['c', 'd'] };
    const cost = (statusCode: number, body: unknown) => computeFinalUnitBilling(model, context, response(statusCode, body), facts).costUsdc;
    expect(cost(200, ranked)).toBe(1_000n);
    expect(cost(200, { ...ranked, ranked: [{ candidate_id: 'nope' }, null, { candidate_id: 'd' }] })).toBe(1_000n);
    expect(cost(200, { ...ranked, ranked: [] })).toBe(0n);
    expect(cost(200, 'garbage')).toBe(0n);
    expect(cost(500, ranked)).toBe(0n);
    // Rankings the buyer's client rejects are never billable.
    expect(cost(200, { ...ranked, ranked: [null] })).toBe(0n);
    expect(cost(200, { ...ranked, ranked: [{ candidate_id: 'nope' }] })).toBe(0n);
    expect(cost(200, { object: 'routing.ranking', ranked: [{ candidate_id: 'c' }] })).toBe(0n);
    expect(computeFinalUnitBilling(model, context, response(200, ranked), { kind: 'routing', protocol: 'irp-suggest', candidateIds: [] }).costUsdc).toBe(0n);
  });

  it('captures the candidate ids a rank request sends as its routing billing facts', () => {
    const body = { request: { messages: [] }, routing: { candidates: [{ id: 'c' }, { id: 7 }, null, { id: 'd' }] } };
    const captured = captureUnitBillingContext({
      sellerPeerId: 'a'.repeat(40), provider: 'alpha', service: 'alpha-route', serviceApiProtocol: 'irp-suggest',
      request: { requestId: 'r', method: 'POST', path: '/v1/routing/rank', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) },
    });
    expect(captured.requestFacts).toEqual({ kind: 'routing', protocol: 'irp-suggest', candidateIds: ['c', 'd'] });
  });

  it('routes image and Venice video billing through their adapters', () => {
    const image: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };

    expect(isUnitBilledProtocol('openai-images')).toBe(true);
    expect(isUnitBilledProtocol('venice-video')).toBe(true);
    expect(isUnitBilledProtocol('openai-responses')).toBe(false);
    expect(validateUnitBillingModelForProtocolV1('openai-images', image)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('venice-video', videoModel)).toEqual([]);
    expect(validateUnitBillingModelForProtocolV1('openai-images', videoModel)).toEqual(['video_seconds is not supported for openai-images']);
    expect(estimateUnitRequestCost(image, imageContext, { units: { output_images: 2 } })).toBe(80_000n);
  });

  it('measures only with an explicit, matching protocol', () => {
    const video = capture();
    expect(() => extractUnitResponseUsage('openai-responses', response({}), video.requestFacts)).toThrow('Unit billing is not supported for openai-responses');
    expect(() => extractUnitResponseUsage('openai-images', response({ data: [{ b64_json: 'x' }] }), video.requestFacts)).toThrow('image billing cannot measure video request facts');
    expect(extractUnitResponseUsage('venice-video', response({ queue_id: 'task' }), video.requestFacts).usage).toEqual({ units: { video_generations: 1, video_seconds: 8 } });
  });

  it('fails closed for completed-request billing', () => {
    const completed: UnitBillingModelV1 = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.1 }] };
    expect(validateUnitBillingModelForProtocolV1('openai-images', completed)).toEqual(['completed_requests is not supported for openai-images']);
    expect(() => estimateUnitRequestCost(completed, imageContext, { units: { completed_requests: 1 } })).toThrow('completed_requests is not supported for openai-images');
  });
});

describe('streamed image answers', () => {
  const encoder = new TextEncoder();
  const capture = (serviceApiProtocol: 'openai-images' | 'openai-chat-completions', path: string, body: unknown) => captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40), provider: 'openai', service: 'image', serviceApiProtocol,
    request: { requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
  });

  it('refuses before the request an image request that asks for a stream, which it could not count', () => {
    for (const stream of [true, 'true', 1]) {
      expect(() => capture('openai-images', '/v1/images/generations', { model: 'image', prompt: 'A tree', stream }), String(stream)).toThrow(/"stream"/);
    }
    for (const key of ['Stream', 'STREAM', '\u017ftream', ' stream', 'stream[]', 'str\u200beam', 'str\u00adeam', '\uff53\uff54\uff52\uff45\uff41\uff4d']) {
      expect(() => capture('openai-images', '/v1/images/generations', { model: 'image', prompt: 'A tree', [key]: true }), JSON.stringify(key)).toThrow(/"stream"/);
    }
    expect(capture('openai-images', '/v1/images/generations', { model: 'image', prompt: 'A tree', stream: false }).context.unitLimits).toEqual({ output_images: 1 });
  });

  it('refuses values not every reader takes as false, as a buyer fault', () => {
    for (const stream of ['false', 0, '']) {
      expect(() => capture('openai-images', '/v1/images/generations', { model: 'image', prompt: 'A tree', stream }), JSON.stringify(stream)).toThrow(expect.objectContaining({ code: 'invalid-request', attribution: 'buyer' }));
    }
  });

  it('refuses a form that names a stream field in any way a lenient parser reads it', () => {
    const form = (part: string) => [
      '--b\r\nContent-Disposition: form-data; name="model"\r\n\r\nimage\r\n',
      `--b\r\nContent-Disposition: form-data; ${part}`,
      '--b--\r\n',
    ].join('');
    for (const part of [
      'name="stream"\r\n\r\nfalse\r\n',
      'name=stream\r\n\r\ntrue\r\n',
      "name*=utf-8''stream\r\n\r\ntrue\r\n",
      'name="stream"; filename=""\r\n\r\ntrue\r\n',
      `name="Stream"\r\n\r\n${' '.repeat(5000)}true\r\n`,
    ]) {
      const request = { requestId: 'r', method: 'POST', path: '/v1/images/edits', headers: { 'content-type': 'multipart/form-data; boundary=b' }, body: encoder.encode(form(part)) };
      expect(() => captureUnitBillingContext({ sellerPeerId: 'a'.repeat(40), provider: 'openai', service: 'image', serviceApiProtocol: 'openai-images', request }), part).toThrow(/"stream"/);
    }
  });

  it('leaves a streamed chat request to token billing', () => {
    expect(capture('openai-chat-completions', '/v1/chat/completions', { model: 'chat', messages: [], stream: true }).requestFacts.kind).toBe('image');
  });
});
