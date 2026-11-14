import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, selectBillingRoute, stripPeerControlledResponseHeaders } from './buyer-request-handler.js';
import { ConnectionState, toPeerId } from '@antseed/protocol';
import type { BuyerPeerView, ResponseAuthContext, StoredResponseAuth } from './interfaces.js';
import { hashRequest } from './response-auth.js';
import { faultCodeOf } from './errors.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '@antseed/protocol/messages';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';

const VIDEO_MODEL = {
  version: 1 as const,
  components: [{ unit: 'video_generations' as const, priceUsd: 4.2 }],
};

function makePeer(): BuyerPeerView {
  return {
    peerId: toPeerId('5'.repeat(40)),
    providers: ['venice'],
    providerServiceApiProtocols: { venice: { services: { 'video-model': ['venice-video'] } } },
    providerServiceUnitBillingModels: { venice: { services: { 'video-model': { 'venice-video': VIDEO_MODEL } } } },
  };
}

function makeRequest(headers: Record<string, string> = {}): SerializedHttpRequest {
  return {
    requestId: 'video-request',
    method: 'POST',
    path: '/api/v1/video/queue',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify({ model: 'video-model', prompt: 'cat', duration: '5s' })),
  };
}

function response(statusCode: number, body: unknown): SerializedHttpResponse {
  return {
    requestId: 'video-request',
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  };
}

const PAYMENT_REQUIRED = response(402, {
  error: 'payment_required',
  code: 'one_off_channel_required',
  minBudgetPerRequest: '10000',
  suggestedAmount: '1000000',
  oneOffPlan: {
    openingReserveAmount: '1000000',
    requiredCumulativeAmount: '650000',
    requestCost: '4200000',
  },
});
const ACCEPTED = response(200, { queue_id: 'new-job' });

