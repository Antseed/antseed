import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerSellerCommands } from './index.js';
import { registerNetworkCommands } from '../network/index.js';
import { registerBuyerCommands } from '../buyer/index.js';

function sellerCommand(): Command {
  const program = new Command();
  registerSellerCommands(program);
  return program.commands.find((command) => command.name() === 'seller')!;
}

function findCommand(parent: Command, name: string): Command | undefined {
  return parent.commands.find((command) => command.name() === name);
}

test('seller stake only accepts ANTS and a lock duration, not an identity override', () => {
  const stake = findCommand(sellerCommand(), 'stake');
  assert.ok(stake);
  assert.ok(stake!.options.some((option) => option.long === '--epochs'));
  assert.match(stake.description(), /ANTS/);
  assert.doesNotMatch(stake.description(), /USDC/);
  assert.equal(stake.options.find((option) => option.long === '--agent-id'), undefined);
});

test('legacy USDC staking lives under seller legacy', () => {
  const legacy = findCommand(sellerCommand(), 'legacy');
  assert.ok(legacy);
  assert.ok(findCommand(legacy!, 'stake'));
  assert.ok(findCommand(legacy!, 'unstake'));
});

test('seller unstake is only available under legacy', () => {
  assert.equal(findCommand(sellerCommand(), 'unstake'), undefined);
});

test('aggregate rewards is the only seller reward command', () => {
  const seller = sellerCommand();
  const help = seller.helpInformation();
  assert.match(help, /rewards/);
  assert.doesNotMatch(help, /\n\s+emissions\s/);
  assert.doesNotMatch(help, /\n\s+unstake\s/);
  const pool = findCommand(seller, 'pool')!;
  assert.equal(findCommand(seller, 'emissions'), undefined);
  assert.equal(findCommand(pool, 'rewards'), undefined);
  assert.doesNotMatch(pool.helpInformation(), /\n\s+rewards/);
});

test('claim-starter lives under legacy without aliases', () => {
  const seller = sellerCommand();
  const pool = findCommand(seller, 'pool')!;
  const legacy = findCommand(seller, 'legacy')!;
  const claimStarter = findCommand(legacy, 'claim-starter');
  assert.ok(claimStarter);
  assert.deepEqual(claimStarter.aliases(), []);
  assert.equal(findCommand(pool, 'claim-starter'), undefined);
  assert.equal(findCommand(pool, 'stake'), undefined);
});

test('seller rewards provides the minimal aggregate reward surface', () => {
  const rewards = findCommand(sellerCommand(), 'rewards');
  assert.ok(rewards);
  assert.ok(findCommand(rewards!, 'claim'));
  assert.deepEqual(findCommand(rewards!, 'claim')!.options, []);
});

for (const args of [
  ['seller', 'unstake'],
  ['seller', 'emissions', 'info'],
  ['seller', 'pool', 'bootstrap'],
  ['seller', 'pool', 'init'],
  ['seller', 'pool', 'claim-starter'],
  ['seller', 'pool', 'rewards'],
  ['seller', 'pool', 'rewards', 'claim'],
  ['seller', 'legacy', 'bootstrap'],
  ['seller', 'legacy', 'init'],
  ['seller', 'stake', '100', '--epochs', '4', '--agent-id', '7'],
  ['seller', 'rewards', 'claim', '--position', '1'],
  ['seller', 'rewards', 'claim', '--recipient', '0x0000000000000000000000000000000000000001'],
  ['network', 'contracts'],
]) {
  test(`removed command or option is rejected before execution: ${args.join(' ')}`, async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerSellerCommands(program);
    registerNetworkCommands(program);
    await assert.rejects(program.parseAsync(args, { from: 'user' }), (error: { code?: string }) =>
      error.code === 'commander.unknownCommand' || error.code === 'commander.unknownOption');
  });
}

test('buyer emissions and its era filters remain available', () => {
  const program = new Command();
  registerBuyerCommands(program);
  const buyer = findCommand(program, 'buyer')!;
  const emissions = findCommand(buyer, 'emissions')!;
  for (const command of ['info', 'claim']) {
    const options = findCommand(emissions, command)!.options;
    assert.ok(options.some((option) => option.long === '--legacy-only'));
    assert.ok(options.some((option) => option.long === '--new-only'));
  }
});

test('pool withdrawal requires explicit slashing consent instead of force', () => {
  const pool = findCommand(sellerCommand(), 'pool')!;
  const withdraw = findCommand(pool, 'withdraw')!;
  assert.ok(withdraw.options.some((option) => option.long === '--accept-slashing'));
  assert.ok(withdraw.options.some((option) => option.long === '--yes'));
  assert.ok(!withdraw.options.some((option) => option.long === '--force'));
});
