import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPrng, derive, randomSeed, randomTag } from '../lib/prng.mjs';

const take = (prng, count) => Array.from({ length: count }, () => prng());

describe('prng', () => {
  it('gives the same sequence for the same seed and another for a different one', () => {
    assert.deepEqual(take(createPrng(7), 50), take(createPrng(7), 50));
    assert.notDeepEqual(take(createPrng(7), 50), take(createPrng(8), 50));
  });

  it('stays in [0, 1) and looks uniform', () => {
    const values = take(createPrng(123), 10_000);
    assert.ok(values.every((value) => value >= 0 && value < 1));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean}`);
  });

  it('derives different streams for different labels and seeds, the same for the same', () => {
    assert.equal(derive(7, 'mock:seller'), derive(7, 'mock:seller'));
    assert.notEqual(derive(7, 'mock:seller'), derive(7, 'mock:seller-2'));
    assert.notEqual(derive(7, 'load'), derive(8, 'load'));
    assert.notDeepEqual(take(createPrng(derive(7, 'load')), 20), take(createPrng(derive(7, 'warm-up')), 20));
    for (const value of [derive(0, ''), derive(4294967295, 'load')]) assert.ok(Number.isInteger(value) && value >= 0 && value < 2 ** 32);
  });

  it('keeps every stream a recorded seed depends on (a change here breaks replaying old failures)', () => {
    assert.deepEqual(take(createPrng(7), 3).map((value) => Math.floor(value * 2 ** 32)), [50271532, 266108690, 4195786334]);
    assert.equal(derive(7, 'load'), 1905856856);
    assert.equal(derive(7, 'mock:seller'), 2910046317);
    assert.equal(derive(7, 'rpc:buyer'), 1455466320);
  });

  it('makes tags the mock can read back from a [req:TAG] marker', () => {
    assert.equal(randomTag(createPrng(1), 13), randomTag(createPrng(1), 13));
    assert.notEqual(randomTag(createPrng(1)), randomTag(createPrng(2)));
    assert.match(randomTag(createPrng(1), 8), /^[a-z0-9]{8}$/);
    assert.equal(randomTag(createPrng(1)).length, 13);
  });

  it('picks fresh 32-bit run seeds', () => {
    const seeds = Array.from({ length: 20 }, randomSeed);
    assert.ok(seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32));
    assert.ok(new Set(seeds).size > 1);
  });
});
