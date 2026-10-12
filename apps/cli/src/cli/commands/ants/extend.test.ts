import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsExtendCommand } from './extend.js';

test('extend takes one position id and requires the number of extra epochs', () => {
  const ants = new Command('ants');
  registerAntsExtendCommand(ants);
  const extend = ants.commands.find((command) => command.name() === 'extend');
  assert.ok(extend);
  assert.deepEqual(extend.registeredArguments.map((argument) => argument.name()), ['id']);
  assert.ok(extend.options.find((option) => option.long === '--epochs')?.mandatory, '--epochs is required');
});
