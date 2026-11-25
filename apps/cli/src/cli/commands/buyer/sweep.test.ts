import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerBuyerSweepCommand } from './sweep.js';
import { createDefaultConfig } from '../../../config/defaults.js';
import { validateConfig } from '../../../config/validation.js';

test('buyer sweep command registers with expected options', () => {
  const buyerCmd = new Command('buyer');
  registerBuyerSweepCommand(buyerCmd);

  const sweep = buyerCmd.commands.find((c) => c.name() === 'sweep');
  assert.ok(sweep, 'sweep subcommand registered');
  const optionNames = sweep!.options.map((o) => o.long);
  assert.ok(optionNames.includes('--amount'));
  assert.ok(optionNames.includes('--timeout'));
  assert.ok(!optionNames.includes('--max-fee'), 'fixed-fee design has no --max-fee');
});

test('default config enables the relayer and passes validation', () => {
  const config = createDefaultConfig();
  assert.equal(config.relayer?.enabled, true);
  assert.deepEqual(validateConfig(config), []);
});

test('relayer config validation rejects malformed values', () => {
  const config = createDefaultConfig();
  config.relayer = {
    enabled: 'yes' as unknown as boolean,
    minProfitBaseUnits: '1.5',
    maxInFlight: 0,
    maxPerPeerPerMinute: 1.5,
  };
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('relayer.enabled')));
  assert.ok(errors.some((e) => e.includes('relayer.minProfitBaseUnits')));
  assert.ok(errors.some((e) => e.includes('relayer.maxInFlight')));
  assert.ok(errors.some((e) => e.includes('relayer.maxPerPeerPerMinute')));
});

test('relayer config accepts valid values including negative min profit', () => {
  const config = createDefaultConfig();
  config.relayer = {
    enabled: false,
    minProfitBaseUnits: '-100000000',
    maxInFlight: 3,
    maxPerPeerPerMinute: 10,
  };
  assert.deepEqual(validateConfig(config), []);
});
