import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';

const STRIPPED = /^(ANTSEED_|OPENAI_|ANTHROPIC_|VENICE_|FLOW_|FORK_|TESTBENCH_KEY_|BASE_MAINNET_RPC_URL$|LOCAL_LLM_|TYPESAFE_)/;
export const FORBIDDEN_PORTS = new Set([6881, 6882, 8377, 3117]);

/** The account's real home from the password database, independent of $HOME (which testbench processes override). */
function realHome() {
  try { return resolve(userInfo().homedir); } catch { return null; }
}

/** Refuses the user's real home and anything inside their real ~/.antseed as a testbench HOME. */
export function assertTestbenchHome(home, actualHome = realHome()) {
  if (!home) throw new Error('A testbench process needs an explicit testbench HOME');
  if (!actualHome) return home;
  const target = resolve(home);
  const fromAntseed = relative(join(actualHome, '.antseed'), target);
  if (target === actualHome || (!fromAntseed.startsWith('..') && !isAbsolute(fromAntseed))) {
    throw new Error(`Refusing to run a testbench process with HOME=${target}: it must never be your real home or ~/.antseed`);
  }
  return home;
}

/** Environment for testbench processes: inherited env minus AntSeed/provider secrets, with a private HOME. */
export function isolatedEnv(env, home, extra = {}) {
  assertTestbenchHome(home);
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !STRIPPED.test(key)));
  return { ...clean, HOME: home, ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1', ...extra };
}

/**
 * The supervisor's environments, from its inherited `env`: `base` for every child (cleaned, without the live provider
 * keys, with --verbose's ANTSEED_DEBUG), `own` for the supervisor itself (plus the buyer's switches in sdk mode, whose
 * buyer runs inside it) and `sdkSeller(sellerEnv)` for a forked SDK seller. Buyer switches never reach a seller.
 */
export function supervisorEnvs(env, home, { verbose = false, buyerEnv = {}, liveKeys = [], cliMode = false } = {}) {
  const debug = verbose ? { ANTSEED_DEBUG: '1' } : {};
  const base = isolatedEnv(env, home, debug);
  for (const key of liveKeys) delete base[key];
  return {
    base,
    own: cliMode ? base : { ...base, ...buyerEnv },
    // isolatedEnv strips inherited ANTSEED_* switches, so --verbose goes on again over the seller's own env.
    sdkSeller: (sellerEnv = {}) => isolatedEnv(base, home, { ...sellerEnv, ...debug }),
  };
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1';
}

export function assertLocalUrl(url, label = 'URL') {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || !isLoopbackHost(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error(`${label} must be an owned http://127.0.0.1:<port> endpoint (got ${url})`);
  }
  return endpoint;
}

/**
 * Network options every testbench node must use. Fails fast on anything that could
 * collide with a developer's real node (default ports, public bootstrap, all-interface binds).
 */
export function assertNetworkOptions(options) {
  for (const key of ['dhtPort', 'signalingPort']) {
    if (options.role === 'buyer' && key === 'signalingPort') continue;
    const value = options[key];
    if (value === undefined || value === null) throw new Error(`${key} must be set explicitly (use 0)`);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${key} must be a port number`);
    if (value !== 0 && (value < 1024 || FORBIDDEN_PORTS.has(value))) throw new Error(`${key}=${value} collides with a default AntSeed port`);
  }
  if (options.bindHost !== '127.0.0.1') throw new Error('bindHost must be 127.0.0.1');
  if (options.noOfficialBootstrap !== true) throw new Error('noOfficialBootstrap must be true');
  if (options.natTraversal !== false) throw new Error('natTraversal must be false');
  if (options.allowPrivateIPs !== true) throw new Error('allowPrivateIPs must be true');
  if (!Array.isArray(options.bootstrapNodes) || options.bootstrapNodes.length === 0) throw new Error('A private bootstrap node is required');
  for (const node of options.bootstrapNodes) {
    if (!isLoopbackHost(node.host) || !Number.isInteger(node.port) || node.port <= 0 || FORBIDDEN_PORTS.has(node.port)) {
      throw new Error(`Bootstrap node ${node.host}:${node.port} is not a private loopback node`);
    }
  }
  return options;
}

export async function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** For listeners that need a known port up front: pick a free one and retry if another process wins the race. */
export async function listenWithRetry(start, { attempts = 5, pickPort = freePort } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await pickPort();
    if (FORBIDDEN_PORTS.has(port)) continue;
    try {
      return { port, value: await start(port) };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && !/EADDRINUSE/.test(String(error?.message))) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('No free port found');
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Parses KEY=VALUE lines (optional `export`, quotes and comments); never evaluates shell syntax. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = ENV_LINE.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

/**
 * Resolves the named keys from the shell first, then the env file. Returns only those keys
 * plus which source each came from; values are never logged.
 */
export function resolveLiveKeys(names, { env = process.env, fileValues = {} } = {}) {
  const values = {};
  const sources = {};
  const missing = [];
  for (const name of names) {
    if (env[name]?.trim()) { values[name] = env[name]; sources[name] = 'shell'; }
    else if (fileValues[name]?.trim()) { values[name] = fileValues[name]; sources[name] = 'env file'; }
    else missing.push(name);
  }
  return { values, sources, missing };
}

/** Toolchain locations that would otherwise move with HOME (Volta, Corepack), so pnpm and node keep working. */
export function toolchainEnv(env = process.env) {
  const home = env.HOME?.trim();
  const out = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  const volta = env.VOLTA_HOME || (home ? join(home, '.volta') : '');
  const cache = env.XDG_CACHE_HOME || (home ? join(home, '.cache') : '');
  const corepack = env.COREPACK_HOME || (cache ? join(cache, 'node', 'corepack') : '');
  if (volta) out.VOLTA_HOME = volta;
  if (corepack) out.COREPACK_HOME = corepack;
  return out;
}

/** A private key as 64 lowercase hex characters; accepts an optional 0x prefix. */
export function normalizeIdentityHex(raw, name) {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 64 hex characters (optionally 0x-prefixed)`);
  return hex.toLowerCase();
}

