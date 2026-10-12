import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { DEFAULT_USAGE_EPOCHS, registerAntsUsageCommand } from './usage.js';

test('usage looks back a fixed number of epochs by default', () => {
  const ants = new Command('ants');
  registerAntsUsageCommand(ants);
  const usage = ants.commands.find((command) => command.name() === 'usage');
  assert.ok(usage);
  const epochs = usage.options.find((option) => option.long === '--epochs');
  assert.ok(epochs);
  assert.equal(epochs.defaultValue, DEFAULT_USAGE_EPOCHS);
  assert.ok(usage.options.some((option) => option.long === '--json'));
});
