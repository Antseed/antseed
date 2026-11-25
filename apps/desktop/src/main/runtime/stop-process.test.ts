import assert from 'node:assert/strict';
import test from 'node:test';
import { askProcessToStop, forceProcessToStop } from './stop-process.js';

function fake() {
  const calls: string[] = [];
  return { calls, child: { pid: 7, stdin: { end: () => { calls.push('stdin closed'); } }, kill: (signal: string) => { calls.push(signal); return true; } } };
}

test('Windows is asked through stdin, because a signal would end the gateway outright', () => {
  const { calls, child } = fake();
  askProcessToStop(child, 'win32');
  assert.deepEqual(calls, ['stdin closed']);
});

test('elsewhere it gets SIGTERM', () => {
  const { calls, child } = fake();
  askProcessToStop(child, 'darwin');
  assert.deepEqual(calls, ['SIGTERM']);
});

test('forcing on Windows takes the whole tree', () => {
  const { calls, child } = fake();
  const trees: number[] = [];
  forceProcessToStop(child, 'win32', (pid) => trees.push(pid));
  assert.deepEqual(trees, [7]);
  assert.deepEqual(calls, []);
});

test('forcing elsewhere is SIGKILL', () => {
  const { calls, child } = fake();
  forceProcessToStop(child, 'linux', () => assert.fail('no tree kill'));
  assert.deepEqual(calls, ['SIGKILL']);
});
