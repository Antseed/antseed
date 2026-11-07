import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyScenarioError, computeDrift, deliveryMetrics, driftLines, gitInfo, previousReport, recordTeardownFailure, rerunCommand, RESULT_EXIT_CODES, runWithTimeout, RunTimeoutError } from '../lib/report.mjs';
import { writeHtmlReport } from '../lib/report-html.mjs';
import { reportFilePath, serveReports } from '../lib/report-server.mjs';

const report = {
  scenario: 'desktop-chat', description: 'x <b>', result: 'failed', testbench: 'wt-a', upstream: 'mock', forkBlock: 1,
  startedAt: 's', finishedAt: 'f', error: 'boom <script>',
  checks: [{ name: 'ok one', ok: true }, { name: 'bad one', ok: false, detail: { a: '<i>' } }],
  knownIssues: [{ name: 'tracked', ok: false, issue: 'bug-1' }], metrics: { latency: 5 },
};

describe('html report', () => {
  it('renders checks, media and escapes untrusted text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    await mkdir(join(dir, 'screenshots'));
    await mkdir(join(dir, 'video'));
    await writeFile(join(dir, 'screenshots', '01-launched.png'), '');
    await writeFile(join(dir, 'video', 'desktop.webm'), '');
    await writeFile(join(dir, 'events.jsonl'), '{"type":"chat"}\n');
    const html = await readFile(await writeHtmlReport(dir, report), 'utf8');
    assert.match(html, /FAILED/);
    assert.match(html, /screenshots\/01-launched\.png/);
    assert.match(html, /<video src="video\/desktop\.webm"/);
    assert.match(html, /KNOWN/);
    assert.doesNotMatch(html, /<script>|<b>|<i>/);
  });
});

describe('html report provenance', () => {
  it('shows the seed, the git SHA and the result class', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    const html = await readFile(await writeHtmlReport(dir, { ...report, result: 'blocked', phase: 'up', seed: 7, mode: 'sdk', durationMs: 12, git: { sha: 'abcdef1234567890', branch: 'b', dirty: true } }), 'utf8');
    assert.match(html, /BLOCKED/);
    assert.match(html, /result blocked in up/);
    assert.match(html, /seed 7/);
    assert.match(html, /git abcdef123456 \(dirty\)/);
  });

  it('renders a blocked report that has no checks, and an old report without provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    assert.match(await readFile(await writeHtmlReport(dir, { scenario: 's', result: 'blocked', error: 'no RPC' }), 'utf8'), /no RPC/);
    assert.match(await readFile(await writeHtmlReport(dir, report), 'utf8'), /FAILED/);
  });
});

describe('html report budgets', () => {
  const budgets = { p95Ms: { value: 900, max: 500, unit: 'ms', ok: false, enforced: false } };

  it('shows an unenforced budget in grey, and says it is not enforced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    const html = await readFile(await writeHtmlReport(dir, { ...report, metrics: { budgets } }), 'utf8');
    assert.match(html, /<tr class="muted"><td>over<\/td><td>p95Ms<\/td><td><code>900 \/ 500 ms<\/code>/);
    assert.match(html, /Recorded, not enforced/);
    assert.equal(/<tr class="bad"><td>over/.test(html), false);
  });

  it('shows an enforced budget in red or green, and a declared key nothing measured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    const enforced = { p95Ms: { ...budgets.p95Ms, enforced: true }, closeAllMs: { value: 1, max: 5, unit: 'ms', ok: true, enforced: true }, typoMs: { value: null, max: 5, unit: 'ms', ok: false, enforced: true } };
    const html = await readFile(await writeHtmlReport(dir, { ...report, budgets: true, metrics: { budgets: enforced } }), 'utf8');
    assert.match(html, /<tr class="bad"><td>over<\/td><td>p95Ms/);
    assert.match(html, /<tr class="ok"><td>within<\/td><td>closeAllMs/);
    assert.match(html, /not measured \/ 5 ms/);
    assert.equal(html.includes('Recorded, not enforced'), false);
  });

  it('leaves the section out when a scenario has no budgets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-report-'));
    assert.equal((await readFile(await writeHtmlReport(dir, { ...report, metrics: {} }), 'utf8')).includes('<h2>Budgets</h2>'), false);
  });
});

