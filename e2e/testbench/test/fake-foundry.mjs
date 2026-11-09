// Stand-ins for `anvil` and `forge` on PATH, for start-up tests that must not depend on Foundry or on a rare race.
// The stand-in Anvil answers the few JSON-RPC calls the supervisor's local deploy makes; the stand-in forge can hang
// in `build`, or "broadcast" a deploy that Anvil mines four transactions of and then parks the other twenty, which
// is what the real pair did when the deploy stalled. Both record their pid and arguments, and exit by themselves
// after two minutes so a failed test cannot leave them behind.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const ANVIL = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('anvil Version: 0.0.0-fake'); process.exit(0); }
appendFileSync(join(process.env.TB_FAKE_FOUNDRY_DIR, 'anvil.jsonl'), JSON.stringify({ pid: process.pid, args }) + '\\n');
setTimeout(() => process.exit(0), 120_000).unref();
const state = { nonce: 0, block: 0, pending: 0, queued: 0 };
const hex = (value) => '0x' + value.toString(16);
const methods = {
  eth_chainId: () => '0x7a69',
  web3_clientVersion: () => 'anvil/v0.0.0-fake',
  eth_blockNumber: () => hex(state.block),
  eth_getTransactionCount: () => hex(state.nonce),
  txpool_status: () => ({ pending: hex(state.pending), queued: hex(state.queued) }),
  // What the stand-in forge calls to put the chain into the stalled state.
  fake_setState: ([next]) => { Object.assign(state, next); return true; },
};
createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const body = methods[method] ? { jsonrpc: '2.0', id, result: methods[method](params ?? []) } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'fake anvil has no ' + method } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
}).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1', () => console.log('Listening (fake anvil)'));
`;

const FORGE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('forge Version: 0.0.0-fake'); process.exit(0); }
appendFileSync(join(process.env.TB_FAKE_FOUNDRY_DIR, 'forge.jsonl'), JSON.stringify({ pid: process.pid, args }) + '\\n');
setTimeout(() => process.exit(0), 120_000).unref();
const mode = process.env.TB_FAKE_FORGE;
const hang = () => setInterval(() => {}, 1000);
(async () => {
  if (args[0] === 'build') {
    console.log('fake forge build');
    if (mode === 'hang-build') hang();
    return;
  }
  if (args[0] === 'script' && mode === 'park') {
    const url = args[args.indexOf('--rpc-url') + 1];
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fake_setState', params: [{ nonce: 4, block: 4, pending: 0, queued: 20 }] }) });
    console.log('fake forge script: broadcast 24 transactions, waiting for receipts');
    hang();
    return;
  }
  console.error('fake forge: nothing to do for ' + args.join(' '));
  process.exit(1);
})();
`;

/**
 * Writes the stand-ins into a fresh directory. `env(mode)` is the environment for a supervisor that should find them
 * (`mode`: 'park' parks the deploy's transactions, 'hang-build' never finishes `forge build`); `started(tool)` lists
 * the `{ pid, args }` of every stand-in process that ran.
 */
export function fakeFoundry() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-foundry-'));
  for (const [name, source] of [['anvil', ANVIL], ['forge', FORGE]]) {
    writeFileSync(join(dir, name), source);
    chmodSync(join(dir, name), 0o755);
  }
  return {
    dir,
    env: (mode) => ({ ...process.env, PATH: [dir, dirname(process.execPath), process.env.PATH].join(delimiter), TB_FAKE_FOUNDRY_DIR: dir, TB_FAKE_FORGE: mode }),
    started: (tool) => (existsSync(join(dir, `${tool}.jsonl`)) ? readFileSync(join(dir, `${tool}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
  };
}
