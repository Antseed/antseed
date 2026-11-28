import { describe, expect, it, vi } from 'vitest';
import type { ServiceCapabilities } from '@antseed/node';
import {
  UPSTREAM_LISTING_MAX_BYTES,
  fetchUpstreamJson,
  fillReasoningCapabilities,
  listingPlace,
  namesReasoningLevel,
  servicesAwaitingReasoning,
  warnUnreadListing,
} from './upstream-reasoning.js';

const chat = ['openai-chat-completions'] as const;

describe('servicesAwaitingReasoning', () => {
  it('picks Chat Completions and Responses services that announce no list', () => {
    const protocols = {
      a: [...chat],
      b: ['openai-responses' as const],
      images: ['openai-images' as const],
      messages: ['anthropic-messages' as const],
      off: [...chat],
      listed: [...chat],
    };
    const caps: Record<string, ServiceCapabilities> = {
      off: { reasoning: false },
      listed: { reasoningEfforts: ['low'] },
    };
    expect(servicesAwaitingReasoning(Object.keys(protocols), protocols, caps)).toEqual(['a', 'b']);
    expect(servicesAwaitingReasoning(['a'], undefined, undefined)).toEqual([]);
  });
});

describe('fillReasoningCapabilities', () => {
  it('fills an empty service with the list and reasoning true', () => {
    const caps: Record<string, ServiceCapabilities> = {};
    expect(fillReasoningCapabilities(caps, 'm', { efforts: ['low', 'high'], reasons: true })).toBe(true);
    expect(caps.m).toEqual({ reasoning: true, reasoningEfforts: ['low', 'high'] });
  });

  it('keeps the other configured fields and never overrides a configured list', () => {
    const caps: Record<string, ServiceCapabilities> = {
      other: { contextWindow: 1000, toolUse: true },
      listed: { reasoningEfforts: ['adaptive'] },
      empty: { reasoningEfforts: [] },
    };
    fillReasoningCapabilities(caps, 'other', { efforts: ['low'], reasons: true });
    expect(caps.other).toEqual({ contextWindow: 1000, toolUse: true, reasoning: true, reasoningEfforts: ['low'] });
    expect(fillReasoningCapabilities(caps, 'listed', { efforts: ['low', 'high'], reasons: true })).toBe(false);
    expect(caps.listed).toEqual({ reasoningEfforts: ['adaptive'] });
    expect(fillReasoningCapabilities(caps, 'empty', { efforts: ['low'], reasons: true })).toBe(false);
    expect(caps.empty).toEqual({ reasoningEfforts: [] });
  });

  it('never fills a service that announces reasoning false', () => {
    const caps: Record<string, ServiceCapabilities> = { m: { reasoning: false } };
    expect(fillReasoningCapabilities(caps, 'm', { efforts: ['low'], reasons: true })).toBe(false);
    expect(caps.m).toEqual({ reasoning: false });
  });

  it('drops a list with any invalid label, whole', () => {
    for (const efforts of [['low', 'very high'], ['low', ''], ['low', 3], ['low', 'low'], 'low', Array.from({ length: 33 }, (_, i) => `l${i}`)]) {
      const caps: Record<string, ServiceCapabilities> = {};
      fillReasoningCapabilities(caps, 'm', { efforts, reasons: true });
      expect(caps.m).toBeUndefined();
    }
  });

  it('fills nothing from an empty list, a missing entry, or reasoning alone', () => {
    const caps: Record<string, ServiceCapabilities> = {};
    expect(fillReasoningCapabilities(caps, 'm', { efforts: [], reasons: false })).toBe(false);
    expect(fillReasoningCapabilities(caps, 'm', null)).toBe(false);
    expect(fillReasoningCapabilities(caps, 'm', { reasons: true })).toBe(false);
    expect(caps).toEqual({});
  });

  it('sets reasoning true only when the upstream says the model reasons', () => {
    const caps: Record<string, ServiceCapabilities> = {};
    fillReasoningCapabilities(caps, 'm', { efforts: ['none'], reasons: namesReasoningLevel(['none']) });
    expect(caps.m).toEqual({ reasoningEfforts: ['none'] });
  });
});

describe('fetchUpstreamJson', () => {
  const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

  it('reads JSON without following redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: 1 }));
    expect(await fetchUpstreamJson('https://upstream.example/v1/models', { headers: { authorization: 'Bearer k' } }, fetchMock)).toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ authorization: 'Bearer k' });
  });

  it('returns undefined on a failed, oversized, slow, invalid or throwing answer', async () => {
    expect(await fetchUpstreamJson('u', {}, vi.fn().mockResolvedValue(json({ error: 1 }, { status: 401 })))).toBeUndefined();
    expect(await fetchUpstreamJson('u', {}, vi.fn().mockResolvedValue(new Response('not json')))).toBeUndefined();
    expect(await fetchUpstreamJson('u', {}, vi.fn().mockRejectedValue(new TypeError('redirect')))).toBeUndefined();
    const big = new Uint8Array(UPSTREAM_LISTING_MAX_BYTES + 1).fill(0x20);
    expect(await fetchUpstreamJson('u', {}, vi.fn().mockResolvedValue(new Response(big)))).toBeUndefined();
    // No content-length: the streamed body is capped too.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20)); },
    });
    expect(await fetchUpstreamJson('u', {}, vi.fn().mockResolvedValue(new Response(stream)))).toBeUndefined();
    const slow = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    expect(await fetchUpstreamJson('u', {}, slow, 20)).toBeUndefined();
  });
});

describe('warnUnreadListing', () => {
  it('names host and path only, never the query or credentials', () => {
    expect(listingPlace('https://user:secret@upstream.example:8443/v1/models?key=sk-1')).toBe('upstream.example:8443/v1/models');
    expect(listingPlace('not a url')).toBe('the upstream');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnUnreadListing('http://127.0.0.1:8080/props?model=m', 'http://127.0.0.1:8080/api/show');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe('reasoning efforts: could not read 127.0.0.1:8080/props or 127.0.0.1:8080/api/show; announcing no list');
    } finally {
      warn.mockRestore();
    }
  });
});
