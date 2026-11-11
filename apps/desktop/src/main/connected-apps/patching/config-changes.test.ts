import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigPatchTarget } from '@antseed/connected-apps/config-patch';
import { createConfigChangeLog, runningAppNeedsRestart } from './config-changes.js';

const target = (overrides: Partial<ConfigPatchTarget> = {}): ConfigPatchTarget => ({
  origin: 'http://127.0.0.1:10378',
  apiKey: 'key-one',
  models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }],
  modelsLoaded: true,
  defaultModel: 'model-a',
  ...overrides,
});

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test('a re-apply that writes what the app\'s config already says is not a change', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  assert.equal(log.recordWrite('codex', target()), true);
  const connectedAt = log.changedAt()['codex'];
  time.advance(5_000);
  // A privacy switch that leaves the app's models as they were, listed in another order.
  assert.equal(log.recordWrite('codex', target({ models: [{ id: 'model-b', label: 'Model B' }, { id: 'model-a', label: 'Model A' }] })), false);
  assert.equal(log.changedAt()['codex'], connectedAt);
});

test('a new key, gateway or model list is a change, for that app only', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  log.recordWrite('codex', target());
  log.recordWrite('opencode', target());
  const opencodeAt = log.changedAt()['opencode'];
  for (const changed of [
    target({ apiKey: 'key-two' }),
    target({ apiKey: 'key-two', origin: 'https://gateway.example.com' }),
    target({ apiKey: 'key-two', origin: 'https://gateway.example.com', models: [{ id: 'model-c', label: 'Model C' }] }),
  ]) {
    time.advance(1_000);
    assert.equal(log.recordWrite('codex', changed), true);
    assert.equal(log.changedAt()['codex'], time.now());
  }
  assert.equal(log.changedAt()['opencode'], opencodeAt);
});

test('a model list the gateway could not return leaves the app\'s list as it was', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  log.recordWrite('codex', target());
  time.advance(1_000);
  assert.equal(log.recordWrite('codex', target({ models: [], modelsLoaded: false, defaultModel: undefined })), false);
  // The connection still counts when the list can't be read.
  assert.equal(log.recordWrite('codex', target({ models: [], modelsLoaded: false, apiKey: 'key-two' })), true);
  // A gateway that really serves no text models empties the list.
  time.advance(1_000);
  assert.equal(log.recordWrite('codex', target({ models: [], modelsLoaded: true, apiKey: 'key-two', defaultModel: undefined })), true);
});

test('an app connected again after a disconnect has a changed config', () => {
  const log = createConfigChangeLog(clock().now);
  log.recordWrite('codex', target());
  log.forget('codex');
  assert.equal(log.changedAt()['codex'], undefined);
  assert.equal(log.recordWrite('codex', target()), true);
});

test('an app the desktop started needs a restart only when its config changed after it started', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  log.recordWrite('codex', target());
  time.advance(1_000);
  const managed = { launchedAt: time.now() };
  const running = { running: true };
  time.advance(1_000);
  // A privacy switch that rewrites the same config: no "Restart required".
  log.recordWrite('codex', target());
  assert.equal(runningAppNeedsRestart(running, managed, log.changedAt()['codex'] ?? null), false);
  // A new key does.
  time.advance(1_000);
  log.recordWrite('codex', target({ apiKey: 'key-two' }));
  assert.equal(runningAppNeedsRestart(running, managed, log.changedAt()['codex'] ?? null), true);
  // An app that isn't running has nothing to restart.
  assert.equal(runningAppNeedsRestart({ running: false }, managed, log.changedAt()['codex'] ?? null), false);
  // One the desktop didn't start may predate the config, as before.
  assert.equal(runningAppNeedsRestart(running, undefined, null), true);
  assert.equal(runningAppNeedsRestart(running, managed, null), false);
});
