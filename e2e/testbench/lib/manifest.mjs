import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocalUrl, isLoopbackHost } from './env.mjs';
import { isInside } from './paths.mjs';
import { assertMode } from './topology.mjs';

export const MANIFEST_VERSION = 1;
/** Testbench targets and the EVM chain each runs: a Base mainnet fork or a plain local Anvil with source-deployed contracts. */
export const TESTBENCH_CHAIN_IDS = { fork: 8453, local: 31337 };

/** Atomic replace through a temp file unique per call, so two saves in one process never share (or rename) a temp. */
export async function saveJson(path, value, mode = 0o600) {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`, { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertProcess(entry, label) {
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.startedAt !== 'string') {
    throw new Error(`Manifest ${label} must record pid and startedAt`);
  }
}

/** What `list` shows. A held lock means a supervisor is alive: `stopped` must only ever mean its processes are gone. */
export function lifecycleState({ lock, manifest, running }) {
  if (running) return 'running';
  if (lock.state === 'stale') return 'stale';
  if (lock.state === 'held') return manifest?.stoppingAt ? 'stopping' : 'starting';
  return 'stopped';
}

const CLOSE_RESULT_REASONS = {
  'seller-offline': (id) => `seller ${id} was offline at shutdown, so its channel was not closed`,
  'buyer-offline': () => 'the buyer was offline at shutdown, so no channel was closed',
};

/**
 * What a testbench's manifest says went wrong in its last shutdown: the supervisor's failed cleanup steps, and buyer
 * reserve still locked once channels were closed. The reserve is judged only from `finalBalances`, which the
 * supervisor's own shutdown writes right after it closed channels; a stop that never got there (SIGKILL, a dead
 * supervisor) has none, so there is nothing to judge. Each locked reserve names why, from the per-seller close
 * results. Empty when the testbench stopped cleanly (or never ran).
 */
export function shutdownProblems(manifest) {
  const problems = [...(manifest?.shutdownErrors ?? [])];
  const reserved = manifest?.finalBalances?.reservedMicroUsdc;
  if (reserved !== undefined && reserved !== null && BigInt(reserved) !== 0n) {
    const reasons = Object.entries(manifest.closeResults ?? {}).filter(([, result]) => CLOSE_RESULT_REASONS[result]).map(([id, result]) => CLOSE_RESULT_REASONS[result](id));
    const why = reasons.length ? ` (${reasons.join('; ')}; a scenario must restart stopped sellers or close their channels before it ends)` : '';
    problems.push(`buyer reserve still locked after closing channels: ${reserved} micro-USDC${why}`);
  }
  return problems;
}

/** Validates a manifest before anything (desktop attach, down, status) trusts it. */
export function validateManifest(manifest, { dir } = {}) {
  if (!manifest || manifest.version !== MANIFEST_VERSION) throw new Error('Unsupported or missing testbench manifest');
  if (!/^wt-[a-z0-9-]+$/.test(manifest.name)) throw new Error('Invalid testbench name in manifest');
  const target = manifest.target ?? 'fork';
  const expectedChainId = TESTBENCH_CHAIN_IDS[target];
  if (!expectedChainId) throw new Error(`Unknown testbench target ${target}`);
  if (manifest.chainId !== expectedChainId) throw new Error(`Manifest chainId must be ${expectedChainId} for target ${target}`);
  assertLocalUrl(manifest.rpcUrl, 'rpcUrl');
  assertLocalUrl(manifest.proxyUrl, 'proxyUrl');
  if (manifest.controlUrl) assertLocalUrl(manifest.controlUrl, 'controlUrl');
  assertMode(manifest.mode ?? 'sdk', 'Manifest mode');
  assertProcess(manifest.supervisor, 'supervisor');
  if (manifest.anvil) assertProcess(manifest.anvil, 'anvil');
  if (manifest.starter) assertProcess(manifest.starter, 'starter');
  for (const [who, entry] of Object.entries(manifest.nodeProcesses ?? {})) assertProcess(entry, who);
  if (!Array.isArray(manifest.sellers) || manifest.sellers.length === 0) throw new Error('Manifest must list sellers');
  for (const seller of manifest.sellers) {
    if (!/^[0-9a-f]{40}$/.test(seller.peerId)) throw new Error(`Invalid seller peerId ${seller.peerId}`);
    if (seller.process) assertProcess(seller.process, `seller ${seller.id}`);
    for (const port of [seller.dhtPort, seller.signalingPort]) {
      if (port !== undefined && (port === 6881 || port === 6882)) throw new Error('Manifest records a default AntSeed port');
    }
  }
  if (manifest.bootstrap && !isLoopbackHost(manifest.bootstrap.host)) throw new Error('Bootstrap must be loopback');
  const base = dir ?? manifest.dir;
  for (const key of ['home', 'buyerDir', 'buyerConfig']) {
    if (!manifest[key] || !isInside(resolve(manifest[key]), base) || resolve(manifest[key]) === resolve(base)) throw new Error(`Unsafe manifest ${key}`);
  }
  return manifest;
}
