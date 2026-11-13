import assert from 'node:assert/strict';
import test from 'node:test';
import { Command, CommanderError } from 'commander';
import { DEFAULT_ANTS_PORT, registerAntsDashboardAction } from './dashboard.js';

test('antseed ants registers a port, --no-open and an optional --address pin', () => {
  const ants = new Command('ants');
  registerAntsDashboardAction(ants);
  const port = ants.options.find((option) => option.long === '--port');
  assert.ok(port);
  assert.equal(port.defaultValue, String(DEFAULT_ANTS_PORT));
  assert.equal(DEFAULT_ANTS_PORT, 3119);
  assert.ok(ants.options.some((option) => option.long === '--no-open'));
  assert.ok(ants.options.some((option) => option.long === '--address'));
  assert.ok(!ants.options.some((option) => option.long === '--local-address'));
});

test('help and CLI subcommands work without dashboard flags', async () => {
  let output = '';
  const command = new Command('ants').exitOverride().configureOutput({ writeOut: text => { output += text; } });
  registerAntsDashboardAction(command);
  await assert.rejects(command.parseAsync(['--help'], { from: 'user' }), error => error instanceof CommanderError && error.exitCode === 0);
  assert.match(output, /--address/);
  let ran = false;
  command.command('status').action(() => { ran = true; });
  await command.parseAsync(['status'], { from: 'user' });
  assert.equal(ran, true);
});

function dashboardCommand() {
  const command = new Command('ants').exitOverride().configureOutput({ writeErr: () => {} });
  registerAntsDashboardAction(command);
  command.action(() => {});
  return command;
}

test('plain antseed ants parses without an account flag', () => {
  const command = dashboardCommand().parse([], { from: 'user' });
  assert.equal(command.opts().address, undefined);
});

test('--address validates and checksums the pinned account', () => {
  const address = '0x00000000000000000000000000000000000000ab';
  const command = dashboardCommand();
  command.parse(['--address', address], { from: 'user' });
  assert.equal(command.opts().address, '0x00000000000000000000000000000000000000AB');
  for (const value of ['bad', '0x0000000000000000000000000000000000000000']) {
    assert.throws(() => dashboardCommand().parse(['--address', value], { from: 'user' }), /non-zero Ethereum address/);
  }
});

test('--address cannot silently apply to CLI transaction subcommands', () => {
  const command = dashboardCommand();
  command.command('stake').action(() => assert.fail('Must not run a transaction subcommand'));
  assert.throws(() => command.parse(['--address', '0x00000000000000000000000000000000000000ab', 'stake'], { from: 'user' }), /only applies to the dashboard/);
});
