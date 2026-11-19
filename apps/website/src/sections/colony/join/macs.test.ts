import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MACS, chipsFor, memsFor, settle, stepsFor, type Answers} from './macs.ts';

const none: Answers = {mac: '', chip: '', memory: '', name: ''};

test('each chip offers only the memory it shipped with in that Mac', () => {
  assert.deepEqual(memsFor('Mac Studio', 'M3 Ultra'), ['96 GB', '256 GB', '512 GB']);
  assert.deepEqual(memsFor('Mac Studio', 'M1 Max'), ['32 GB', '64 GB']);
  assert.deepEqual(memsFor('MacBook Air', 'M1'), ['8 GB', '16 GB']);
  assert.deepEqual(memsFor('MacBook Pro', 'M3 Pro'), ['18 GB', '36 GB']);
});

test('a Mac never offers a size none of its chips came with', () => {
  for (const [mac, chips] of Object.entries(MACS)) {
    const allowed = new Set(Object.values(chips).flat().map((gb) => `${gb} GB`));
    for (const chip of [...Object.keys(chips), '']) for (const size of memsFor(mac, chip)) assert.ok(allowed.has(size), `${mac} ${chip} ${size}`);
  }
  assert.ok(!memsFor('MacBook Air', '').includes('512 GB'));
  assert.ok(!memsFor('Mac Studio', '').includes('8 GB'));
});

test('before a chip is picked, every size that Mac came with, smallest first', () => {
  assert.deepEqual(memsFor('iMac', ''), ['8 GB', '16 GB', '24 GB', '32 GB']);
});

test('chips are the ones Apple put in that Mac', () => {
  assert.deepEqual(chipsFor('Mac Pro'), ['M2 Ultra']);
  assert.ok(!chipsFor('MacBook Air').includes('M3 Ultra'));
  assert.deepEqual(chipsFor('Not a Mac'), []);
});

test('a Mac with one chip skips the chip step, a chip with one size skips the memory step', () => {
  assert.deepEqual(stepsFor(none), ['mac', 'chip', 'memory', 'name', 'review', 'done']);
  assert.deepEqual(stepsFor(settle({...none, mac: 'MacBook Neo'})), ['mac', 'name', 'review', 'done']);
  assert.deepEqual(stepsFor(settle({...none, mac: 'Mac Pro'})), ['mac', 'memory', 'name', 'review', 'done']);
  assert.deepEqual(stepsFor({...none, mac: 'Mac Studio'}), ['mac', 'chip', 'memory', 'name', 'review', 'done']);
});

test('settle picks the only option and keeps the rest', () => {
  assert.deepEqual(settle({...none, mac: 'MacBook Neo'}), {...none, mac: 'MacBook Neo', chip: 'A18 Pro', memory: '8 GB'});
  assert.equal(settle({...none, mac: 'Mac Pro'}).chip, 'M2 Ultra');
  assert.equal(settle({...none, mac: 'Mac Studio'}).chip, '');
});
