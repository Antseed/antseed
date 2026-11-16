import test from 'node:test';
import assert from 'node:assert/strict';
import { HTTP_STATUS_RANGE, PUBLIC_MODEL_ID_PATTERN, sanitizeEventProperties, type EventCatalog } from './sanitize.js';

const catalog: EventCatalog = {
  demo: {
    keys: new Set(['outcome', 'model', 'http_status', 'count', 'flag', 'note']),
    values: { outcome: new Set(['success', 'failed']) },
    patterns: { model: PUBLIC_MODEL_ID_PATTERN },
    ranges: { http_status: HTTP_STATUS_RANGE },
  },
};

test('unknown events are never sent', () => {
  assert.equal(sanitizeEventProperties(catalog, 'nope', { outcome: 'success' }), null);
});

test('drops unknown keys, off-enum values, bad patterns and non-scalars', () => {
  const out = sanitizeEventProperties(catalog, 'demo', {
    outcome: 'exploded',
    model: 'Prompt: tell me SECRETS',
    http_status: 1234,
    count: 3.6,
    flag: true,
    note: 'x'.repeat(100),
    peer_id: '12D3KooW',
    error: { message: 'raw' },
  });
  assert.deepEqual(out, { count: 4, flag: true, note: 'x'.repeat(64) });
});

test('keeps valid values', () => {
  assert.deepEqual(
    sanitizeEventProperties(catalog, 'demo', { outcome: 'failed', model: 'claude-sonnet-4.5', http_status: 502 }),
    { outcome: 'failed', model: 'claude-sonnet-4.5', http_status: 502 },
  );
});

test('a key takes only its declared type', () => {
  const out = sanitizeEventProperties(catalog, 'demo', {
    outcome: true,
    model: 42,
    http_status: '503 secret upstream text',
  });
  assert.deepEqual(out, {}, 'enum and pattern keys take strings only; range keys numbers only');
  assert.deepEqual(sanitizeEventProperties(catalog, 'demo', { http_status: false }), {});
});
