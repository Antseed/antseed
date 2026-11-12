import { describe, expect, it } from 'vitest';
import {
  IMAGE_REQUEST_FIELDS,
  SPEECH_REQUEST_FIELDS,
  VIDEO_CREATE_FIELDS,
  extractImageRequestFacts,
  extractSpeechRequestFacts,
  nativeVideoFacts,
} from '../src/index.js';

/** A body that records every field read from it, and answers each with `value`. */
function spyBody(value: unknown): { body: Record<string, unknown>; read: Set<string> } {
  const read = new Set<string>();
  const body = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'string') read.add(key);
      return value;
    },
  }) as Record<string, unknown>;
  return { body, read };
}

// A seller checks that each field a billing reader reads is spelled exactly. These lists must name every
// field the reader reads, and no other, or a field billing prices by would go unchecked.
describe('the fields each billing reader reads', () => {
  it('names every field image billing reads', () => {
    // Which fields a reader reaches depends on the values it finds (`model ?? service`), so try several.
    const read = new Set<string>();
    for (const value of [undefined, 'x', 2, true]) {
      const spy = spyBody(value);
      extractImageRequestFacts({ path: '/v1/images/generations', method: 'POST', body: spy.body });
      for (const field of spy.read) read.add(field);
    }
    expect([...read].sort()).toEqual([...IMAGE_REQUEST_FIELDS].sort());
  });

  it.each(['x', undefined])('names every field speech billing reads (each field %j)', (value) => {
    const { body, read } = spyBody(value);
    extractSpeechRequestFacts(body);
    // With no input the reader stops before reading the rest.
    expect([...read].every((field) => SPEECH_REQUEST_FIELDS.includes(field))).toBe(true);
    if (value !== undefined) expect([...read].sort()).toEqual([...SPEECH_REQUEST_FIELDS].sort());
  });

  it('names every field video billing reads from a create, for every protocol', () => {
    const read = new Set<string>();
    for (const path of ['/api/v1/video/queue', '/fal/v1/video/queue']) {
      const spy = spyBody(undefined);
      nativeVideoFacts({ requestId: 'r', method: 'POST', path, headers: {}, body: new Uint8Array() }, spy.body);
      for (const field of spy.read) read.add(field);
    }
    expect([...read].sort()).toEqual([...VIDEO_CREATE_FIELDS].sort());
  });
});
