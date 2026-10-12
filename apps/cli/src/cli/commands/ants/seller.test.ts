import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsSellerCommand } from './seller.js';

test('seller shows state by default and exposes register and claim-starter', () => {
  const ants = new Command('ants');
  registerAntsSellerCommand(ants);
  const seller = ants.commands.find((command) => command.name() === 'seller');
  assert.ok(seller);
  assert.ok(seller.options.some((option) => option.long === '--json'));
  assert.deepEqual(seller.commands.map((command) => command.name()).sort(), ['claim-starter', 'register']);
  const register = seller.commands.find((command) => command.name() === 'register')!;
  assert.ok(register.options.some((option) => option.long === '--agent-id'));
  assert.equal(register.options.find((option) => option.long === '--agent-id')?.mandatory, false);
});
