// One-shot `antseed` CLI commands from a scenario (tb.cli, tb.sellerCli): this worktree's built CLI on a testbench
// node's data dir and config, in the testbench's isolated environment. Long-running nodes are lib/cli-node.mjs's.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliEntry, cliNodeEnv } from './cli-node.mjs';

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
 * and break --json output. `extra` wins; pass ANTSEED_DEBUG: '1' to get them back.
 */
export function cliCommandEnv(env, home, extra = {}, { clockOffsetMs = 0 } = {}) {
  const result = cliNodeEnv(env, home);
  delete result.ANTSEED_DEBUG;
  if (clockOffsetMs) {
    result.NODE_OPTIONS = `${result.NODE_OPTIONS} --import ${CLOCK_PRELOAD}`;
    result.ANTSEED_TESTBENCH_CLOCK_OFFSET_MS = String(Math.round(clockOffsetMs));
  }
  return { ...result, ...extra };
}

/**
 * Runs `node <entry> --data-dir <dataDir> --config <configPath> ...args` and collects it. Never throws for a failing
 * command: { code (null when killed), signal, stdout, stderr, json, durationMs, timedOut }. `input` is written to stdin
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
      resolveRun({ code, signal, stdout, stderr, json: parseCliJson(stdout), durationMs: Date.now() - started, timedOut });
    });
  });
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
export function createCliRunner({ repo, manifest, event = async () => {}, baseEnv = process.env, entry = cliEntry(repo), chainNow }) {
  const sellerDir = (id) => {
    if (!manifest.sellers.some((seller) => seller.id === id)) throw new Error(`Unknown seller ${id}`);
    return join(manifest.dir, 'sellers', id);
  };
  const run = async (who, args, { dataDir, configPath, home = manifest.home, env = {}, timeoutMs = CLI_DEFAULT_TIMEOUT_MS, input, clock = 'wall' } = {}) => {
    if (!Array.isArray(args)) throw new Error('cli args must be an array');
    if (!['wall', 'chain'].includes(clock)) throw new Error("cli clock must be 'wall' or 'chain'");
    if (clock === 'chain' && !chainNow) throw new Error("cli clock 'chain' needs the chain's time");
    const clockOffsetMs = clock === 'chain' ? (await chainNow()) * 1000 - Date.now() : 0;
    const result = await runCli({ entry, dataDir, configPath, args, env: cliCommandEnv(baseEnv, home, env, { clockOffsetMs }), timeoutMs, input });
    await event('cli', { ...cliEventData(who, args, result), ...(clock === 'chain' ? { clockOffsetMs: Math.round(clockOffsetMs) } : {}) });
    return result;
  };
  return {
    /** `antseed ...args` on the buyer's data dir and config (or `dataDir`/`configPath`). See runCli for the result. */
    cli: (args, { dataDir = manifest.buyerDir, configPath, ...options } = {}) => run(dataDir === manifest.buyerDir ? 'buyer' : `dir:${dataDir}`, args, { dataDir, configPath: configPath ?? (dataDir === manifest.buyerDir ? manifest.buyerConfig : join(dataDir, 'config.json')), ...options }),
    /** `antseed ...args` on a seller's data dir and its config.json. */
    sellerCli: (id, args, options = {}) => {
      const dataDir = sellerDir(id);
      return run(`seller:${id}`, args, { dataDir, configPath: join(dataDir, 'config.json'), ...options });
    },
  };
}
