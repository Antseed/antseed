import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retiredDesktopProfiles } from './profiles.js';

test('a retired app is cleaned up only when the old desktop had connected it, not when the CLI did', () => {
  assert.deepEqual(retiredDesktopProfiles([]).map((profile) => profile.name), []);
  assert.deepEqual(retiredDesktopProfiles(['codex']).map((profile) => profile.name), []);
  assert.deepEqual(retiredDesktopProfiles(['claude-code', 'codex']).map((profile) => profile.name), ['claude-code']);
});
