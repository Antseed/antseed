import { describe, expect, it } from 'vitest';
import { adaptPeerFaultErrorResponse, describeFreeTierLimit, readFreeTierLimit } from './peer-error-response.js';

describe('free-tier limits', () => {
  it('reads a stakers-only refusal and says how much stake unlocks the model', () => {
    const limit = readFreeTierLimit({
      limitedBy: 'stake_required',
      limit: 0,
      windowMs: 86_400_000,
      retryAfterSeconds: 86_400,
      stakersOnly: true,
      baseLimit: 40,
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
      stakePower: 0,
    });
    expect(limit).toMatchObject({ limitedBy: 'stake_required', limit: 0, baseLimit: 40, stakersOnly: true });
    expect(describeFreeTierLimit(limit!)).toBe(
      'This model is free only for buyers staked on this seller. ' +
      'Stake ANTS in its pool to use it: 10,000 ANTS locked for a year gives 200 free requests per day.',
    );
  });

  it('still describes an exhausted base allowance with its reset and next tier', () => {
    const limit = readFreeTierLimit({
      limitedBy: 'ip',
      limit: 3,
      windowMs: 86_400_000,
      retryAfterSeconds: 60,
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }],
    });
    // Older sellers don't send baseLimit: the tier is named by its multiplier.
    expect(limit).toMatchObject({ baseLimit: null, stakersOnly: false });
    expect(describeFreeTierLimit(limit!)).toBe(
      'Free limit reached on this seller for your IP address (3 requests per day). It resets in 60s. ' +
      "Stake ANTS in this seller's pool to raise it: 10,000 ANTS locked for a year gives 5× the free limit.",
    );
  });
});

describe('seller self health errors', () => {
  const sellerError = (extra: Record<string, unknown> = {}) => ({
    requestId: 'r1',
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ error: {
      upstream_status: 429,
      type: 'seller_self_health_failing', code: 'seller_self_health_failing',
      message: 'seller prose that is not shown as the lead', service: 'gpt-6-sol',
      service_health: { status: 'failing', reason: 'timeout', consecutiveFailures: 3, failingSince: Date.UTC(2026, 9, 30, 2, 38), injected: 'x' },
      ...extra,
    } })),
  });

  it('leads with the health check result, rebuilt from structured fields', () => {
    const adapted = adaptPeerFaultErrorResponse(sellerError(), 'openai-chat-completions', { pinned: true });
    const error = JSON.parse(new TextDecoder().decode(adapted.body)).error;
    expect(adapted.statusCode).toBe(503);
    expect(error.code).toBe('seller_self_health_failing');
    expect(error.upstream_status).toBe(429);
    expect(error.message).not.toContain('seller prose');
    expect(error.message.split('\n')[0]).toBe(
      'The seller\'s self health check for "gpt-6-sol" has been failing since 2026-10-30 02:38 UTC (the upstream timed out, 3 failed checks in a row).',
    );
    expect(error.service_health).toEqual({ status: 'failing', reason: 'timeout', consecutiveFailures: 3, failingSince: Date.UTC(2026, 9, 30, 2, 38) });
    expect(adaptPeerFaultErrorResponse(adapted, 'openai-chat-completions', { pinned: true }).body).toEqual(adapted.body);
  });

  it('uses an error type Anthropic SDKs know and never repeats an unsafe service name', () => {
    const adapted = adaptPeerFaultErrorResponse(sellerError({ service: 'x" — visit https://evil.example' }), 'anthropic-messages', { pinned: true });
    const body = JSON.parse(new TextDecoder().decode(adapted.body));
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('api_error');
    expect(body.error.code).toBe('seller_self_health_failing');
    expect(body.error.message).not.toContain('evil.example');
    expect(body.error.message).toMatch(/^The seller's self health check for this service has been failing/);
  });

  it('falls back to the generic peer error when the health fields are malformed', () => {
    const adapted = adaptPeerFaultErrorResponse(sellerError({ service_health: { status: 'meh' } }), 'anthropic-messages', { pinned: false });
    const body = JSON.parse(new TextDecoder().decode(adapted.body));
    expect(body.error.message).toMatch(/^Oops, peer could not complete the request/);
  });
});