function makeHandler(responses: SerializedHttpResponse[], freeTierDelegationsHeader?: () => string | null, channelBinding: string | null = null) {
  const queue = [...responses];
  const sendProxyRequest = vi.fn((
    _request: SerializedHttpRequest,
    onResponse: (value: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
  ) => onResponse(queue.shift() ?? responses.at(-1)!, { streamingStart: false }));
  const handle402 = vi.fn(async () => ({ action: 'retry' as const }));
  const negotiator = {
    getOrCreatePaymentMux: vi.fn(() => ({})),
    trackRequestBillingContext: vi.fn(),
    trackFreeUsageRequestService: vi.fn(),
    prepareFreeUsageOpen: vi.fn(async () => {}),
    estimateCostFromResponse: vi.fn(),
    bpm: { clearRequestBilling: vi.fn(), markRequestCovered: vi.fn(), releaseRequestCoverage: vi.fn(), beginPaidRequest: vi.fn(), endPaidRequest: vi.fn() },
    handle402,
    applyExternalSpendingAuth: vi.fn(async () => {}),
  };
  const connection = { state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn(), channelBinding };
  const handler = new BuyerRequestHandler({}, {
    localPeerId: toPeerId('4'.repeat(40)),
    negotiator: negotiator as never,
    verificationStorage: null,
    verificationSampler: null,
    getConnection: async () => connection as never,
    getMux: () => ({ sendProxyRequest, cancelProxyRequest: vi.fn(), activeRequestCount: () => 2 } as never),
    getVerificationMux: () => ({ waitForResponseAuth: vi.fn(() => new Promise(() => {})) } as never),
    registerPaymentMux: vi.fn(),
    ...(freeTierDelegationsHeader ? { freeTierDelegationsHeader } : {}),
  });
  return { handler, handle402, sendProxyRequest, negotiator };
}

describe('BuyerRequestHandler TEE connection binding', () => {
  it('sends on the connection a TEE attestation was bound to', async () => {
    const { handler, sendProxyRequest } = makeHandler([response(200, {})], undefined, 'c'.repeat(64));
    expect((await handler.sendRequest(makePeer(), makeRequest(), undefined, { channelBinding: 'c'.repeat(64) })).statusCode).toBe(200);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('refuses before sending when the connection is not the attested one', async () => {
    for (const binding of ['d'.repeat(64), null]) {
      const { handler, sendProxyRequest } = makeHandler([response(200, {})], undefined, binding);
      const err = await handler.sendRequest(makePeer(), makeRequest(), undefined, { channelBinding: 'c'.repeat(64) }).catch((e: unknown) => e);
      expect(faultCodeOf(err)).toBe('buyer-tee-connection-changed');
      expect(sendProxyRequest).not.toHaveBeenCalled();
    }
  });
});

describe('BuyerRequestHandler payment negotiation', () => {
  it.each([400, 409, 500, 503])('returns a non-payment response without negotiation (%s)', async (statusCode) => {
    const { handler, handle402, sendProxyRequest } = makeHandler([response(statusCode, { error: 'rejected' })]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(statusCode);
    expect(handle402).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('handles one payment-required response and retries the request once', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([PAYMENT_REQUIRED, ACCEPTED]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('surfaces a repeated payment requirement after the single retry', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([PAYMENT_REQUIRED, PAYMENT_REQUIRED]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(402);
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('prices the response it received before the attempt ends, and prices nothing for a 402 it retries', async () => {
    const { handler, negotiator } = makeHandler([PAYMENT_REQUIRED, ACCEPTED]);
    const peer = makePeer();
    const request = makeRequest();
    const steps: string[] = [];
    negotiator.bpm.beginPaidRequest.mockImplementation(() => { steps.push('begin'); });
    negotiator.bpm.endPaidRequest.mockImplementation((_peer: string, requestId: string) => { steps.push(`end ${requestId}`); });
    negotiator.estimateCostFromResponse.mockImplementation((_peer: unknown, answer: SerializedHttpResponse) => { steps.push(`price ${answer.statusCode}`); });

    await handler.sendRequest(peer, request);
    // The seller's NeedAuth for the request is judged against the priced
    // response, so pricing comes before the attempt is reported as ended.
    expect(steps).toEqual(['begin', `end ${request.requestId}`, 'begin', 'price 200', `end ${request.requestId}`]);
  });

  it('bounds what the seller may bill only for an attempt the caller gave up, not one the seller can end itself', async () => {
    for (const ending of ['caller abort', 'abort with an error', 'timeout', 'closed connection'] as const) {
      const { negotiator } = makeHandler([]);
      const estimateCostFromPartialResponse = vi.fn();
      let reportState: (state: ConnectionState) => void = () => {};
      const connection = {
        state: ConnectionState.Connected, send: vi.fn(), off: vi.fn(), channelBinding: null,
        on: vi.fn((_event: string, listener: (state: ConnectionState) => void) => { reportState = listener; }),
      };
      // The seller never answers.
      const handler = new BuyerRequestHandler({ requestTimeoutMs: ending === 'timeout' ? 20 : 60_000 }, {
        localPeerId: toPeerId('4'.repeat(40)),
        negotiator: { ...negotiator, estimateCostFromPartialResponse } as never,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: async () => connection as never,
        getMux: () => ({ sendProxyRequest: vi.fn(), cancelProxyRequest: vi.fn(), activeRequestCount: () => 1 } as never),
        getVerificationMux: () => ({}) as never,
        registerPaymentMux: vi.fn(),
      });
      const abort = new AbortController();
      const request = makeRequest();
      const pending = handler.sendRequest(makePeer(), request, undefined, { signal: abort.signal });
      setTimeout(() => {
        if (ending === 'caller abort') abort.abort();
        if (ending === 'abort with an error') abort.abort(new Error('no answer within 4s'));
        if (ending === 'closed connection') reportState(ConnectionState.Closed);
      }, 5);
      await expect(pending).rejects.toThrow();
      expect(estimateCostFromPartialResponse, ending).toHaveBeenCalledTimes(ending === 'caller abort' ? 1 : 0);
      expect(negotiator.bpm.endPaidRequest, ending).toHaveBeenCalledWith(makePeer().peerId, request.requestId, false);
    }
  });

  it('bounds nothing for an attempt the caller gave up before it was sent', async () => {
    const { negotiator } = makeHandler([]);
    const estimateCostFromPartialResponse = vi.fn();
    const sendProxyRequest = vi.fn();
    const handler = new BuyerRequestHandler({}, {
      localPeerId: toPeerId('4'.repeat(40)),
      negotiator: { ...negotiator, estimateCostFromPartialResponse } as never,
      verificationStorage: null,
      verificationSampler: null,
      getConnection: async () => ({ state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn(), channelBinding: null }) as never,
      getMux: () => ({ sendProxyRequest, cancelProxyRequest: vi.fn(), activeRequestCount: () => 1 } as never),
      getVerificationMux: () => ({}) as never,
      registerPaymentMux: vi.fn(),
    });
    const abort = new AbortController();
    abort.abort();
    await expect(handler.sendRequest(makePeer(), makeRequest(), undefined, { signal: abort.signal })).rejects.toThrow(/aborted/);
    // The seller never saw it, so it has nothing to bill.
    expect(sendProxyRequest).not.toHaveBeenCalled();
    expect(estimateCostFromPartialResponse).not.toHaveBeenCalled();
  });

  const catchUp = (required: string, accepted: string) => response(402, {
    error: 'payment_required',
    minBudgetPerRequest: '10000',
    suggestedAmount: '1000000',
    requiredCumulativeAmount: required,
    currentAcceptedCumulative: accepted,
    reserveMaxAmount: '1000000',
  });

  it('keeps catching up while the seller catch-up gap shrinks', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('500000', '400000'), ACCEPTED,
    ]);

    expect((await handler.sendRequest(makePeer(), makeRequest())).statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledTimes(2);
    // Counts the in-flight requests to the seller, including this one.
    expect(handle402).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), 3);
    expect(sendProxyRequest).toHaveBeenCalledTimes(3);
  });

  it('returns a buyer error instead of the seller 402 when catch-up stays short', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('500000', '300000'), catchUp('500000', '450000'),
    ]);

    const result = await handler.sendRequest(makePeer(), makeRequest());
    // Retryable: the channel is fine and the next attempt usually succeeds.
    expect(result.statusCode).toBe(503);
    expect(result.headers['retry-after']).toBe('2');
    const body = Buffer.from(result.body).toString();
    expect(JSON.parse(body)).toMatchObject({ error: { type: 'payment_negotiation_failed' } });
    expect(body).not.toContain('requiredCumulativeAmount');
    expect(handle402).toHaveBeenCalledTimes(2);
    expect(sendProxyRequest).toHaveBeenCalledTimes(3);
  });

  it('returns the buyer error without repeating a catch-up that made no progress', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('600000', '100000'),
    ]);

    const result = await handler.sendRequest(makePeer(), makeRequest());
    expect(result.statusCode).toBe(503);
    expect(Buffer.from(result.body).toString()).not.toContain('requiredCumulativeAmount');
    expect(handle402).toHaveBeenCalledOnce();
    expect(sendProxyRequest).toHaveBeenCalledTimes(2);
  });

  it('keeps catching up while the seller accepts more, even when other requests widen the gap', async () => {
    const { handler, handle402, sendProxyRequest } = makeHandler([
      catchUp('500000', '100000'), catchUp('700000', '250000'), ACCEPTED,
    ]);

    const result = await handler.sendRequest(makePeer(), makeRequest());
    expect(result.statusCode).toBe(200);
    expect(handle402).toHaveBeenCalledTimes(2);
    expect(sendProxyRequest).toHaveBeenCalledTimes(3);
  });

  it('does not negotiate for a client-provided spending authorization', async () => {
    const { handler, handle402 } = makeHandler([PAYMENT_REQUIRED]);

    expect((await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-spending-auth': 'client-signed' }))).statusCode).toBe(402);
    expect(handle402).not.toHaveBeenCalled();
  });
});

describe('BuyerRequestHandler free allowance on a priced service', () => {
  const chatPeer = (): BuyerPeerView => ({
    peerId: toPeerId('5'.repeat(40)),
    providers: ['openai'],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
  } as BuyerPeerView);
  const chatRequest = (): SerializedHttpRequest => ({
    requestId: 'chat-request',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'k3', messages: [] })),
  });

  it('expects no charge for a response the seller covered from the allowance', async () => {
    const covered = { ...response(200, { ok: true }), headers: { 'content-type': 'application/json', 'X-Antseed-Free-Tier': 'covered' } };
    const { handler, negotiator } = makeHandler([covered]);
    expect((await handler.sendRequest(chatPeer(), chatRequest())).statusCode).toBe(200);
    expect(negotiator.estimateCostFromResponse).not.toHaveBeenCalled();
    expect(negotiator.bpm.releaseRequestCoverage).toHaveBeenCalledWith(chatPeer().peerId, 'chat-request');
    expect(negotiator.bpm.releaseRequestCoverage.mock.invocationCallOrder[0])
      .toBeLessThan(negotiator.bpm.markRequestCovered.mock.invocationCallOrder[0]!);
    expect(negotiator.bpm.markRequestCovered).toHaveBeenCalledWith(chatPeer().peerId, 'chat-request');
  });

  it('expects the listed price for any other paid response', async () => {
    const { handler, negotiator } = makeHandler([response(200, { ok: true })]);
    await handler.sendRequest(chatPeer(), chatRequest());
    expect(negotiator.estimateCostFromResponse).toHaveBeenCalledOnce();
  });
});

