import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsMoveCommand } from './move.js';

test('move accepts several position ids and requires a destination pool', () => {
  const ants = new Command('ants');
  registerAntsMoveCommand(ants);
  const move = ants.commands.find((command) => command.name() === 'move');
  assert.ok(move);
  const ids = move.registeredArguments[0];
  assert.ok(ids);
  assert.equal(ids.name(), 'ids');
  assert.ok(ids.variadic);
  assert.ok(move.options.find((option) => option.long === '--to')?.mandatory, '--to is required');
});
