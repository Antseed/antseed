import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertLocalUrl, isLoopbackHost } from './env.mjs';
import { isInside } from './paths.mjs';

export const MANIFEST_VERSION = 1;

export async function saveJson(path, value, mode = 0o600) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`, { mode });
  await rename(tmp, path);
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

/** Validates a manifest before anything (desktop attach, down, status) trusts it. */
export function validateManifest(manifest, { dir } = {}) {
  if (!manifest || manifest.version !== MANIFEST_VERSION) throw new Error('Unsupported or missing sandbox manifest');
  if (!/^wt-[a-z0-9-]+$/.test(manifest.name)) throw new Error('Invalid sandbox name in manifest');
  if (manifest.chainId !== 8453) throw new Error('Manifest chainId must be 8453 (Base fork)');
  assertLocalUrl(manifest.rpcUrl, 'rpcUrl');
  assertLocalUrl(manifest.proxyUrl, 'proxyUrl');
  if (manifest.controlUrl) assertLocalUrl(manifest.controlUrl, 'controlUrl');
  assertProcess(manifest.supervisor, 'supervisor');
  if (manifest.anvil) assertProcess(manifest.anvil, 'anvil');
  if (!Array.isArray(manifest.sellers) || manifest.sellers.length === 0) throw new Error('Manifest must list sellers');
  for (const seller of [...manifest.sellers, ...(manifest.routers ?? [])]) {
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
