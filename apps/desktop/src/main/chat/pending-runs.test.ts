import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingRuns } from './pending-runs.js';

/** A privacy gate the test opens by hand. */
function heldGate() {
  let open = (): void => undefined;
  const settled = new Promise<void>((resolve) => { open = resolve; });
  return { settled, open };
}

test('a Stop while the privacy gate holds a run keeps its prompt from going out', async () => {
  const pending = new PendingRuns();
  const gate = heldGate();
  let sent = false;
  const run = (async () => {
    const { signal, end } = pending.begin('chat-1');
    try {
      await gate.settled;
      if (signal.aborted) return 'stopped';
      sent = true;
      return 'sent';
    } finally {
      end();
    }
  })();
  pending.abort('chat-1');
  gate.open();
  assert.equal(await run, 'stopped');
  assert.equal(sent, false);
});

test('aborting one conversation leaves the others pending', () => {
  const pending = new PendingRuns();
  const a = pending.begin('a');
  const b = pending.begin('b');
  pending.abort('a');
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  pending.abort();
  assert.equal(b.signal.aborted, true);
});

test('a new run in the same conversation cancels the one it replaces, and only its own end clears it', () => {
  const pending = new PendingRuns();
  const first = pending.begin('chat');
  const second = pending.begin('chat');
  assert.equal(first.signal.aborted, true);
  first.end();
  pending.abort('chat');
  assert.equal(second.signal.aborted, true);
  second.end();
  const third = pending.begin('chat');
  pending.abort('other');
  assert.equal(third.signal.aborted, false);
});
