import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTRACTS_ROOT, REPOSITORY_ROOT } from './deployments/runtime/paths.mjs';

// Runs scripts/verify-contract-bytecode.mjs against a fixture ledger, with a fake `cast` on PATH
// that serves on-chain code from a fixture instead of an RPC. Uses one real artifact from the
// local `forge build`, which `pnpm contracts:check` runs before these tests.
const ARTIFACT = path.join(CONTRACTS_ROOT, 'out/AntseedVerificationResults.sol/AntseedVerificationResults.json');
const skip = existsSync(ARTIFACT) ? false : 'run `forge build` in packages/contracts first';

const LIVE = '0x1111111111111111111111111111111111111111';
const SUPERSEDED = '0x2222222222222222222222222222222222222222';
const REMOVED = '0x3333333333333333333333333333333333333333';
const OLD_HASH = `0x${'ab'.repeat(32)}`;
const REMOVED_CODE = '0x60806040';
const REMOVED_HASH = `0x${'cd'.repeat(32)}`;

function deployed(address, runtimeCodeHash) {
  return { address, deployedInRelease: true, runtimeCodeHash };
}

async function runVerifier(t, { code, codehash }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-verify-bytecode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const network = path.join(directory, 'deployments', 'test-net');
  await mkdir(path.join(network, 'history'), { recursive: true });
  // `verificationResults` was redeployed: current.json points at the new address. The removed
  // contract stays in current.json, but this repository no longer has its source.
  await writeFile(path.join(network, 'current.json'), JSON.stringify({
    release: '002-new',
    contracts: { verificationResults: { address: LIVE }, removedContract: { address: REMOVED } },
  }));
  await writeFile(path.join(network, 'history', '001-old.json'), JSON.stringify({
    release: '001-old',
    contracts: {
      verificationResults: deployed(SUPERSEDED, OLD_HASH),
      removedContract: deployed(REMOVED, REMOVED_HASH),
    },
  }));
  await writeFile(path.join(network, 'history', '002-new.json'), JSON.stringify({
    release: '002-new',
    contracts: { verificationResults: deployed(LIVE, `0x${'ef'.repeat(32)}`) },
  }));

  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const state = path.join(directory, 'chain.json');
  await writeFile(state, JSON.stringify({ code, codehash }));
  await writeFile(path.join(bin, 'cast'), [
    `#!${process.execPath}`,
    "const { readFileSync } = require('node:fs');",
    `const chain = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));`,
    'const [command, address] = process.argv.slice(2);',
    "process.stdout.write(chain[command]?.[address.toLowerCase()] ?? '0x');",
  ].join('\n'));
  await chmod(path.join(bin, 'cast'), 0o755);

  const result = spawnSync(process.execPath, ['scripts/verify-contract-bytecode.mjs'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CONTRACT_DEPLOYMENTS_ROOT: path.join(directory, 'deployments'),
      TEST_NET_RPC_URL: 'http://fake-rpc.invalid',
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function localCode() {
  return JSON.parse(await readFile(ARTIFACT, 'utf8')).deployedBytecode.object;
}

/** The local build with its last byte changed: same length, different code. */
async function otherCode() {
  const code = await localCode();
  return `${code.slice(0, -2)}${code.endsWith('00') ? '01' : '00'}`;
}

test('superseded and removed contracts are checked against their recorded code hash, not the local build', { skip }, async (t) => {
  const { status, output } = await runVerifier(t, {
    code: { [LIVE]: await localCode(), [SUPERSEDED]: await otherCode(), [REMOVED]: REMOVED_CODE },
    codehash: { [SUPERSEDED]: OLD_HASH, [REMOVED]: REMOVED_HASH },
  });
  assert.equal(status, 0, output);
  assert.match(output, /\[ok\] test-net\/002-new\.json verificationResults: matches 0x1111/);
  assert.match(output, /\[ok\] test-net\/001-old\.json verificationResults: superseded; code hash matches the record/);
  assert.match(output, /\[ok\] test-net\/001-old\.json removedContract: no local source; code hash matches the record/);
});

test('a superseded contract whose on-chain code hash differs from its record fails', { skip }, async (t) => {
  const { status, output } = await runVerifier(t, {
    code: { [LIVE]: await localCode(), [SUPERSEDED]: await otherCode(), [REMOVED]: REMOVED_CODE },
    codehash: { [SUPERSEDED]: `0x${'00'.repeat(32)}`, [REMOVED]: REMOVED_HASH },
  });
  assert.notEqual(status, 0);
  assert.match(output, /\[FAIL\] test-net\/001-old\.json verificationResults: on-chain code hash 0x0{64} != recorded/);
});

test('a live contract is still compared with the local build', { skip }, async (t) => {
  const { status, output } = await runVerifier(t, {
    code: { [LIVE]: await otherCode(), [SUPERSEDED]: await otherCode(), [REMOVED]: REMOVED_CODE },
    codehash: { [SUPERSEDED]: OLD_HASH, [REMOVED]: REMOVED_HASH },
  });
  assert.notEqual(status, 0);
  assert.match(output, /\[FAIL\] test-net\/002-new\.json verificationResults: runtime code differs from the local build/);
});
