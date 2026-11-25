import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeConfigPatch, type ConfigPatchTarget, type WrittenModels } from '@antseed/connected-apps/config-patch';
import { createConfigChangeLog, runningAppNeedsRestart, type ConfigChangeLog } from './config-changes.js';

const target = (overrides: Partial<ConfigPatchTarget> = {}): ConfigPatchTarget => ({
  origin: 'http://127.0.0.1:10378',
  apiKey: 'key-one',
  models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }],
  modelsLoaded: true,
  defaultModel: 'model-a',
  ...overrides,
});

/** What a write of `t` gives an app whose config lists the target's models and has a selection. */
const listed = (t: ConfigPatchTarget): WrittenModels => ({ modelIds: t.models.map((model) => model.id), defaulted: [] });

function record(log: ConfigChangeLog, name: string, t: ConfigPatchTarget): boolean {
  return log.recordWrite(name, t, listed(t));
}

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test('a re-apply that writes what the app\'s config already says is not a change', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  assert.equal(record(log, 'codex', target()), true);
  const connectedAt = log.changedAt()['codex'];
  time.advance(5_000);
  // A privacy switch that leaves the app's models as they were, listed in another order.
  assert.equal(record(log, 'codex', target({ models: [{ id: 'model-b', label: 'Model B' }, { id: 'model-a', label: 'Model A' }] })), false);
  assert.equal(log.changedAt()['codex'], connectedAt);
});

test('a new key, gateway or model list is a change, for that app only', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  record(log, 'codex', target());
  record(log, 'opencode', target());
  const opencodeAt = log.changedAt()['opencode'];
  for (const changed of [
    target({ apiKey: 'key-two' }),
    target({ apiKey: 'key-two', origin: 'https://gateway.example.com' }),
    target({ apiKey: 'key-two', origin: 'https://gateway.example.com', models: [{ id: 'model-c', label: 'Model C' }] }),
  ]) {
    time.advance(1_000);
    assert.equal(record(log, 'codex', changed), true);
    assert.equal(log.changedAt()['codex'], time.now());
  }
  assert.equal(log.changedAt()['opencode'], opencodeAt);
});

test('a model list the gateway could not return leaves the app\'s list as it was', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  record(log, 'codex', target());
  time.advance(1_000);
  assert.equal(record(log, 'codex', target({ models: [], modelsLoaded: false, defaultModel: undefined })), false);
  // The connection still counts when the list can't be read.
  assert.equal(record(log, 'codex', target({ models: [], modelsLoaded: false, apiKey: 'key-two' })), true);
  // A gateway that really serves no text models empties the list.
  time.advance(1_000);
  assert.equal(record(log, 'codex', target({ models: [], modelsLoaded: true, apiKey: 'key-two', defaultModel: undefined })), true);
});

test('an app connected again after a disconnect has a changed config', () => {
  const log = createConfigChangeLog(clock().now);
  record(log, 'codex', target());
  log.forget('codex');
  assert.equal(log.changedAt()['codex'], undefined);
  assert.equal(record(log, 'codex', target()), true);
});

test('an app the desktop started needs a restart only when its config changed after it started', () => {
  const time = clock();
  const log = createConfigChangeLog(time.now);
  record(log, 'codex', target());
  time.advance(1_000);
  const managed = { launchedAt: time.now() };
  const running = { running: true };
  time.advance(1_000);
  // A privacy switch that rewrites the same config: no "Restart required".
  record(log, 'codex', target());
  assert.equal(runningAppNeedsRestart(running, managed, log.changedAt()['codex'] ?? null), false);
  // A new key does.
  time.advance(1_000);
  record(log, 'codex', target({ apiKey: 'key-two' }));
  assert.equal(runningAppNeedsRestart(running, managed, log.changedAt()['codex'] ?? null), true);
  // An app that isn't running has nothing to restart.
  assert.equal(runningAppNeedsRestart({ running: false }, managed, log.changedAt()['codex'] ?? null), false);
  // One the desktop didn't start may predate the config, as before.
  assert.equal(runningAppNeedsRestart(running, undefined, null), true);
  assert.equal(runningAppNeedsRestart(running, managed, null), false);
});

