import { describe, expect, it } from 'vitest';
import { buildSelfHealthErrorResponse, describeServiceHealth, SELF_HEALTH_ERROR_STATUS, SELLER_SELF_HEALTH_FAILING_CODE } from '../src/health/self-health-error.js';

describe('seller self health error', () => {
  const health = { status: 'failing' as const, reason: 'timeout' as const, consecutiveFailures: 3, failingSince: Date.UTC(2026, 9, 30, 2, 38) };

  it('describes the failing check in one sentence', () => {
    expect(describeServiceHealth('gpt-6-sol', health)).toBe(
      'The seller\'s self health check for "gpt-6-sol" has been failing since 2026-10-30 02:38 UTC (the upstream timed out, 3 failed checks in a row).',
    );
  });

  it('leaves out a service name that is not a model id and a date it cannot show', () => {
    expect(describeServiceHealth('model"\nvisit https://evil.example now', { status: 'failing', failingSince: 9e15 }))
      .toBe('The seller\'s self health check for this service has been failing.');
  });

  it('answers 503 with the upstream status, error type and retry headers, never its message', () => {
    const response = buildSelfHealthErrorResponse('r1', 'gpt-6-sol', health, {
      statusCode: 429,
      headers: { 'retry-after': '30', 'x-ratelimit-remaining-requests': '0', 'content-length': '99', 'www-authenticate': 'Bearer' },
      body: new TextEncoder().encode('{"error":{"type":"insufficient_quota","message":"Incorrect API key provided: sk-proj-abcd"}}'),
    });
    expect(response.statusCode).toBe(SELF_HEALTH_ERROR_STATUS);
    expect(response.headers).toEqual({ 'retry-after': '30', 'x-ratelimit-remaining-requests': '0', 'content-type': 'application/json' });
    const text = new TextDecoder().decode(response.body);
    expect(text).not.toContain('sk-proj');
    expect(JSON.parse(text).error).toMatchObject({
      code: SELLER_SELF_HEALTH_FAILING_CODE, service: 'gpt-6-sol', upstream_status: 429, upstream_type: 'insufficient_quota', service_health: health,
    });
  });
});