describe('drift against the previous run', () => {
  it('compares each top-level numeric metric in both runs', () => {
    const drift = computeDrift(
      { p95Ms: 1200, closeAllMs: 1000, gone: 1, text: 'a', load: [{ p95Ms: 1 }], budgets: { p95Ms: {} }, nullMs: null },
      { p95Ms: 2400, closeAllMs: 1000, added: 2, text: 'b', load: [{ p95Ms: 9 }], budgets: { p95Ms: {} }, nullMs: 4 },
    );
    assert.deepEqual(drift, {
      p95Ms: { previous: 1200, current: 2400, ratio: 2 },
      closeAllMs: { previous: 1000, current: 1000, ratio: 1 },
    });
    assert.deepEqual(computeDrift(undefined, { p95Ms: 1 }), {});
  });

  it('has no multiple for growth from zero, and 0 to 0 is unchanged', () => {
    assert.deepEqual(computeDrift({ a: 0, b: 0 }, { a: 5, b: 0 }), { a: { previous: 0, current: 5, ratio: null }, b: { previous: 0, current: 0, ratio: 1 } });
  });

  it('prints only what moved past x1.5 or under x0.67', () => {
    const lines = driftLines(computeDrift(
      { up: 1200, down: 1000, atHigh: 100, atLow: 100, near: 100, fromZero: 0 },
      { up: 2400, down: 500, atHigh: 150, atLow: 67, near: 149, fromZero: 9 },
    ));
    assert.deepEqual(lines, ['DRIFT up 1200 -> 2400 (x2.0)', 'DRIFT down 1000 -> 500 (x0.5)']);
    assert.deepEqual(driftLines(undefined), []);
  });

  it('finds the latest earlier passed report of the same scenario, mode and chain', async () => {
    const reports = await mkdtemp(join(tmpdir(), 'tb-drift-'));
    const save = async (name, body) => {
      await mkdir(join(reports, name));
      await writeFile(join(reports, name, 'report.json'), typeof body === 'string' ? body : JSON.stringify(body));
    };
    const run = { scenario: 'stress-smoke', mode: 'cli', target: 'local', result: 'passed' };
    await save('2026-01-01T00-00-00-000Z-stress-smoke', { ...run, metrics: { p95Ms: 1 } });
    await save('2026-01-02T00-00-00-000Z-stress-smoke', { ...run, metrics: { p95Ms: 2 } });
    await save('2026-01-03T00-00-00-000Z-stress-smoke', { ...run, mode: 'sdk', metrics: { p95Ms: 3 } });
    await save('2026-01-04T00-00-00-000Z-stress-smoke', { ...run, target: 'fork', metrics: { p95Ms: 4 } });
    await save('2026-01-05T00-00-00-000Z-stress-smoke', { ...run, result: 'blocked' });
    await save('2026-01-05T12-00-00-000Z-stress-smoke', { ...run, result: 'failed', metrics: { p95Ms: 5 } });
    await save('2026-01-06T00-00-00-000Z-stress-smoke', 'not json');
    await save('2026-01-07T00-00-00-000Z-x-stress-smoke', { ...run, scenario: 'x-stress-smoke', metrics: { p95Ms: 7 } });
    await save('2026-01-08T00-00-00-000Z-stress-smoke', { ...run, metrics: { p95Ms: 8 } });
    await save('2026-01-09T00-00-00-000Z-stress-smoke', { ...run, metrics: { p95Ms: 9 } });
    const found = await previousReport(reports, '2026-01-08T00-00-00-000Z-stress-smoke', run);
    assert.deepEqual([found.dir, found.report.metrics.p95Ms], ['2026-01-02T00-00-00-000Z-stress-smoke', 2]);
    assert.equal(await previousReport(reports, '2026-01-01T00-00-00-000Z-stress-smoke', run), null);
    assert.equal(await previousReport(join(reports, 'missing'), 'x', run), null);
  });
});