describe('BuyerRequestHandler route priced at zero', () => {
  const peer = (providerPricing: BuyerPeerView['providerPricing'], extra: Partial<BuyerPeerView> = {}): BuyerPeerView => ({
    peerId: toPeerId('5'.repeat(40)),
    providers: ['openai'],
    providerPricing,
    ...extra,
  } as BuyerPeerView);
  const request = (path: string, body: unknown): SerializedHttpRequest => ({
    requestId: 'zero-route-request',
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  });
  const sellerWantsPayment = response(402, { error: 'payment_required', minBudgetPerRequest: '10000', suggestedAmount: '1000000' });
  const ZERO = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };

  it('refuses a payment demand on it without negotiating, and marks the request as owing nothing', async () => {
    const { handler, handle402, sendProxyRequest, negotiator } = makeHandler([sellerWantsPayment, response(200, { ok: true })]);
    const freePeer = peer({ openai: { defaults: ZERO } });

    const answer = await handler.sendRequest(freePeer, request('/v1/chat/completions', { model: 'k3', messages: [] }));

    expect(answer.statusCode).toBe(409);
    // Shaped like any other peer fault, so a router fails over and the caller reads why.
    expect(JSON.parse(Buffer.from(answer.body).toString()).error).toMatchObject({
      type: 'payment_negotiation_failed',
      antseed_fault: 'peer',
      peer_status: 409,
      peer_message: expect.stringContaining('announces as free'),
    });
    expect(handle402).not.toHaveBeenCalled();
    expect(sendProxyRequest).toHaveBeenCalledOnce();
    expect(negotiator.bpm.markRequestCovered).toHaveBeenCalledWith(freePeer.peerId, 'zero-route-request');
    expect(negotiator.bpm.releaseRequestCoverage.mock.invocationCallOrder[0])
      .toBeLessThan(negotiator.bpm.markRequestCovered.mock.invocationCallOrder[0]!);
  });

  it('still negotiates when a cached-input price or a per-image price makes the route paid', async () => {
    const cachedPriced = peer({ openai: { defaults: { ...ZERO, cachedInputUsdPerMillion: 0.75 } } });
    const perImage = peer({ openai: { defaults: ZERO } }, {
      providerServiceApiProtocols: { openai: { services: { 'image-model': ['openai-images'] } } },
      providerServiceUnitBillingModels: {
        openai: { services: { 'image-model': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } } } },
      },
    });
    for (const [paidPeer, paidRequest] of [
      [cachedPriced, request('/v1/chat/completions', { model: 'k3', messages: [] })],
      [perImage, request('/v1/images/generations', { model: 'image-model', prompt: 'a cube', n: 1 })],
    ] as const) {
      const { handler, handle402, negotiator } = makeHandler([sellerWantsPayment, response(200, { ok: true })]);
      expect((await handler.sendRequest(paidPeer, paidRequest)).statusCode).toBe(200);
      expect(handle402).toHaveBeenCalledOnce();
      expect(negotiator.bpm.markRequestCovered).not.toHaveBeenCalled();
    }
  });
});

