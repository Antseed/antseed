#!/usr/bin/env node
// Runs the payment stress scenarios once each and fails when a run breaks a
// payment invariant or serves fewer requests than its floor. See README.md.
//
// usage: node e2e/stress/ci.mjs [--scenarios c32,c64,...] [--shard I/N] [--parallel N] [--out <dir>]
//                               [--tree <repo>] [--port-base N]
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareChainState } from './chain.mjs';
import { SCENARIOS, shardOf } from './scenarios.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// Share of requests that must succeed, and which failures a scenario may
// see. Every harness violation (unpaid or overpaid work, deposit mismatch,
// a channel left open, a crash, a stale #1050 row) fails the run.
const GATES = {
  c32: { minOk: 0.99 },
  c64: { minOk: 0.99 },
  smallreserve: { minOk: 0.99 },
  images: { minOk: 0.99 },
  // Faults are injected upstream: only those may fail.
  faults: { minOk: 0.7, allowedFailures: /^(500:server_error|502:Upstream error: fetch failed|stream-truncated)$/ },
  // Requests in flight while a peer restarts may fail; none outside that window.
  'restart-buyer': { minOk: 0.85, restart: true },
  'restart-seller': { minOk: 0.75, restart: true },
  'issue-1050': { minOk: 0.95 },
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function evaluate(name, result) {
  const gate = GATES[name] ?? { minOk: 0.99 };
  const problems = [];
  if (!result) return ['no result.json (harness crashed)'];
  if (result.harnessError) problems.push(`harness error: ${result.harnessError.split('\n')[0]}`);
  for (const v of result.violations ?? []) problems.push(`violation: ${v.kind}`);
  const client = result.client;
  if (client) {
    const okShare = client.ok / Math.max(1, client.total - client.clientAborted);
    if (okShare < gate.minOk) problems.push(`${client.ok}/${client.total} ok, below the ${Math.round(gate.minOk * 100)}% floor`);
    if (gate.allowedFailures) {
      for (const kind of Object.keys(client.failures)) {
        if (!gate.allowedFailures.test(kind)) problems.push(`unexpected failure kind: ${kind} (${client.failures[kind]})`);
      }
    }
    if (gate.restart && client.failedOutsideRestartWindow) problems.push(`${client.failedOutsideRestartWindow} failures outside the restart window`);
  } else if (!result.harnessError) {
    problems.push('no client results');
  }
  return problems;
}

function runScenario({ name, slot, out, tree, portBase }) {
  return new Promise((done) => {
    const log = createWriteStream(join(out, 'logs', `${name}.log`));
    const child = spawn(process.execPath, [join(HERE, 'harness.mjs'), '--scenario', name, '--label', name, '--slot', String(slot), '--out', out, '--tree', tree, '--port-base', String(portBase)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { log.write(d); process.stdout.write(`[${name}] ${d}`); });
    child.stderr.on('data', (d) => log.write(d));
    child.on('exit', (code) => {
      log.end();
      const file = join(out, 'runs', `${name}-1`, 'result.json');
      done({ name, code, result: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null });
    });
  });
}

const usd = (v) => (v == null ? '-' : `$${(Number(v) / 1e6).toFixed(2)}`);

function report(rows) {
  const lines = [
    '| Scenario | OK | Failures | Settled | Delivered, unpaid | p50 / p95 | Result |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const { name, result, problems } of rows) {
    const c = result?.client;
    const failures = c ? Object.entries(c.failures).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none' : '-';
    const latency = c?.p50 != null ? `${(c.p50 / 1000).toFixed(1)} s / ${(c.p95 / 1000).toFixed(1)} s` : '-';
    lines.push(`| ${name} | ${c ? `${c.ok}/${c.total}` : '-'} | ${failures} | ${usd(result?.money?.onchainSettled)} | ${usd(result?.money?.deliveredUnpaid)} | ${latency} | ${problems.length ? `❌ ${problems.join('; ')}` : '✅'} |`);
  }
  return lines.join('\n');
}

async function main() {
  const listed = arg('scenarios', Object.keys(GATES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of listed) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}; have ${Object.keys(SCENARIOS).join(', ')}`);
  const names = shardOf(listed, arg('shard'));
  if (names.length === 0) throw new Error(`--shard ${arg('shard')} selects none of the ${listed.length} scenarios`);
  console.log(`scenarios: ${names.join(', ')}`);
  const parallel = Math.max(1, Number(arg('parallel', '1')));
  const out = resolve(arg('out', join(tmpdir(), 'antseed-stress-ci')));
  // The checkout whose CLI seller and buyer run; contracts always come from this one.
  const tree = resolve(arg('tree', resolve(HERE, '../..')));
  const portBase = Number(arg('port-base', '27545'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'logs'), { recursive: true });

  // Deploy once; every run loads this state into its own anvil.
  await prepareChainState({ port: portBase + 9 * 10, contractsDir: resolve(HERE, '../../packages/contracts'), stateFile: join(out, 'chain-state.json') });

  const queue = [...names];
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async (_, slot) => {
    while (queue.length > 0) {
      const name = queue.shift();
      const { result } = await runScenario({ name, slot, out, tree, portBase });
      rows.push({ name, result, problems: evaluate(name, result) });
    }
  }));
  rows.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));

  const table = report(rows);
  console.log(`\n${table}\n\nLogs and per-run results: ${out}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Payment stress\n\n${table}\n`);
  const failed = rows.filter((r) => r.problems.length > 0);
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
