import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { parsePositiveInteger } from '../parse-positive-integer.js';
import { registerAntsCommands } from './index.js';

async function parse(args: string[]): Promise<Record<string, unknown>> {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerAntsCommands(program);
  let options: Record<string, unknown> = {};
  const capture = (command: Command) => {
    command.action(() => { options = command.opts(); });
    for (const child of command.commands) capture(child);
  };
  capture(program);
  await program.parseAsync(['ants', ...args], { from: 'user' });
  return options;
}

test('usage epochs are decimal regardless of the default or previous value', async () => {
  assert.equal((await parse(['usage'])).epochs, 8);
  assert.equal((await parse(['usage', '--epochs', '10'])).epochs, 10);
  assert.equal((await parse(['usage', '--epochs', '8'])).epochs, 8);
  assert.equal((await parse(['usage', '--epochs', '7', '--epochs', '10'])).epochs, 10);
});

test('repeated destination and epoch options use the last decimal value', async () => {
  assert.deepEqual(await parse(['stake', '1', '--agent', '7', '--agent', '10', '--epochs', '4', '--epochs', '12']), { agent: 10, epochs: 12 });
  assert.equal((await parse(['move', '1', '--to', '7', '--to', '10'])).to, 10);
  assert.equal((await parse(['rewards', 'compound', '--epochs', '4', '--to', '7', '--to', '10'])).to, 10);
});

test('integer parsing rejects malformed, fractional, zero, negative, and unsafe values', () => {
  for (const value of ['12garbage', '4.8', '1e2', '0x10', '0', '-1', '', ' ', '9007199254740992']) {
    assert.throws(() => parsePositiveInteger(value), /positive safe integer/);
  }
  assert.equal(parsePositiveInteger('10'), 10);
});

test('invalid numeric flags fail during parsing before a command action runs', async () => {
  for (const args of [
    ['stake', '1', '--agent', '12garbage', '--epochs', '4'],
    ['stake', '1', '--agent', '7', '--epochs', '4.8'],
    ['move', '1', '--to', '12garbage'],
    ['extend', '1', '--epochs', '4.8'],
    ['usage', '--epochs', '0'],
    ['rewards', 'restake', '--epochs', '4.8'],
    ['rewards', 'compound', '--epochs', '4', '--to', '12garbage'],
    ['rewards', 'stake-usage', '--side', 'buyer', '--epochs', '4', '--agent', '12garbage'],
    ['seller', 'register', '--agent-id', '12garbage'],
  ]) {
    await assert.rejects(parse(args), { code: 'commander.invalidArgument' });
  }
});