describe('BuyerRequestHandler route with no announced price', () => {
  const peer = (extra: Partial<BuyerPeerView> = {}): BuyerPeerView => ({
    peerId: toPeerId('5'.repeat(40)),
    providers: ['openai'],
    ...extra,
  } as BuyerPeerView);
  const request = (path: string, body: unknown): SerializedHttpRequest => ({
    requestId: 'unpriced-request',
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  });
  const chat = () => request('/v1/chat/completions', { model: 'k3', messages: [] });

  function expectRefusedBeforeSending(
    answer: SerializedHttpResponse,
    { handle402, sendProxyRequest, negotiator }: ReturnType<typeof makeHandler>,
  ) {
    expect(answer.statusCode).toBe(409);
    // Shaped like any other peer fault, so a router fails over and the caller reads why.
    expect(JSON.parse(Buffer.from(answer.body).toString()).error).toMatchObject({
      type: 'payment_negotiation_failed',
      antseed_fault: 'peer',
      peer_status: 409,
      peer_message: expect.stringContaining('announces no price for this service'),
    });
    expect(sendProxyRequest).not.toHaveBeenCalled();
    expect(handle402).not.toHaveBeenCalled();
    expect(negotiator.trackRequestBillingContext).not.toHaveBeenCalled();
    expect(negotiator.bpm.markRequestCovered).not.toHaveBeenCalled();
    expect(negotiator.bpm.beginPaidRequest).not.toHaveBeenCalled();
  }

  it('refuses a paid request to a peer that announces no price for it, without sending it', async () => {
    const handled = makeHandler([response(200, { ok: true })]);
    expectRefusedBeforeSending(await handled.handler.sendRequest(peer(), chat()), handled);
  });

  it('answers with reason price_unknown', async () => {
    // A path no standard adapter reshapes, so the buyer's own body comes back as written.
    const handled = makeHandler([response(200, { ok: true })]);
    const answer = await handled.handler.sendRequest(peer(), request('/custom/generate', { model: 'k3' }));
    expect(answer.statusCode).toBe(409);
    expect(JSON.parse(Buffer.from(answer.body).toString())).toMatchObject({
      error: 'payment_negotiation_failed',
      reason: 'price_unknown',
    });
    expect(handled.sendProxyRequest).not.toHaveBeenCalled();
  });

  it('refuses a peer that announces only one of its default input and output prices, instead of reading the other as free', async () => {
    for (const partial of [
      { defaultInputUsdPerMillion: 1 },
      { defaultOutputUsdPerMillion: 2 },
      { defaultInputUsdPerMillion: 0 },
    ]) {
      const handled = makeHandler([response(200, { ok: true })]);
      expectRefusedBeforeSending(await handled.handler.sendRequest(peer(partial), chat()), handled);
    }
  });

  it('refuses a route whose announced price it cannot read, instead of billing by it or reading it as free', async () => {
    for (const providerPricing of [
      { openai: { defaults: { inputUsdPerMillion: 0 } } },
      { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { k3: { inputUsdPerMillion: 1, outputUsdPerMillion: Number.NaN } } } },
      { openai: { defaults: { inputUsdPerMillion: -1, outputUsdPerMillion: 2 } } },
      { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: Number.POSITIVE_INFINITY } } },
    ]) {
      const handled = makeHandler([response(200, { ok: true })]);
      const unreadable = peer({ providerPricing } as Partial<BuyerPeerView>);
      expectRefusedBeforeSending(await handled.handler.sendRequest(unreadable, chat()), handled);
    }
  });

  it('refuses a unit-billed route whose announced token price it cannot read, instead of billing its tokens at another price', async () => {
    const handled = makeHandler([response(200, { ok: true })]);
    const perImage = peer({
      defaultInputUsdPerMillion: 3,
      defaultOutputUsdPerMillion: 15,
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
          services: { 'image-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: -1 } },
        },
      },
      providerServiceApiProtocols: { openai: { services: { 'image-model': ['openai-images'] } } },
      providerServiceUnitBillingModels: {
        openai: { services: { 'image-model': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } } } },
      },
    });
    const answer = await handled.handler.sendRequest(perImage, request('/v1/images/generations', { model: 'image-model', prompt: 'a cube', n: 1 }));
    expectRefusedBeforeSending(answer, handled);
  });

  it('still sends a request priced by a readable provider price', async () => {
    const { handler, sendProxyRequest } = makeHandler([response(200, { ok: true })]);
    const priced = peer({ providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5 } } } });
    expect((await handler.sendRequest(priced, chat())).statusCode).toBe(200);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('still sends a request whose route has a unit model but no token price', async () => {
    const perImage = peer({
      providerServiceApiProtocols: { openai: { services: { 'image-model': ['openai-images'] } } },
      providerServiceUnitBillingModels: {
        openai: { services: { 'image-model': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } } } },
      },
    });
    const { handler, sendProxyRequest, negotiator } = makeHandler([response(200, { ok: true })]);
    const answer = await handler.sendRequest(perImage, request('/v1/images/generations', { model: 'image-model', prompt: 'a cube', n: 1 }));
    expect(answer.statusCode).toBe(200);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
    expect(negotiator.trackRequestBillingContext).toHaveBeenCalledOnce();
  });

  it('still sends a control-plane request to a peer that announces no price', async () => {
    const { handler, sendProxyRequest } = makeHandler([response(200, { ok: true })]);
    const answer = await handler.sendRequest(peer(), chat(), undefined, { controlPlane: true });
    expect(answer.statusCode).toBe(200);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });

  it('still sends a request priced by both default prices', async () => {
    const { handler, sendProxyRequest } = makeHandler([response(200, { ok: true })]);
    const priced = peer({ defaultInputUsdPerMillion: 1, defaultOutputUsdPerMillion: 2 });
    expect((await handler.sendRequest(priced, chat())).statusCode).toBe(200);
    expect(sendProxyRequest).toHaveBeenCalledOnce();
  });
});

