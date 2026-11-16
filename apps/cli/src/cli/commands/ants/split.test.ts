import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsSplitCommand } from './split.js';

test('split takes a position id and the amount to carve out', () => {
  const ants = new Command('ants');
  registerAntsSplitCommand(ants);
  const split = ants.commands.find((command) => command.name() === 'split');
  assert.ok(split);
  assert.deepEqual(split.registeredArguments.map((argument) => argument.name()), ['id', 'amount']);
  assert.ok(split.registeredArguments.every((argument) => argument.required));
});
