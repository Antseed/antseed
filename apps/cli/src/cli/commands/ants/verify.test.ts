import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { AntsContext } from '@antseed/ants';
import { registerAntsVerifyCommand } from './verify.js';

test('verify inspects a seller by default and exposes submit and proof', () => {
  const ants = new Command('ants');
  registerAntsVerifyCommand(ants);
  const verify = ants.commands.find((command) => command.name() === 'verify');
  assert.ok(verify);
  assert.equal(verify.registeredArguments[0]?.name(), 'seller');
  assert.equal(verify.registeredArguments[0]?.required, false);
  assert.deepEqual(verify.commands.map((command) => command.name()).sort(), ['proof', 'submit']);
});

test('verify submit asks for confirmation unless --yes is given', () => {
  const ants = new Command('ants');
  registerAntsVerifyCommand(ants);
  const submit = ants.commands.find((command) => command.name() === 'verify')!.commands.find((command) => command.name() === 'submit')!;
  assert.deepEqual(submit.registeredArguments.map((argument) => argument.name()), ['artifact']);
  const yes = submit.options.find((option) => option.long === '--yes');
  assert.ok(yes);
  assert.equal(yes.defaultValue, false);
});

test('proof prints JSON when the parent consumes the nested --json flag', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-proof-json-'));
  const config = join(dataDir, 'config.json');
  await writeFile(config, JSON.stringify({ payments: { crypto: { chainId: 'base-local' } } }));
  const ants = new Command('ants').option('--config <path>', 'config', config).option('--data-dir <path>', 'wallet', dataDir);
  registerAntsVerifyCommand(ants);
  const proofId = `0x${'a'.repeat(64)}`;
  const status = { proofId, staged: true, finalized: false, authenticatedBlockReferenceCount: 2, authenticatedBlockChunkCount: 1 };
  const selectRpc = mock.method(AntsContext.prototype, 'selectRpc', async () => {});
  const registry = mock.method(AntsContext.prototype, 'washRegistry', () => ({ proofStatus: async () => status }) as never);
  const output: string[] = [];
  const log = mock.method(console, 'log', (value: string) => { output.push(value); });
  try {
    await ants.parseAsync(['verify', 'proof', proofId, '--json'], { from: 'user' });
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]!), status);
  } finally {
    selectRpc.mock.restore();
    registry.mock.restore();
    log.mock.restore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