describe('BuyerRequestHandler free-tier delegations', () => {
  it('sends the node’s own delegations and drops any copy a client set', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED], () => 'node-delegations');
    await handler.sendRequest(makePeer(), makeRequest({ 'X-Antseed-Free-Tier-Delegations': 'client-copy' }));
    const sent = sendProxyRequest.mock.calls[0]![0].headers;
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'x-antseed-free-tier-delegations'))
      .toEqual([['x-antseed-free-tier-delegations', 'node-delegations']]);
  });

  it('sends no delegations header when the node has none', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED], () => null);
    await handler.sendRequest(makePeer(), makeRequest({ 'x-antseed-free-tier-delegations': 'client-copy' }));
    expect(Object.keys(sendProxyRequest.mock.calls[0]![0].headers)).not.toContain('x-antseed-free-tier-delegations');
  });
});

describe('BuyerRequestHandler provider binding', () => {
  it('names the provider it bills the request under', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED]);
    await handler.sendRequest(makePeer(), makeRequest());
    expect(sendProxyRequest.mock.calls[0]![0].headers['x-antseed-provider']).toBe('venice');
  });

  it('keeps a provider the client named', async () => {
    const { handler, sendProxyRequest } = makeHandler([ACCEPTED]);
    await handler.sendRequest(makePeer(), makeRequest({ 'X-Antseed-Provider': 'venice' }));
    const sent = sendProxyRequest.mock.calls[0]![0].headers;
    expect(Object.entries(sent).filter(([name]) => name.toLowerCase() === 'x-antseed-provider')).toEqual([['X-Antseed-Provider', 'venice']]);
  });
});

