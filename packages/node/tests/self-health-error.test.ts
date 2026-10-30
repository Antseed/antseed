import { describe, expect, it } from 'vitest';
import { buildSelfHealthErrorResponse, describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE } from '../src/health/self-health-error.js';

describe('seller self health error', () => {
  const health = { status: 'failing' as const, reason: 'timeout' as const, consecutiveFailures: 3, failingSince: Date.UTC(2026, 9, 30, 2, 38) };

  it('describes the failing check in one sentence', () => {
    expect(describeServiceHealth('gpt-6-sol', health)).toBe(
      'The seller\'s self health check for "gpt-6-sol" has been failing since 2026-10-30 02:38 UTC (the upstream timed out, 3 failed checks in a row).',
    );
  });

  it('keeps the upstream status and quotes the upstream error', () => {
    const response = buildSelfHealthErrorResponse('r1', 502, 'gpt-6-sol', health, new TextEncoder().encode('{"error":{"message":"upstream overloaded"}}'));
    expect(response.statusCode).toBe(502);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.error).toMatchObject({ code: SELLER_SELF_HEALTH_FAILING_CODE, service: 'gpt-6-sol', upstream_status: 502, service_health: health });
    expect(body.error.message).toMatch(/self health check for "gpt-6-sol".*Upstream said: upstream overloaded$/);
  });
});
