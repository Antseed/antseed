import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsStakeCommand } from './stake.js';

test('stake takes an ANTS amount and requires a pool agent and lock length', () => {
  const ants = new Command('ants');
  registerAntsStakeCommand(ants);
  const stake = ants.commands.find((command) => command.name() === 'stake');
  assert.ok(stake);
  assert.deepEqual(stake.registeredArguments.map((argument) => argument.name()), ['amount']);
  const agent = stake.options.find((option) => option.long === '--agent');
  const epochs = stake.options.find((option) => option.long === '--epochs');
  assert.ok(agent?.mandatory, '--agent is required');
  assert.ok(epochs?.mandatory, '--epochs is required');
  assert.match(stake.description(), /ANTS/);
});
