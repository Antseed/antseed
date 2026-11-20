import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TotalsResponse} from './api.ts';
import {epochAt, formatCountdown, fromWei, selectAnts, selectTotals} from './selectors.ts';
import type {AntsToken} from './types.ts';

const TOTALS: TotalsResponse = {
  totalVolumeUsdc: '401409845673',
  totalRequests: '25000000',
  totalInputTokens: '600000000000',
  totalOutputTokens: '20000000000',
  freeRequests: '9000000',
  freeInputTokens: '300000000000',
  freeOutputTokens: '6000000000',
  sellerCount: 294,
  buyerCount: 30569,
};

test('totals add free usage to the paid counters and read USDC in base units', () => {
  assert.deepEqual(selectTotals(TOTALS), {
    users: 30569,
    providers: 294,
    requests: 34_000_000,
    tokens: 926_000_000_000,
    settledUsd: 401_409.845673,
  });
});

test('empty or malformed totals are rejected', () => {
  assert.equal(selectTotals({...TOTALS, buyerCount: 0}), null);
  assert.equal(selectTotals({...TOTALS, totalVolumeUsdc: 'n/a'}), null);
});

test('18-decimal amounts read from decimal and hex', () => {
  assert.equal(fromWei('145236642354540348584665239'), 145_236_642.354_54);
  assert.equal(fromWei('0x9ed194db19b238c000000'), 12_000_000);
});

const EMISSIONS = {
  currentEpoch: '31',
  epochDuration: '604800',
  mintedSupply: '145236642354540348584665239',
  maxSupply: '1040000000000000000000000000',
  epochProgress: {startedAt: '1794477261', endsAt: '1795082061'},
};

test('ANTS: supply, burned and the epoch clock', () => {
  assert.deepEqual(selectAnts(EMISSIONS, '0x9ed194db19b238c000000'), {
    supply: 145_236_642.354_54, burned: 12_000_000, epoch: 31, epochEndsAt: 1_795_082_061, epochSeconds: 604_800,
  });
  assert.equal(selectAnts(EMISSIONS, 'not hex'), null);
});

const ANTS: AntsToken = {supply: 1, burned: 0, epoch: 31, epochEndsAt: 1_000_000, epochSeconds: 100};

test('the epoch carries on past a stale read by whole epochs', () => {
  assert.deepEqual(epochAt(ANTS, 999_950), {epoch: 31, secondsLeft: 50});
  assert.deepEqual(epochAt(ANTS, 1_000_000), {epoch: 32, secondsLeft: 100});
  assert.deepEqual(epochAt(ANTS, 1_000_250), {epoch: 34, secondsLeft: 50});
});

test('the countdown reads days, hours and minutes', () => {
  assert.equal(formatCountdown(3 * 86400 + 4 * 3600 + 5 * 60 + 59), 'Next epoch in 3d 4h 5m');
});
