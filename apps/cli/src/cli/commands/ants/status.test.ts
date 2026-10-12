import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { formatDuration, phaseLabel, registerAntsStatusCommand } from './status.js';

test('status offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsStatusCommand(ants);
  const status = ants.commands.find((command) => command.name() === 'status');
  assert.ok(status);
  assert.ok(status.options.some((option) => option.long === '--json'));
});

test('formatDuration drops the day component under one day', () => {
  assert.equal(formatDuration(90_061), '1d 1h 1m');
  assert.equal(formatDuration(3_660), '1h 1m');
  assert.equal(formatDuration(59), '0h 0m');
});

test('phaseLabel names the cutover epoch while deployed', () => {
  const epoch = { effective: 22 };
  assert.equal(phaseLabel({ phase: 'legacy', epoch }), 'legacy emissions only');
  assert.equal(phaseLabel({ phase: 'deployed', epoch }), 'deployed, activates at epoch 22');
  assert.equal(phaseLabel({ phase: 'active', epoch }), 'recognized usage active');
});
