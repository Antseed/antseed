// Real `antseed` CLI processes for cli-mode testbenches. Small copies adapted from e2e/stress/harness.mjs (linkPlugins,
// cliInvocation, Proc, writeSellerConfig, writeBuyerConfig): importing the harness would run it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync, lstatSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAddressInUse, isolatedEnv } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** SIGTERM to SIGKILL, as in the stress harness (Proc.stop). */
export const CLI_STOP_GRACE_MS = 20_000;
const CAPTURE_LIMIT = 1024 * 1024;

export function cliEntry(repo) {
  return join(repo, 'apps/cli/dist/cli/index.js');
}

/** Argv of the CLI on a node's data dir, whose config.json the supervisor wrote. */
export function cliArgs(repo, dataDir, command) {
  return [cliEntry(repo), '--data-dir', dataDir, '--config', join(dataDir, 'config.json'), '--verbose', ...command];
}

/**
 * Environment of a CLI node: isolated like every testbench process, with the debug logs the payment oracle reads
 * (`Cost recorded`), and unhandled rejections logged rather than fatal, as under the stress harness: the crash scan
 * finds them in the log.
 */
export function cliNodeEnv(env, home, extra = {}) {
  const preload = pathToFileURL(join(here, 'isolate-preload.mjs')).href;
  return isolatedEnv(env, home, { ANTSEED_DEBUG: '1', ANTSEED_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--unhandled-rejections=warn --import ${preload}`, ...extra });
}

/** Symlinks workspace plugins into <home>/.antseed/plugins, where the CLI's plugin loader looks for them. */
export async function linkPlugins(home, repo, pluginDirs) {
  const dir = join(home, '.antseed', 'plugins', 'node_modules', '@antseed');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const plugin of new Set(pluginDirs)) {
    const target = join(repo, 'plugins', plugin);
    if (!existsSync(target)) throw new Error(`No workspace plugin ${plugin}`);
    const link = join(dir, plugin);
    if (!lstatSync(link, { throwIfNoEntry: false })) await symlink(target, link);
  }
}

/** Starts a CLI process with stdout and stderr appended to `logPath`; keeps its first output for the readiness checks. */
export function spawnCliNode({ who, args, env, logPath }) {
  const log = createWriteStream(logPath, { flags: 'a' });
  log.write(`\n===== [testbench] start ${who} at ${new Date().toISOString()} =====\n`);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let captured = '';
  let capturing = true;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      if (capturing && captured.length < CAPTURE_LIMIT) captured += chunk.toString('utf8');
    });
  }
  child.on('error', (error) => log.write(`[testbench] ${who}: ${error.message}\n`));
  child.on('close', (code, signal) => log.end(`===== [testbench] ${who} exited code=${code} signal=${signal} =====\n`));
  return {
    who,
    child,
    logPath,
    output: () => captured,
    stopCapture() { capturing = false; captured = ''; },
  };
}

/** Polls `ready` until it returns a value. Fails when the process exits first (EADDRINUSE when it lost its port). */
export async function waitForCliReady(node, ready, { timeoutMs = 120_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { exitCode, signalCode } = node.child;
    if (exitCode !== null || signalCode !== null) {
      const error = new Error(`${node.who} exited with ${exitCode ?? signalCode} before it was ready (see ${node.logPath})`);
      if (isAddressInUse(node.output())) error.code = 'EADDRINUSE';
      throw error;
    }
    const value = await ready();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`${node.who} was not ready after ${timeoutMs} ms (see ${node.logPath})`);
}

/** The harness's isolation guard: a node must report exactly the one private bootstrap node. */
export function assertSingleBootstrap(output, who) {
  const count = /Starting as \w+ with (\d+) bootstrap node/.exec(output)?.[1];
  if (count !== '1') throw new Error(`ISOLATION: ${who} started with ${count ?? 'an unknown number of'} bootstrap nodes, expected the private one only`);
}

/**
 * A priced seller that turned payments off at startup serves every request for free, and the buyer never opens a
 * channel (it only pays when asked). On the code this branch runs, one slow RPC probe did that (fixed on main in
 * a962528cb). Such a seller is a broken environment, not a load result, so `up` stops right here.
 */
export function assertSellerPaymentsOn(output, who) {
  if (/Payments disabled/.test(output)) {
    throw new Error(`${who} started with payments disabled (\"Payments disabled\" in its log); a priced seller must never serve for free. Check the seller's RPC link, then rerun`);
  }
}

/** Readiness of `antseed seller start`: the spinner's success line plus this process's daemon state. */
export function sellerReady(output, daemonState, pid) {
  if (!/Seeding active/.test(output)) return null;
  return daemonState?.state === 'seeding' && daemonState.pid === pid ? daemonState : null;
}

/**
 * Readiness of `antseed buyer start`: its own proxy is listening. The CLI reuses a compatible proxy it finds on a taken
 * port, which here could be another testbench's buyer, so that case counts as losing the port.
 */
export function buyerProxyListening(output, port) {
  if (new RegExp(`Proxy port ${port} already in use`).test(output)) throw Object.assign(new Error(`Buyer proxy port ${port} was taken`), { code: 'EADDRINUSE' });
  return new RegExp(`Proxy listening on http://localhost:${port}\\b`).test(output);
}

/** Asks a child to stop and waits; after `graceMs` it is SIGKILLed and `onForced` gets how long it was given. */
export async function stopWithGrace(child, { requestStop = () => child.kill('SIGTERM'), graceMs = CLI_STOP_GRACE_MS, onForced }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const started = Date.now();
  requestStop();
  const timer = setTimeout(() => {
    onForced?.(Date.now() - started);
    child.kill('SIGKILL');
  }, graceMs);
  try { await exited; } finally { clearTimeout(timer); }
}

/**
 * What the supervisor needs from a CLI buyer, over its proxy's HTTP API, with the names and results of AntseedNode so
 * both modes share one code path. Async where the node's method is sync: callers await both.
 */
export function cliBuyerClient(proxyUrl, { fetchImpl = fetch } = {}) {
  const call = async (path, init = {}, timeoutMs = 30_000) => {
    const response = await fetchImpl(`${proxyUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `${path} answered ${response.status}`);
    return body;
  };
  return {
    getActiveBuyerChannels: async () => (await call('/_antseed/channels')).channels ?? [],
    /** Discovery can fail while the network settles; the supervisor polls, so that reads as no peers yet. */
    async discoverPeers() {
      try {
        await call('/_antseed/peers/refresh', { method: 'POST' }, 60_000);
        return (await call('/_antseed/peers')).peers ?? [];
      } catch {
        return [];
      }
    },
    /** The route has no timeout option: the node's default applies, within the 120 s this waits. */
    async requestChannelClose(peerId) {
      const { result } = await call('/_antseed/channels/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peerId }) }, 120_000);
      return result;
    },
  };
}
