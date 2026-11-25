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
  const imageModel: UnitBillingModelV1 = { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] };
  const capture = (path: string, n?: number) => captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40), provider: 'openai', service: 'image', serviceApiProtocol: 'openai-images',
    request: { requestId: 'r', method: 'POST', path, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'image', prompt: 'A tree', stream: true, ...(n ? { n } : {}) })) },
  });
  /** An answer streamed as OpenAI streams images: an `event:` line, then the event as JSON data. */
  const stream = (events: Array<Record<string, unknown>>) => ({
    requestId: 'r', statusCode: 200, headers: { 'content-type': 'text/event-stream' },
    body: new TextEncoder().encode(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')),
  });
  const bill = (path: string, events: Array<Record<string, unknown>>, n?: number) => {
    const captured = capture(path, n);
    return computeFinalUnitBilling(imageModel, captured.context, stream(events), captured.requestFacts);
  };
  const usage = { input_tokens: 50, output_tokens: 4160, total_tokens: 4210 };

  it('bills the final images of a stream, not its partial previews', () => {
    const billed = bill('/v1/images/generations', [
      { type: 'image_generation.partial_image', b64_json: 'cGFydA==', partial_image_index: 0 },
      { type: 'image_generation.partial_image', b64_json: 'cGFydA==', partial_image_index: 1 },
      { type: 'image_generation.completed', b64_json: 'aW1hZ2U=', usage },
    ]);
    expect({ cost: billed.costUsdc, units: billed.usage.units }).toEqual({ cost: 40_000n, units: { output_images: 1 } });
  });

  it('bills an edit stream the same way', () => {
    const billed = bill('/v1/images/edits', [
      { type: 'image_edit.partial_image', b64_json: 'cGFydA==', partial_image_index: 0 },
      { type: 'image_edit.completed', b64_json: 'aW1hZ2U=', usage },
    ]);
    expect(billed.costUsdc).toBe(40_000n);
  });

  it('bills no more images than the request asked for', () => {
    const completed = { type: 'image_generation.completed', b64_json: 'aW1hZ2U=' };
    expect(bill('/v1/images/generations', [completed, completed], 2).costUsdc).toBe(80_000n);
    expect(bill('/v1/images/generations', [completed, completed, completed], 2).costUsdc).toBe(80_000n);
  });

  it('bills nothing for a stream that carried no final image', () => {
    for (const events of [
      [{ type: 'image_generation.partial_image', b64_json: 'cGFydA==' }],
      [{ type: 'image_generation.completed', b64_json: '' }],
      [{ type: 'image_generation.failed', b64_json: 'aW1hZ2U=' }],
      [{ error: { message: 'The image could not be made' } }],
    ]) {
      expect(bill('/v1/images/generations', events).costUsdc, JSON.stringify(events)).toBe(0n);
    }
    // Two images as two data lines of one event join into no JSON a client can read: no image.
    const joined = capture('/v1/images/generations', 2);
    const twoLines = { requestId: 'r', statusCode: 200, headers: {}, body: new TextEncoder().encode(`event: image_generation.completed\ndata: ${JSON.stringify({ type: 'image_generation.completed', b64_json: 'aW1hZ2U=' })}\ndata: ${JSON.stringify({ type: 'image_generation.completed', b64_json: 'aW1hZ2U=' })}\n\n`) };
    expect(computeFinalUnitBilling(imageModel, joined.context, twoLines, joined.requestFacts).costUsdc).toBe(0n);
    // The `event:` line alone names no image: the data has to say what it is.
    const captured = capture('/v1/images/generations');
    const named = { requestId: 'r', statusCode: 200, headers: {}, body: new TextEncoder().encode('event: image_generation.completed\ndata: {"b64_json":"aW1hZ2U="}\n\n') };
    expect(computeFinalUnitBilling(imageModel, captured.context, named, captured.requestFacts).costUsdc).toBe(0n);
  });

  it('bills no image for an event a client could not read', () => {
    const completed = JSON.stringify({ type: 'image_generation.completed', b64_json: 'aW1hZ2U=' });
    for (const [why, text] of [
      // A client joins the event's data lines into one payload, which is not JSON.
      ['a final image followed by a line that is not JSON', `event: image_generation.completed\ndata: ${completed}\ndata: not json\n\n`],
      // A client drops an event the stream ended inside, before its closing blank line.
      ['a final image the stream ended inside', `event: image_generation.completed\ndata: ${completed}\n`],
    ]) {
      const captured = capture('/v1/images/generations');
      const response = { requestId: 'r', statusCode: 200, headers: {}, body: new TextEncoder().encode(text) };
      expect(computeFinalUnitBilling(imageModel, captured.context, response, captured.requestFacts).costUsdc, why).toBe(0n);
    }
  });

  it('bills the images that arrived before a stream was cut', () => {
    const billed = bill('/v1/images/generations', [
      { type: 'image_generation.completed', b64_json: 'aW1hZ2U=' },
      { type: 'error', error: { message: 'Upstream stream ended early' } },
    ], 2);
    expect(billed.costUsdc).toBe(40_000n);
  });

  it('reads the tokens of a streamed answer', () => {
    const captured = capture('/v1/images/generations');
    const measured = extractUnitResponseUsage('openai-images', stream([{ type: 'image_generation.completed', b64_json: 'aW1hZ2U=', usage }]), captured.requestFacts);
    expect(measured.tokenUsage).toMatchObject({ inputTokens: 50, outputTokens: 4160 });
  });
});
