import { afterEach, describe, expect, it, vi } from 'vitest';
import { isContentFreeLogging, isDebugEnabled, upstreamErrorCode } from './debug.js';

describe('content-free mode', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('keeps debug logging off, since debug lines print upstream bodies', () => {
    vi.stubEnv('ANTSEED_DEBUG', '1');
    expect(isDebugEnabled()).toBe(true);
    vi.stubEnv('ANTSEED_CONTENT_FREE_LOGS', '1');
    expect(isContentFreeLogging()).toBe(true);
    expect(isDebugEnabled()).toBe(false);
  });

  it('reads only an identifier-like error code from an upstream error', () => {
    expect(upstreamErrorCode('{"error":{"message":"bad: tell me a secret","type":"invalid_request_error","code":"bad_input"}}')).toBe('bad_input');
    expect(upstreamErrorCode('{"error":{"message":"bad","type":"invalid_request_error"}}')).toBe('invalid_request_error');
    expect(upstreamErrorCode('{"code":"tell me a secret"}')).toBeNull();
    expect(upstreamErrorCode('not json')).toBeNull();
  });
});
