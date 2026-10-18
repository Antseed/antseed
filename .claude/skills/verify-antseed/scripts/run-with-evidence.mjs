#!/usr/bin/env node
// Runs `node e2e/sandbox/cli.mjs run <args>` (what `pnpm sandbox run` runs) on a fresh sandbox and files the
// evidence into the run's report directory, which `pnpm sandbox down` keeps:
//   run-output.log  the full console transcript
//   checks.log      only the PASS/FAIL/KNOWN lines, the error and the report path (paste into PR bodies)
//   logs/*.log      the supervisor, seller, Anvil and forge log lines written during this run
// A run that ends before the scenario starts has no report directory; its transcript goes to
// <sandbox>/logs/evidence-<timestamp>-<scenario>.log instead.
// Usage: .claude/skills/verify-antseed/scripts/run-with-evidence.mjs <scenario> [--chain local] [--keep] [--strict] [--slot NAME] ...
// Refuses when this worktree's sandbox (or slot) is running or starting, so any sandbox up after a
// Ctrl+C or SIGTERM is the one this run started: the helper then stops it with `cli.mjs down`.
// Exits with the run's exit code.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('-')) {
  console.error('usage: run-with-evidence.mjs <scenario> [pnpm sandbox run flags]');
  process.exit(2);
}
const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const cli = join(repo, 'e2e/sandbox/cli.mjs');
const { sandboxName, sandboxPaths, sandboxRoot, worktreeRoot } = await import(join(repo, 'e2e/sandbox/lib/paths.mjs'));
const slotIndex = args.indexOf('--slot');
const slotArgs = slotIndex >= 0 ? ['--slot', args[slotIndex + 1]] : [];
const paths = sandboxPaths(sandboxRoot(), sandboxName(worktreeRoot(repo), slotIndex >= 0 ? args[slotIndex + 1] : undefined));

const status = spawnSync(process.execPath, [cli, 'status', '--json', ...slotArgs], { cwd: repo, encoding: 'utf8' });
const before = (() => { try { return JSON.parse(status.stdout); } catch { return null; } })();
if (!before || before.running || before.lock === 'held') {
  console.error(`[evidence] this sandbox is ${before ? 'already running or starting' : 'in an unknown state'}; evidence runs start fresh. Run pnpm sandbox down first.`);
  process.exit(2);
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);
const logFiles = () => (existsSync(paths.logs) ? readdirSync(paths.logs).filter((name) => /^(supervisor|anvil|forge|seller-.+)\.log$/.test(name)) : []);
const offsets = new Map(logFiles().map((name) => [name, sizeOf(join(paths.logs, name))]));

const scenario = args[0];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const chunks = [];
const child = spawn(process.execPath, [cli, 'run', ...args], { cwd: repo, stdio: ['inherit', 'pipe', 'pipe'] });
for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', (chunk) => { chunks.push(chunk); sink.write(chunk); });
}
let interrupted = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interrupted ??= signal; child.kill(signal); });
const code = await new Promise((resolve) => child.on('close', (exitCode) => resolve(exitCode ?? 1)));
const transcript = Buffer.concat(chunks).toString('utf8');

// The killed CLI never reaches its own teardown, and the supervisor runs detached, so stop it here.
if (interrupted) {
  console.error(`[evidence] ${interrupted}: stopping the sandbox this run started`);
  const stop = spawnSync(process.execPath, [cli, 'down', ...slotArgs], { cwd: repo, stdio: 'inherit' });
  if (stop.status !== 0) console.error('[evidence] teardown failed: run pnpm sandbox down (add --force only with the user\'s approval)');
}

// The report directory the CLI printed, else the one it created for this run before it was killed.
const printed = transcript.match(/\[sandbox\] (?:PASSED|FAILED): (.+)\/report\.json/)?.[1];
const created = existsSync(paths.reports)
  ? readdirSync(paths.reports).filter((name) => name.endsWith(`-${scenario}`) && name.slice(0, stamp.length) >= stamp).sort().at(-1)
  : undefined;
const reportDir = printed ?? (created && join(paths.reports, created));
if (!reportDir) {
  mkdirSync(paths.logs, { recursive: true });
  const file = join(paths.logs, `evidence-${stamp}-${scenario}.log`);
  writeFileSync(file, transcript);
  console.error(`[evidence] the run ended before the scenario started; transcript in ${file}`);
  process.exit(code);
}
writeFileSync(join(reportDir, 'run-output.log'), transcript);
const checks = transcript.split('\n').filter((line) => /\[sandbox\] (PASS|FAIL|KNOWN|Error:|FAILED:|PASSED:|HTML report:)/.test(line));
writeFileSync(join(reportDir, 'checks.log'), `${checks.join('\n')}\n`);
mkdirSync(join(reportDir, 'logs'), { recursive: true });
for (const name of logFiles()) {
  const source = join(paths.logs, name);
  const start = offsets.get(name) ?? 0;
  const length = sizeOf(source) - start;
  if (length <= 0) continue;
  const buffer = Buffer.alloc(length);
  const fd = openSync(source, 'r');
  readSync(fd, buffer, 0, length, start);
  closeSync(fd);
  writeFileSync(join(reportDir, 'logs', name), buffer);
}
console.log(`[evidence] ${reportDir} (checks.log, run-output.log, logs/)`);
process.exit(code);
