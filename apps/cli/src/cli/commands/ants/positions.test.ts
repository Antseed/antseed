import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsPositionsCommand, slashColumn } from './positions.js';

test('positions lists open positions only and offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsPositionsCommand(ants);
  const positions = ants.commands.find((command) => command.name() === 'positions');
  assert.ok(positions);
  assert.equal(positions.options.find((option) => option.long === '--history'), undefined, 'no history scan flag');
  assert.ok(positions.options.some((option) => option.long === '--json'));
});

test('slashColumn shows the on-chain slash, marks estimates, and blanks closed positions', () => {
  assert.equal(slashColumn({ state: 'active', slashBps: 2916, projectedSlashBps: 3000 }), '29.16%');
  assert.equal(slashColumn({ state: 'pending', slashBps: null, projectedSlashBps: 3000 }), '30% (est.)');
  assert.equal(slashColumn({ state: 'matured', slashBps: 0, projectedSlashBps: 0 }), '—');
  assert.equal(slashColumn({ state: 'withdrawn', slashBps: null, projectedSlashBps: 0 }), '—');
});