describe('run outcome', () => {
  it('maps each result class to its exit code', () => {
    assert.deepEqual(RESULT_EXIT_CODES, { passed: 0, failed: 1, blocked: 2, timeout: 3, error: 4 });
  });

  it('classifies assertions as failed, a timeout as timeout, anything else as error', () => {
    let assertion;
    try { assert.equal(1, 2); } catch (error) { assertion = error; }
    assert.equal(classifyScenarioError(assertion), 'failed');
    assert.equal(classifyScenarioError(new RunTimeoutError(5)), 'timeout');
    assert.equal(classifyScenarioError(new Error('Control POST /buyer/stop failed with 500')), 'error');
    assert.equal(classifyScenarioError(new TypeError('x is not a function')), 'error');
  });

  it('times a scenario out, and leaves a finished one alone', async () => {
    await assert.rejects(runWithTimeout(() => new Promise(() => {}), 0.01), RunTimeoutError);
    assert.equal(await runWithTimeout(async () => 'done', 60), 'done');
    await assert.rejects(runWithTimeout(async () => { throw new Error('own failure'); }, 60), /own failure/);
    // A scenario failing after its timeout was reported must not surface as an unhandled rejection.
    await assert.rejects(runWithTimeout(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30)), 0.01), RunTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('turns a teardown failure into error only when the scenario passed', () => {
    const passed = { result: 'passed' };
    recordTeardownFailure(passed, new Error('down failed'));
    assert.deepEqual(passed, { result: 'error', phase: 'teardown', error: 'down failed' });
    const failed = { result: 'failed', phase: 'scenario', error: 'check' };
    recordTeardownFailure(failed, new Error('down failed'));
    assert.deepEqual(failed, { result: 'failed', phase: 'scenario', error: 'check', teardownError: 'down failed' });
  });

  it('prints a rerun command that repeats what changes the run', () => {
    assert.equal(rerunCommand({ scenario: 'stress-faults', target: 'local', seed: 7 }), 'pnpm testbench run stress-faults --chain local --seed 7');
    assert.equal(rerunCommand({ scenario: 'chat-basic', target: 'local', seed: 0, strict: true, slot: 'b' }), 'pnpm testbench run chat-basic --chain local --seed 0 --strict --slot b');
    assert.equal(rerunCommand({ scenario: 'chat-basic', target: 'fork', seed: 1, slot: 'default', live: true }), 'pnpm testbench run chat-basic --chain fork --seed 1 --live');
    assert.equal(rerunCommand({ scenario: 'mainnet-smoke', target: 'mainnet', seed: 1 }), 'pnpm testbench run mainnet-smoke --chain mainnet --seed 1 --real-funds');
    assert.equal(rerunCommand({ scenario: 'nope', target: null, seed: null }), 'pnpm testbench run nope');
    assert.equal(rerunCommand({ scenario: 'stress-c64', target: 'local', mode: 'sdk', seed: 7 }), 'pnpm testbench run stress-c64 --chain local --mode sdk --seed 7');
    assert.equal(rerunCommand({ scenario: 'mainnet-smoke', target: 'mainnet', mode: 'sdk', seed: 1 }), 'pnpm testbench run mainnet-smoke --chain mainnet --seed 1 --real-funds');
    assert.equal(rerunCommand({ scenario: 'stress-smoke', target: 'local', seed: 1, strict: true, budgets: true }), 'pnpm testbench run stress-smoke --chain local --seed 1 --strict --budgets');
  });

  it('reads git provenance, and null fields outside a repository', async () => {
    const info = gitInfo(dirname(fileURLToPath(import.meta.url)));
    assert.match(info.sha, /^[0-9a-f]{40}$/);
    assert.equal(typeof info.branch, 'string');
    assert.equal(typeof info.dirty, 'boolean');
    assert.deepEqual(gitInfo(await mkdtemp(join(tmpdir(), 'tb-nogit-'))), { sha: null, branch: null, dirty: null });
  });

  it('collects the mock ledgers for metrics.json, skipping sellers without a mock', async () => {
    const ledger = { byTag: { a: { prompt: 1, completion: 2, cost: '3', status: 'ok' } }, counts: { ok: 1 }, deliveredCost: '3', startedCost: '3', maxActive: 4, active: 0, ok: true };
    const metrics = await deliveryMetrics([{ id: 'one', mockUrl: 'http://127.0.0.1:1' }, { id: 'live', mockUrl: null }], { deliveries: async () => ledger });
    assert.deepEqual(metrics, { one: { deliveredCost: '3', startedCost: '3', counts: { ok: 1 }, byTag: ledger.byTag } });
  });
});

describe('blocked runs', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

  async function blockedRun(...args) {
    const home = await mkdtemp(join(tmpdir(), 'tb-blocked-'));
    const run = spawnSync(process.execPath, [cli, 'run', ...args], { encoding: 'utf8', env: { ...process.env, ANTSEED_TESTBENCH_HOME: home } });
    const [testbench] = await readdir(home);
    const [reportName] = await readdir(join(home, testbench, 'reports'));
    return { run, report: JSON.parse(await readFile(join(home, testbench, 'reports', reportName, 'report.json'), 'utf8')) };
  }

  it('exits 2 with a report when the scenario refuses the target, before any chain starts', async () => {
    const { run, report } = await blockedRun('mainnet-smoke', '--chain', 'local', '--seed', '7');
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.match(run.stdout, /rerun: pnpm testbench run mainnet-smoke --chain local --seed 7/);
    assert.equal(report.result, 'blocked');
    assert.equal(report.phase, 'up');
    assert.match(report.error, /does not support target local/);
    assert.equal(report.seed, 7);
    assert.equal(report.mode, 'sdk');
    assert.match(report.git.sha, /^[0-9a-f]{40}$/);
    assert.equal(report.node, process.version);
    assert.equal(typeof report.durationMs, 'number');
  });

  it('exits 2 with a report for a scenario that does not exist', async () => {
    const { run, report } = await blockedRun('no-such-scenario', '--chain', 'local');
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.equal(report.result, 'blocked');
    assert.match(report.error, /No scenario no-such-scenario/);
  });
});

describe('report server', () => {
  it('stays inside the reports dir and serves files with ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-serve-'));
    await mkdir(join(dir, 'run1'));
    await writeFile(join(dir, 'run1', 'index.html'), '<h1>hi</h1>');
    await writeFile(join(dir, 'run1', 'secret.key'), 'nope');
    assert.equal(reportFilePath(dir, '/../etc/passwd'), null);
    assert.equal(reportFilePath(dir, '/%2e%2e/x'), null);
    const server = await serveReports({ dir });
    try {
      assert.equal(server.host, '127.0.0.1');
      assert.match(await (await fetch(server.url)).text(), /run1/);
      assert.equal(await (await fetch(`${server.url}run1/index.html`)).text(), '<h1>hi</h1>');
      assert.equal((await fetch(`${server.url}run1/secret.key`)).status, 403);
      const partial = await fetch(`${server.url}run1/index.html`, { headers: { range: 'bytes=0-3' } });
      assert.equal(partial.status, 206);
      assert.equal(await partial.text(), '<h1>');
    } finally {
      await server.stop();
    }
  });
});