test('a low-trust seller coming or going changes an app\'s config only when it changes what the app lists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-desktop-config-changes-'));
  try {
    const configPath = path.join(dir, 'opencode.json');
    const patch = {
      configPath,
      providerKey: 'antseed',
      npm: '@antseed/tool-provider',
      providerName: 'Antseed',
      baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    };
    const model = (id: string) => ({ id, label: id });
    const write = (log: ConfigChangeLog, t: ConfigPatchTarget) => log.recordWrite('opencode', t, writeConfigPatch(patch, t, undefined));
    const selectInApp = async (id: string) => {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
      await writeFile(configPath, JSON.stringify({ ...config, model: `antseed/${id}` }), 'utf8');
    };

    // An app on a listed model: low-trust sellers and the default don't reach its config.
    await writeFile(configPath, JSON.stringify({ model: 'antseed/model-a' }), 'utf8');
    const onListed = createConfigChangeLog(clock().now);
    assert.equal(write(onListed, target({ unlistedModels: [model('model-x')] })), true);
    assert.equal(write(onListed, target({ unlistedModels: [model('model-x'), model('model-y')], defaultModel: 'model-b' })), false);
    assert.equal(write(onListed, target({ unlistedModels: [] })), false);

    // An app on an unlisted model lists it: another low-trust model coming or
    // going is no change, its own model going (the app moves to the default) is.
    await selectInApp('model-x');
    const onUnlisted = createConfigChangeLog(clock().now);
    assert.equal(write(onUnlisted, target({ unlistedModels: [model('model-x')] })), true);
    assert.equal(write(onUnlisted, target({ unlistedModels: [model('model-x'), model('model-y')] })), false);
    assert.equal(write(onUnlisted, target({ unlistedModels: [model('model-x')] })), false);
    assert.equal(write(onUnlisted, target({ unlistedModels: [] })), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an app Antseed gave its default model needs no restart when the same target is applied again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-desktop-config-changes-'));
  try {
    const configPath = path.join(dir, 'opencode.json');
    const patch = {
      configPath,
      providerKey: 'antseed',
      npm: '@antseed/tool-provider',
      providerName: 'Antseed',
      baseURL: 'http://127.0.0.1:{buyerPort}/v1',
    };
    const time = clock();
    const log = createConfigChangeLog(time.now);
    const write = (t: ConfigPatchTarget) => log.recordWrite('opencode', t, writeConfigPatch(patch, t, undefined));
    const needsRestart = (managed: { launchedAt: number }) =>
      runningAppNeedsRestart({ running: true }, managed, log.changedAt()['opencode'] ?? null);

    // OpenCode with no model selected: the patch selects the target's default.
    await writeFile(configPath, JSON.stringify({}), 'utf8');
    assert.equal(write(target()), true);
    assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { model?: string }).model, 'antseed/model-a');
    time.advance(1_000);
    const managed = { launchedAt: time.now() };
    const connectedAt = log.changedAt()['opencode'];

    // The same target again (a privacy switch that leaves the models as they were).
    time.advance(1_000);
    assert.equal(write(target()), false);
    assert.equal(log.changedAt()['opencode'], connectedAt);
    assert.equal(needsRestart(managed), false);

    // The user switching models inside the app isn't Antseed's change.
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, model: 'antseed/model-b' }), 'utf8');
    time.advance(1_000);
    assert.equal(write(target()), false);
    assert.equal(needsRestart(managed), false);

    // A real model-list change is.
    time.advance(1_000);
    assert.equal(write(target({ models: [...target().models, { id: 'model-c', label: 'Model C' }] })), true);
    assert.equal(log.changedAt()['opencode'], time.now());
    assert.equal(needsRestart(managed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
