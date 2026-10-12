import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsEmissionsCommand, sharePercent } from './emissions.js';

test('emissions offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsEmissionsCommand(ants);
  const emissions = ants.commands.find((command) => command.name() === 'emissions');
  assert.ok(emissions);
  assert.ok(emissions.options.some((option) => option.long === '--json'));
});

test('sharePercent renders 1/100000 shares as percentages', () => {
  assert.equal(sharePercent(2000, 100_000), '2%');
  assert.equal(sharePercent(12_500, 100_000), '12.5%');
  assert.equal(sharePercent(5000, 10_000), '50%');
});
