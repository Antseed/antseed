import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { poolLabel, registerAntsPoolsCommand } from './pools.js';

test('pools offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsPoolsCommand(ants);
  const pools = ants.commands.find((command) => command.name() === 'pools');
  assert.ok(pools);
  assert.ok(pools.options.some((option) => option.long === '--json'));
});

test('poolLabel prefers the explorer name, then a short seller address', () => {
  const seller = '0x1234567890abcdef1234567890abcdef12345678';
  assert.equal(poolLabel({ profile: { name: 'Flash' } as never, seller }), 'Flash');
  assert.equal(poolLabel({ profile: null, seller }), '0x1234…5678');
  assert.equal(poolLabel({ profile: null, seller: null }), 'unbound');
});
