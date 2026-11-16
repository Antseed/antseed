import { expect, it } from 'vitest';
import { NATIVE_VIDEO_PROTOCOLS, WELL_KNOWN_SERVICE_API_PROTOCOLS, isKnownServiceApiProtocol, isNativeVideoProtocol } from './service-api.js';

it('supports Venice and fal as native video protocols', () => {
  expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['venice-video', 'fal-video']);
  for (const protocol of NATIVE_VIDEO_PROTOCOLS) {
    expect(WELL_KNOWN_SERVICE_API_PROTOCOLS).toContain(protocol);
    expect(isNativeVideoProtocol(protocol)).toBe(true);
  }
  for (const protocol of ['seedance-video', 'runway-video', 'minimax-video', 'wan-video']) {
    expect(isNativeVideoProtocol(protocol)).toBe(false);
    expect(isKnownServiceApiProtocol(protocol)).toBe(false);
  }
});
