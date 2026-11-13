// One-shot `antseed` CLI commands from a scenario (tb.cli, tb.sellerCli): the built CLI of that side's tree on a testbench
// node's data dir and config, in the testbench's isolated environment. Long-running nodes are lib/cli-node.mjs's.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliEntry, cliNodeEnv } from './cli-node.mjs';
import { armedSpec, failpointCrashOfExit, failpointJournalPath, normalizeFailpointSpec, parseJournal } from './failpoints.mjs';

const CLOCK_PRELOAD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'clock-preload.mjs')).href;

/** How much of each stream a `cli` event keeps; the full streams go back to the caller. */
export const CLI_EVENT_STREAM_LIMIT = 2000;
export const CLI_DEFAULT_TIMEOUT_MS = 60_000;

/** stdout as JSON when the whole (trimmed) stream parses, else null. */
export function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Environment of a one-shot CLI command: the isolated testbench environment of cli-node.mjs (private HOME, official
 * bootstrap list emptied by the preload, no update check) without the node debug logs, which would mix into stdout
 * and break --json output. `extra` wins; pass ANTSEED_DEBUG: '1' to get them back. `failpointsFile` also preloads the
 * fail point handler with that spec file, as for a node (cliNodeEnv).
 */
export function cliCommandEnv(env, home, extra = {}, { clockOffsetMs = 0, tree, failpointsFile } = {}) {
  const result = cliNodeEnv(env, home, {}, tree, { failpointsFile });
  delete result.ANTSEED_DEBUG;
  if (clockOffsetMs) {
    result.NODE_OPTIONS = `${result.NODE_OPTIONS} --import ${CLOCK_PRELOAD}`;
    result.ANTSEED_TESTBENCH_CLOCK_OFFSET_MS = String(Math.round(clockOffsetMs));
  }
  return { ...result, ...extra };
}

/**
 * Runs `node <entry> --data-dir <dataDir> --config <configPath> ...args` and collects it. Never throws for a failing
 * command: { code (null when killed), signal, pid, stdout, stderr, json, durationMs, timedOut }. `input` is written to stdin
 * (closed right after); without it stdin is empty. Killed with SIGKILL after `timeoutMs`.
 */
export function runCli({ entry, dataDir, configPath, args = [], env, timeoutMs = CLI_DEFAULT_TIMEOUT_MS, input, nodePath = process.execPath }) {
  const argv = [entry, ...(dataDir ? ['--data-dir', dataDir] : []), ...(configPath ? ['--config', configPath] : []), ...args.map(String)];
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(nodePath, argv, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // a command that exits without reading stdin closes the pipe
      child.stdin.end(input);
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (spawnError) stderr += `${stderr ? '\n' : ''}[testbench] ${spawnError.message}`;
      resolveRun({ code, signal, pid: child.pid, stdout, stderr, json: parseCliJson(stdout), durationMs: Date.now() - started, timedOut });
    });
  });
}

/**
 * What the fail point journal of a one-shot command says about how it ended: `{ specId, journal, crash }`. `crash` is
 * the journal's crash trigger when a fail point killed the command (it died of SIGKILL, was not the timeout's kill,
 * and its own process journaled the trigger), else null: any other death or exit code is the command's own failure.
 */
export function cliFailpointOutcome(journal, result, specId) {
  const crash = result.timedOut ? null : failpointCrashOfExit(journal, { pid: result.pid, signal: result.signal });
  return { specId, journal, crash: crash && crash.spec === specId ? crash : null };
}

/** What a `cli` event records about a run: its first CLI_EVENT_STREAM_LIMIT characters of each stream and their sizes. */
export function cliEventData(who, args, result) {
  const head = (text) => String(text ?? '').slice(0, CLI_EVENT_STREAM_LIMIT);
  return {
    who, args: args.map(String), code: result.code, signal: result.signal ?? null, durationMs: result.durationMs, timedOut: result.timedOut,
    stdout: head(result.stdout), stderr: head(result.stderr), stdoutLength: result.stdout.length, stderrLength: result.stderr.length,
    json: result.json !== null,
  };
}

/**
 * tb.cli and tb.sellerCli for a testbench manifest. `event(type, data)` records each call; `baseEnv` is the
 * environment the isolated one is derived from (the scenario runner's). `chainNow()` returns the chain's time in unix
 * seconds, for `clock: 'chain'`.
 */
export function createCliRunner({ repo, manifest, event = async () => {}, baseEnv = process.env, entry, chainNow, seed = 0 }) {
  let armings = 0;
  /** The spec file of one command, in a folder of its own: a journal per command, and no shared crash state to hold it back. */
  const armCommand = (spec) => {
    const dir = join(manifest.dir, 'failpoints', 'cli');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = `cli-${Date.now()}-${(armings += 1)}`;
    const file = join(dir, `${id}.json`);
    writeFileSync(file, `${JSON.stringify({ ...normalizeFailpointSpec(armedSpec(seed, `cli:${armings}`, spec)), id })}\n`, { mode: 0o600 });
    return { id, file };
  };
  const sellerDir = (id) => {
    if (!manifest.sellers.some((seller) => seller.id === id)) throw new Error(`Unknown seller ${id}`);
    return join(manifest.dir, 'sellers', id);
  };
  const run = async (who, args, { side = 'buyer', dataDir, configPath, home = manifest.home, env = {}, timeoutMs = CLI_DEFAULT_TIMEOUT_MS, input, clock = 'wall', failpoints } = {}) => {
    if (!Array.isArray(args)) throw new Error('cli args must be an array');
    if (!['wall', 'chain'].includes(clock)) throw new Error("cli clock must be 'wall' or 'chain'");
    if (clock === 'chain' && !chainNow) throw new Error("cli clock 'chain' needs the chain's time");
    const clockOffsetMs = clock === 'chain' ? (await chainNow()) * 1000 - Date.now() : 0;
    const tree = manifest.trees?.[side]?.path;
    const armed = failpoints ? armCommand(failpoints) : null;
    const result = await runCli({ entry: entry ?? cliEntry(tree ?? repo), dataDir, configPath, args, env: cliCommandEnv(baseEnv, home, env, { clockOffsetMs, tree, failpointsFile: armed?.file }), timeoutMs, input });
    if (armed) {
      let journal = [];
      try { journal = parseJournal(readFileSync(failpointJournalPath(armed.file), 'utf8')); } catch { /* the command reached no point */ }
      result.failpoint = cliFailpointOutcome(journal, result, armed.id);
    }
    await event('cli', { ...cliEventData(who, args, result), ...(clock === 'chain' ? { clockOffsetMs: Math.round(clockOffsetMs) } : {}), ...(armed ? { failpoints, failpointCrash: result.failpoint.crash } : {}) });
    return result;
  };
  return {
    /** `antseed ...args` on the buyer's data dir and config (or `dataDir`/`configPath`). See runCli for the result. */
    cli: (args, { dataDir = manifest.buyerDir, configPath, ...options } = {}) => run(dataDir === manifest.buyerDir ? 'buyer' : `dir:${dataDir}`, args, { dataDir, configPath: configPath ?? (dataDir === manifest.buyerDir ? manifest.buyerConfig : join(dataDir, 'config.json')), ...options }),
    /** `antseed ...args` on a seller's data dir and its config.json. */
    sellerCli: (id, args, options = {}) => {
      const dataDir = sellerDir(id);
      return run(`seller:${id}`, args, { side: 'seller', home: manifest.sellerHome ?? manifest.home, dataDir, configPath: join(dataDir, 'config.json'), ...options });
    },
  };
}
