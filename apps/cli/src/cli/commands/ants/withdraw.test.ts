import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { registerAntsWithdrawCommand, withdrawDecision } from './withdraw.js';

test('withdraw keeps the safety flags explicit and off by default', () => {
  const ants = new Command('ants');
  registerAntsWithdrawCommand(ants);
  const withdraw = ants.commands.find((command) => command.name() === 'withdraw');
  assert.ok(withdraw);
  for (const flag of ['--accept-slashing', '--yes', '--preview']) {
    const defaultValue: unknown = withdraw.options.find((entry) => entry.long === flag)?.defaultValue;
    assert.equal(defaultValue, false, `${flag} defaults off`);
  }
});

test('withdrawDecision sends matured positions without ceremony', () => {
  assert.equal(withdrawDecision({ earlyExit: false }, { acceptSlashing: false, yes: false, preview: false }), 'send');
});

test('withdrawDecision refuses an early exit unless slashing is accepted', () => {
  assert.throws(() => withdrawDecision({ earlyExit: true }, { acceptSlashing: false, yes: false, preview: false }), /--accept-slashing/);
  assert.throws(() => withdrawDecision({ earlyExit: true }, { acceptSlashing: false, yes: true, preview: false }), /--accept-slashing/);
});

test('withdrawDecision asks before an accepted early exit unless --yes is given', () => {
  assert.equal(withdrawDecision({ earlyExit: true }, { acceptSlashing: true, yes: false, preview: false }), 'confirm');
  assert.equal(withdrawDecision({ earlyExit: true }, { acceptSlashing: true, yes: true, preview: false }), 'send');
});

test('withdrawDecision never sends in preview mode', () => {
  assert.equal(withdrawDecision({ earlyExit: true }, { acceptSlashing: true, yes: true, preview: true }), 'preview');
  assert.equal(withdrawDecision({ earlyExit: false }, { acceptSlashing: false, yes: false, preview: true }), 'preview');
});
