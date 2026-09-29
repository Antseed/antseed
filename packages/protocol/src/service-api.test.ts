import { expect, it } from 'vitest';
import { NATIVE_VIDEO_PROTOCOLS, WELL_KNOWN_SERVICE_API_PROTOCOLS, isKnownServiceApiProtocol, isNativeVideoProtocol } from './service-api.js';

it('supports only Seedance and Venice as native video protocols', () => {
  expect(NATIVE_VIDEO_PROTOCOLS).toEqual(['seedance-video', 'venice-video']);
  for (const protocol of NATIVE_VIDEO_PROTOCOLS) {
    expect(WELL_KNOWN_SERVICE_API_PROTOCOLS).toContain(protocol);
    expect(isNativeVideoProtocol(protocol)).toBe(true);
  }
  for (const protocol of ['runway-video', 'minimax-video', 'wan-video']) {
    expect(isNativeVideoProtocol(protocol)).toBe(false);
    expect(isKnownServiceApiProtocol(protocol)).toBe(false);
  }
});