describe('BuyerRequestHandler response receipts', () => {
  it('attributes a receipt to the peer the request went to, not the peer the receipt names', async () => {
    const request = makeRequest({ 'x-antseed-provider': 'venice' });
    const other = toPeerId('6'.repeat(40));
    const receipt = {
      version: 1 as const,
      requestId: request.requestId,
      buyerPeerId: '4'.repeat(40),
      sellerPeerId: other,
      advertisedService: 'other-model',
      provider: 'venice',
      statusCode: 200,
      requestHash: hashRequest(request),
      responseHash: 'f'.repeat(64),
      responseStartedAt: 1,
      responseCompletedAt: 2,
      signature: '00',
    };
    const inserted: Array<{ record: StoredResponseAuth; context?: ResponseAuthContext }> = [];
    const connection = { state: ConnectionState.Connected, send: vi.fn(), on: vi.fn(), off: vi.fn() };
    const handler = new BuyerRequestHandler({}, {
      localPeerId: toPeerId('4'.repeat(40)),
      negotiator: { getOrCreatePaymentMux: vi.fn(() => ({})), trackRequestBillingContext: vi.fn(), estimateCostFromResponse: vi.fn() } as never,
      verificationStorage: { insertResponseAuth: (record, context) => { inserted.push({ record, context }); } },
      verificationSampler: null,
      getConnection: async () => connection as never,
      getMux: () => ({
        sendProxyRequest: (_req: SerializedHttpRequest, onResponse: (value: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void) =>
          onResponse(ACCEPTED, { streamingStart: false }),
        cancelProxyRequest: vi.fn(),
      } as never),
      getVerificationMux: () => ({ waitForResponseAuth: vi.fn(async () => receipt) } as never),
      registerPaymentMux: vi.fn(),
    });

    const peer = { ...makePeer(), capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] };
    await handler.sendRequest(peer, request);
    await vi.waitFor(() => expect(inserted).toHaveLength(1));

    expect(inserted[0]!.record.verified).toBe(false);
    expect(inserted[0]!.record.verificationError).toBe('response_hash_mismatch');
    // The stored receipt keeps what the seller claimed; the context says who actually answered.
    expect(inserted[0]!.record.sellerPeerId).toBe(other);
    expect(inserted[0]!.context).toEqual({ sellerPeerId: peer.peerId, requestedService: 'video-model' });
  });
});

