import assert from 'node:assert/strict';
import {test} from 'node:test';
import {atShare, COUNT_MS, countAt, parse, START_SHARE} from './countUp.ts';

test('a frame stamped before the count began shows the 70% start, never below it', () => {
  const f = parse('40,612')!;
  const from = f.value * START_SHARE;
  assert.equal(countAt(f, from, 990, 1000), atShare('40,612', START_SHARE));
  assert.equal(countAt(f, from, 1000, 1000), '28,428');
});

test('the count never steps down and ends on the figure', () => {
  const f = parse('1.3T')!;
  const from = f.value * START_SHARE;
  let last = -Infinity;
  for (let now = -100; now <= COUNT_MS + 100; now += 16) {
    const v = parse(countAt(f, from, now, 0))!.value;
    assert.ok(v >= last);
    last = v;
  }
  assert.equal(countAt(f, from, COUNT_MS, 0), '1.3T');
});
