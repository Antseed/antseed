import path from 'node:path';
import { CONTRACTS_ROOT } from './paths.mjs';
import { fileExists } from './fsx.mjs';

/** Loads packages/contracts/.env without overriding values already in the environment. */
export async function loadDotEnv() {
  const file = path.join(CONTRACTS_ROOT, '.env');
  if (await fileExists(file)) process.loadEnvFile(file);
}

export function requireEnvironment(names, env = process.env) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

export function rpcEnvName(network) {
  return `${network.replaceAll('-', '_').toUpperCase()}_RPC_URL`;
}
