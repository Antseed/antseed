import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOSING_ERROR, START_CANCELLED_ERROR, StartGenerations, startUnlessCancelled } from './start-guard.js';

const whenClosing = (isClosing: () => boolean) => () => (isClosing() ? CLOSING_ERROR : null);

test('starts when the app is not quitting', async () => {
  const calls: string[] = [];
  await startUnlessCancelled(whenClosing(() => false), async () => { calls.push('start'); }, async () => { calls.push('stop'); });
  assert.deepEqual(calls, ['start']);
});

test('nothing starts once the app is quitting', async () => {
  const calls: string[] = [];
  await assert.rejects(startUnlessCancelled(whenClosing(() => true), async () => { calls.push('start'); }, async () => { calls.push('stop'); }), /closing/);
  assert.deepEqual(calls, []);
});

test('a gateway that came up while the app began quitting is stopped', async () => {
  let closing = false;
  const calls: string[] = [];
  await assert.rejects(startUnlessCancelled(
    whenClosing(() => closing),
    async () => { calls.push('start'); closing = true; },
    async () => { calls.push('stop'); },
  ), /closing/);
  assert.deepEqual(calls, ['start', 'stop']);
});

test('a stop during a start\'s preparation leaves no local gateway behind, and a later start runs', async () => {
  const generations = new StartGenerations();
  let running = false;
  const calls: string[] = [];
  let finishPreparing!: () => void;
  const preparing = new Promise<void>((resolve) => { finishPreparing = resolve; });

  const started = generations.begin();
  const start = startUnlessCancelled(
    () => (generations.overtaken(started) ? START_CANCELLED_ERROR : null),
    async () => { await preparing; running = true; calls.push('spawn'); },
    async () => { running = false; calls.push('stop'); },
  );
  // The user switches to a remote gateway while the start prepares.
  generations.end();
  finishPreparing();
  await assert.rejects(start, /cancelled/);
  assert.equal(running, false);
  assert.deepEqual(calls, ['spawn', 'stop']);

  const again = generations.begin();
  await startUnlessCancelled(
    () => (generations.overtaken(again) ? START_CANCELLED_ERROR : null),
    async () => { running = true; },
    async () => { running = false; },
  );
  assert.equal(running, true);
});
