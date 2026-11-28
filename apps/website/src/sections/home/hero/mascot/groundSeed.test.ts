import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dropsGroundSeed, type GroundSeedState} from './groundSeed.ts';

const READY: GroundSeedState = {touchFirst: false, fingerSeen: false, seeded: false, still: false, shown: 1, covered: false};

test('on a touch-first screen the seed drops in once the mascot shows', () => {
  assert.equal(dropsGroundSeed({...READY, touchFirst: true}), true);
});

test('on a screen whose main pointer hovers, a finger on the card drops the seed in', () => {
  assert.equal(dropsGroundSeed({...READY, fingerSeen: true}), true);
});

test('with only a mouse the seed stays in the hand', () => {
  assert.equal(dropsGroundSeed(READY), false);
});

test('it drops only once, never with reduced motion, and waits for the mascot and the painting', () => {
  const finger = {...READY, fingerSeen: true};
  assert.equal(dropsGroundSeed({...finger, seeded: true}), false);
  assert.equal(dropsGroundSeed({...finger, still: true}), false);
  assert.equal(dropsGroundSeed({...finger, shown: 0.5}), false);
  assert.equal(dropsGroundSeed({...finger, covered: true}), false);
});
