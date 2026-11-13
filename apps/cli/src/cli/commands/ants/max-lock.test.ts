import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsMaxLockCommand } from './max-lock.js';

test('max-lock enables by default and disables with --off', () => {
  const ants = new Command('ants');
  registerAntsMaxLockCommand(ants);
  const maxLock = ants.commands.find((command) => command.name() === 'max-lock');
  assert.ok(maxLock);
  assert.deepEqual(maxLock.registeredArguments.map((argument) => argument.name()), ['id']);
  const off = maxLock.options.find((option) => option.long === '--off');
  assert.ok(off);
  assert.equal(off.defaultValue, false);
});
