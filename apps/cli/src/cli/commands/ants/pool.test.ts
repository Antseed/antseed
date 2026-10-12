import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsPoolCommand } from './pool.js';

test('pool takes an agent id and offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsPoolCommand(ants);
  const pool = ants.commands.find((command) => command.name() === 'pool');
  assert.ok(pool);
  assert.deepEqual(pool.registeredArguments.map((argument) => argument.name()), ['agentId']);
  assert.ok(pool.options.some((option) => option.long === '--json'));
});