describe('stripPeerControlledResponseHeaders', () => {
  it('drops a seller copy of every buyer-only header, in any letter case', () => {
    const response = {
      requestId: 'r',
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'X-Antseed-Video-Price-Usdc': '1', 'x-antseed-video-job-retired': '1', 'X-Antseed-Video-Delivered': '1', 'X-AntSeed-Fault-Attribution': 'buyer' },
      body: new Uint8Array(),
    };
    expect(stripPeerControlledResponseHeaders(response).headers).toEqual({ 'content-type': 'application/json' });
  });
});

describe('selectBillingRoute', () => {
  const chatRequest = (): SerializedHttpRequest => ({
    requestId: 'chat', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: 'video-model', messages: [] })),
  });

  it('prefers a provider whose self health check passes', () => {
    const peer: BuyerPeerView = {
      peerId: toPeerId('5'.repeat(40)),
      providers: ['a', 'b'],
      providerPricing: {
        a: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'video-model': {} } },
        b: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { 'video-model': {} } },
      },
      providerServiceHealth: { a: { services: { 'video-model': { status: 'failing' } } } },
    };
    expect(selectBillingRoute(peer, chatRequest(), 'video-model')?.provider).toBe('b');
  });

  it('keeps video requests on the first provider serving the protocol, so retrieves reach the job', () => {
    const peer = makePeer();
    peer.providers = ['venice', 'backup'];
    peer.providerServiceApiProtocols = { ...peer.providerServiceApiProtocols, backup: { services: { 'video-model': ['venice-video'] } } };
    peer.providerServiceUnitBillingModels = { ...peer.providerServiceUnitBillingModels, backup: { services: { 'video-model': { 'venice-video': VIDEO_MODEL } } } };
    peer.providerServiceHealth = { venice: { services: { 'video-model': { status: 'failing', reason: 'out_of_credit' } } } };
    const retrieve: SerializedHttpRequest = {
      ...makeRequest({ 'x-antseed-service': 'video-model' }),
      path: '/api/v1/video/retrieve',
      body: Buffer.from(JSON.stringify({ model: 'video-model', queue_id: 'job' })),
    };
    expect(selectBillingRoute(peer, makeRequest(), 'video-model')?.provider).toBe('venice');
    expect(selectBillingRoute(peer, retrieve, 'video-model')?.provider).toBe('venice');
  });

  it('keeps a failing video provider over a healthy one that cannot serve the video protocol', () => {
    const peer = makePeer();
    peer.providers = ['venice', 'chat'];
    peer.providerServiceApiProtocols = { ...peer.providerServiceApiProtocols, chat: { services: { 'video-model': ['openai-chat-completions'] } } };
    peer.providerServiceHealth = { venice: { services: { 'video-model': { status: 'failing', reason: 'timeout' } } } };
    const route = selectBillingRoute(peer, makeRequest(), 'video-model');
    expect(route?.provider).toBe('venice');
    expect(route?.unitModel).toEqual(VIDEO_MODEL);
  });

});
