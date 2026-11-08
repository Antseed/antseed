import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ANVIL_FEE_ARGS, ANVIL_SIGNED_FEES, ANVIL_SIGNED_RPC_FEES, AnvilSigner } from '../lib/chain.mjs';
import { freePort } from '../lib/env.mjs';

const { JsonRpcProvider } = createRequire(import.meta.url)('ethers');
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
// Not one of Anvil's unlocked dev accounts: sends go out by impersonation, as the testbench's owner and funding sends do.
const IMPERSONATED = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';

describe('transactions Anvil signs (impersonated accounts)', { skip: !hasAnvil && 'anvil is not on PATH' }, () => {
  let anvil;
  let provider;
  let version;
  before(async () => {
    version = spawnSync('anvil', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
    const port = await freePort();
    // The testbench's own flags: Anvil 1.9 rejects its own fill of a fee-less send on this chain.
    anvil = spawn('anvil', ['--chain-id', '31337', '--host', '127.0.0.1', '--port', String(port), ...ANVIL_FEE_ARGS, '--silent'], { stdio: 'ignore' });
    provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
    provider.pollingInterval = 50;
    for (let attempt = 0; ; attempt += 1) {
      try { await provider.send('eth_chainId', []); break; } catch (error) { if (attempt > 100) throw error; await new Promise((r) => setTimeout(r, 100)); }
    }
    await provider.send('anvil_setBalance', [IMPERSONATED, '0x56BC75E2D63100000']);
    await provider.send('anvil_impersonateAccount', [IMPERSONATED]);
  });
  after(() => { provider?.destroy(); anvil?.kill(); });

  it(`AnvilSigner sends with explicit zero fees and is mined (${hasAnvil ? 'this anvil' : 'no anvil'})`, async () => {
    const signer = new AnvilSigner(provider, IMPERSONATED);
    const sent = await signer.sendTransaction({ to: TO, value: 1n });
    const receipt = await sent.wait();
    assert.equal(receipt.status, 1, version);
    const tx = await provider.send('eth_getTransactionByHash', [sent.hash]);
    assert.equal(BigInt(tx.maxFeePerGas), ANVIL_SIGNED_FEES.maxFeePerGas);
    assert.equal(BigInt(tx.maxPriorityFeePerGas), ANVIL_SIGNED_FEES.maxPriorityFeePerGas);
  });

  it('keeps fees a send sets itself', async () => {
    const signer = new AnvilSigner(provider, IMPERSONATED);
    const sent = await signer.sendTransaction({ to: TO, value: 1n, gasPrice: 0n });
    assert.equal((await sent.wait()).status, 1);
    assert.equal(BigInt((await provider.send('eth_getTransactionByHash', [sent.hash])).gasPrice), 0n);
  });

  it('a raw eth_sendTransaction with ANVIL_SIGNED_RPC_FEES is mined (sendContractAs)', async () => {
    const hash = await provider.send('eth_sendTransaction', [{ from: IMPERSONATED, to: TO, value: '0x1', ...ANVIL_SIGNED_RPC_FEES }]);
    assert.equal((await provider.waitForTransaction(hash, 1, 10_000)).status, 1);
  });
});

describe('testbench sources', () => {
  it('send Anvil-signed transactions only through AnvilSigner or with explicit fees', () => {
    const root = dirname(fileURLToPath(new URL('../cli.mjs', import.meta.url)));
    const files = ['cli.mjs', 'supervisor.mjs', 'share-host.mjs', 'seller-worker.mjs', ...readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`), ...readdirSync(join(root, 'scenarios')).map((f) => `scenarios/${f}`)];
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      assert.doesNotMatch(text, /\.getSigner\(/, `${file}: use AnvilSigner (lib/chain.mjs), Anvil 1.9 rejects its own fee fill`);
      for (const line of text.split('\n').filter((l) => /send\('eth_sendTransaction'/.test(l))) {
        assert.match(line, /ANVIL_SIGNED_RPC_FEES|maxFeePerGas|gasPrice/, `${file}: ${line.trim()}`);
      }
    }
  });
});
