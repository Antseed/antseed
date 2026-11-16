import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnSlot } from './turn-slot.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

/** A turn as the bridge runs it: reserve, look the chat up, then send only if it still owns the slot. */
async function runTurn(slot: TurnSlot<{ cancelled: boolean; text: string }>, text: string, lookup: Promise<void>, sent: string[]): Promise<'busy' | 'cancelled' | 'sent'> {
  const turn = { cancelled: false, text };
  if (!slot.reserve(turn)) return 'busy';
  await lookup;
  if (!slot.owns(turn)) return 'cancelled';
  sent.push(text);
  slot.release(turn);
  return 'sent';
}

test('a second message during a slow chat lookup is turned away, not raced', async () => {
  const slot = new TurnSlot<{ cancelled: boolean; text: string }>();
  const lookup = deferred();
  const sent: string[] = [];
  const first = runTurn(slot, 'one', lookup.promise, sent);
  assert.equal(await runTurn(slot, 'two', Promise.resolve(), sent), 'busy');
  lookup.resolve();
  assert.equal(await first, 'sent');
  assert.deepEqual(sent, ['one']);
});

test('/stop during the lookup cancels the turn before anything is sent', async () => {
  const slot = new TurnSlot<{ cancelled: boolean; text: string }>();
  const lookup = deferred();
  const sent: string[] = [];
  const first = runTurn(slot, 'one', lookup.promise, sent);
  assert.equal(slot.cancel()?.text, 'one');
  lookup.resolve();
  assert.equal(await first, 'cancelled');
  assert.deepEqual(sent, []);
  // The slot is free again for the next message.
  assert.equal(await runTurn(slot, 'two', Promise.resolve(), sent), 'sent');
});

test('a cancelled turn finishing late doesn\'t free a newer turn\'s slot', () => {
  const slot = new TurnSlot<{ cancelled: boolean }>();
  const old = { cancelled: false };
  slot.reserve(old);
  slot.cancel();
  const fresh = { cancelled: false };
  assert.equal(slot.reserve(fresh), true);
  slot.release(old);
  assert.equal(slot.current, fresh);
});
