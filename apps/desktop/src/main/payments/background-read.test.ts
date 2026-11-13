import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundRead } from './background-read.js';

test('an answer never waits on the read: a slow read serves nothing until it lands', async () => {
  let release: (value: number) => void = () => undefined;
  let loads = 0;
  const read = new BackgroundRead<number>(() => { loads += 1; return new Promise((resolve) => { release = resolve; }); });
  assert.equal(read.current(), null);
  assert.equal(read.current(), null, 'still running: no second read');
  assert.equal(loads, 1);
  release(7);
  await read.settled();
  assert.equal(read.current(), 7);
  assert.equal(loads, 1, 'a final value is not read again');
});

test('a failed read keeps the last value and is tried again next time', async () => {
  let fail = true;
  const read = new BackgroundRead<number>(async () => { if (fail) throw new Error('rpc down'); return 3; });
  read.current();
  await read.settled();
  fail = false;
  assert.equal(read.current(), null, 'nothing yet; this starts another read');
  await read.settled();
  assert.equal(read.current(), 3);
});

test('a value that is not final is served and read again; clear() drops a read from before', async () => {
  let next = 1;
  let release: () => void = () => undefined;
  const read = new BackgroundRead<{ n: number; final: boolean }>(
    () => new Promise((resolve) => { const n = next++; release = () => resolve({ n, final: n >= 2 }); }),
    (value) => value.final,
  );
  read.current(); release(); await read.settled();
  assert.equal(read.current()?.n, 1, 'served while a re-read starts');
  read.clear();
  release(); await read.settled();
  assert.equal(read.current(), null, 'the read from before the clear is ignored');
});
