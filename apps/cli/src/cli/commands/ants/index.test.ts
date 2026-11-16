import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsCommands } from './index.js';

function antsCommand(): Command {
  const program = new Command();
  registerAntsCommands(program);
  return program.commands.find((command) => command.name() === 'ants')!;
}

test('antseed ants registers the dashboard plus every staking, reward, pool, seller, and verification subcommand', () => {
  const ants = antsCommand();
  assert.ok(ants);
  const names = ants.commands.map((command) => command.name()).sort();
  assert.deepEqual(names, [
    'addresses', 'emissions', 'extend', 'max-lock', 'merge', 'move', 'pool', 'pools', 'positions',
    'rewards', 'seller', 'split', 'stake', 'status', 'usage', 'verify', 'withdraw',
  ]);
});

test('every subcommand has a description', () => {
  for (const command of antsCommand().commands) {
    assert.ok(command.description().length > 0, `${command.name()} description`);
  }
});
