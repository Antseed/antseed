import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsMergeCommand } from './merge.js';

test('merge takes a variadic list of position ids and no options', () => {
  const ants = new Command('ants');
  registerAntsMergeCommand(ants);
  const merge = ants.commands.find((command) => command.name() === 'merge');
  assert.ok(merge);
  const ids = merge.registeredArguments[0];
  assert.ok(ids);
  assert.equal(ids.name(), 'ids');
  assert.ok(ids.variadic);
  assert.deepEqual(merge.options, []);
});
