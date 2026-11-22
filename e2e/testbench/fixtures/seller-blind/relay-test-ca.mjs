#!/usr/bin/env node
// Test only: runs this worktree's keyed-relay sidecar and adds the keyed-relay test CA to its start message, so it
// trusts the local TLS upstream (mock-upstream.mjs). Set as TESTBENCH_KEYED_RELAY_BIN for `seller-blind-relay` and `stress-seller-blind-relay`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const keyedRelay = (path) => fileURLToPath(new URL(`../../../../packages/keyed-relay/${path}`, import.meta.url));
const sidecar = keyedRelay(`native/target/release/antseed-keyed-relay${process.platform === 'win32' ? '.exe' : ''}`);
const ca = readFileSync(keyedRelay('test/fixtures/ca.pem'), 'utf8');

const child = spawn(sidecar, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
let pending = Buffer.alloc(0);
let patched = false;
// Frames are a kind byte, a 4-byte length and the payload; the first one from Node is the CTL `start` message.
process.stdin.on('data', (data) => {
  if (patched) { child.stdin.write(data); return; }
  pending = Buffer.concat([pending, data]);
  if (pending.length < 5) return;
  const length = pending.readUInt32BE(1);
  if (pending.length < 5 + length) return;
  let payload = pending.subarray(5, 5 + length);
  if (pending[0] === 0) {
    try {
      const message = JSON.parse(payload.toString('utf8'));
      if (message.type === 'start') payload = Buffer.from(JSON.stringify({ ...message, extraRootsPem: ca }), 'utf8');
    } catch {
      // Not a start message: passed on as it came.
    }
  }
  const header = Buffer.alloc(5);
  header[0] = pending[0];
  header.writeUInt32BE(payload.length, 1);
  child.stdin.write(Buffer.concat([header, payload, pending.subarray(5 + length)]));
  pending = Buffer.alloc(0);
  patched = true;
});
process.stdin.on('end', () => child.stdin.end());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
// Ends the way the sidecar ended, so the caller sees the exit it would see without this wrapper.
child.on('exit', (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); return; }
  process.exit(code ?? 0);
});
