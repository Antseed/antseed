import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsAddressesCommand } from './addresses.js';

test('addresses offers JSON output', () => {
  const ants = new Command('ants');
  registerAntsAddressesCommand(ants);
  const addresses = ants.commands.find((command) => command.name() === 'addresses');
  assert.ok(addresses);
  assert.ok(addresses.options.some((option) => option.long === '--json'));
});
