import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isFinger} from './pointer.ts';

test('a finger feeds from the ground; a mouse and a pen carry the seed', () => {
  assert.equal(isFinger('touch'), true);
  assert.equal(isFinger('mouse'), false);
  assert.equal(isFinger('pen'), false);
});