/** Optional buyer wallet for local and fork testbenches: a test key you choose instead of the generated one. */
export const BUYER_KEY_ENV = 'ANTSEED_TESTBENCH_BUYER_IDENTITY_HEX';

/** The buyer key from the shell, then the env file; null when unset (the testbench then keeps its own key). Never logged. */
export function resolveBuyerKey({ env = process.env, fileValues = {}, envFile = '.env.local' } = {}) {
  const fromShell = env[BUYER_KEY_ENV]?.trim();
  const raw = fromShell || fileValues[BUYER_KEY_ENV]?.trim();
  if (!raw) return null;
  return { hex: normalizeIdentityHex(raw, BUYER_KEY_ENV), source: fromShell ? 'shell' : envFile };
}

/** Installs the chosen key as the testbench buyer's identity.key (owner-only), replacing the previous testbench key. */
export async function writeBuyerKey(buyerDir, hex) {
  await mkdir(buyerDir, { recursive: true, mode: 0o700 });
  const file = join(buyerDir, 'identity.key');
  await writeFile(file, `${hex}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export const FORK_RPC_ENV = 'BASE_MAINNET_RPC_URL';

/** Line-by-line transform that replaces every occurrence of `secret` (e.g. the fork RPC URL) before it reaches a log. */
export function redactingStream(secret, replacement = '<BASE_MAINNET_RPC_URL>') {
  let pending = '';
  const scrub = (text) => (secret ? text.split(secret).join(replacement) : text);
  return new Transform({
    transform(chunk, _encoding, callback) {
      const lines = (pending + chunk.toString('utf8')).split('\n');
      pending = lines.pop();
      callback(null, lines.length ? `${lines.map(scrub).join('\n')}\n` : '');
    },
    flush(callback) { callback(null, scrub(pending)); },
  });
}

/**
 * The Base RPC Anvil forks from. Required: the shell wins, then the worktree's gitignored
 * `.env.local`. Public gateways rate-limit fork reads, so there is no default. Never logs the URL.
 */
export function resolveForkUrl({ env = process.env, fileValues = {}, envFile = '.env.local' } = {}) {
  const fromShell = env[FORK_RPC_ENV]?.trim();
  const value = fromShell || fileValues[FORK_RPC_ENV]?.trim();
  if (!value) throw new Error(`${FORK_RPC_ENV} is required (a dedicated Base mainnet RPC with an API key); put it in ${envFile} or export it`);
  if (!/^https?:\/\//.test(value)) throw new Error(`${FORK_RPC_ENV} must be HTTP(S)`);
  return { url: value, source: fromShell ? 'shell' : envFile };
}

/** True when a process's output says its port was taken, so a retry on another port can help. */
export function isAddressInUse(output) {
  return /address already in use|EADDRINUSE|os error 98|os error 48/i.test(output);
}

/** Why Anvil exited early, without echoing its output (which can contain the fork URL). */
export function anvilExitMessage(code, output, { fork, logPath }) {
  if (isAddressInUse(output)) return `Anvil exited with ${code}: port already in use`;
  const hint = fork ? ' Check BASE_MAINNET_RPC_URL (a reachable Base mainnet RPC with an API key).' : '';
  return `Anvil exited with ${code} before its RPC came up; see ${logPath}.${hint}`;
}
