import { describe, it, expect } from 'vitest';
import * as protocol from '@antseed/protocol/service-api';
import {
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  NATIVE_VIDEO_PROTOCOLS,
  ROUTING_PROTOCOLS,
  AUDIO_SPEECH_PROTOCOLS,
} from '../src/index.js';

// api-adapter keeps its own copy of the protocol id lists. Billing metadata encodes a
// protocol by its position, so the copy must match @antseed/protocol entry for entry.
describe('service API protocol ids', () => {
  it('match @antseed/protocol in the same order', () => {
    expect(WELL_KNOWN_SERVICE_API_PROTOCOLS).toEqual(protocol.WELL_KNOWN_SERVICE_API_PROTOCOLS);
    expect(NATIVE_VIDEO_PROTOCOLS).toEqual(protocol.NATIVE_VIDEO_PROTOCOLS);
    expect(ROUTING_PROTOCOLS).toEqual(protocol.ROUTING_PROTOCOLS);
    expect(AUDIO_SPEECH_PROTOCOLS).toEqual(protocol.AUDIO_SPEECH_PROTOCOLS);
  });
});
