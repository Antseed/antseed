import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { capture } from './exec.mjs';
import { call, sameAddress } from './chain.mjs';
import { requireEnvironment } from './env.mjs';

/**
 * Signers are resolved once, up front, into {address, forgeArgs, castArgs}.
 * Migration scripts only ever receive addresses; the private key never enters
 * this process. Foundry matches each `vm.startBroadcast(address)` to one of
 * the wallets passed on the command line and refuses to broadcast if any
 * address has no wallet, so a mis-mapped role fails before anything is sent.
 *
 * Spec grammar for `--signer <role>=<spec>`:
 *   keystore:<path>        encrypted JSON keystore file; password prompted
 *                          (or ETH_PASSWORD / --password-file via env)
 *   account:<name>         keystore in ~/.foundry/keystores (or $FOUNDRY_KEYSTORES)
 *   ledger[:<index>]       hardware wallet, HD index (default 0); one per run
 *   unlocked:<address>     RPC-unlocked account (Anvil / fork tests only)
 */

const DEFAULT_KEYSTORES = process.env.FOUNDRY_KEYSTORES ?? path.join(homedir(), '.foundry', 'keystores');

export async function resolveSigner(spec, { rpcUrl } = {}) {
  const [kind, ...rest] = spec.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'keystore':
    case 'account': {
      const file = kind === 'account' ? path.join(DEFAULT_KEYSTORES, value) : path.resolve(value);
      const { address } = JSON.parse(await readFile(file, 'utf8'));
      const checksummed = capture('cast', ['to-check-sum-address', address.startsWith('0x') ? address : `0x${address}`]);
      return {
        spec,
        address: checksummed,
        forgeArgs: ['--keystore', file],
        castArgs: ['--keystore', file],
      };
    }
    case 'ledger': {
      const index = value === '' ? 0 : Number(value);
      if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid ledger index in ${spec}`);
      const address = capture('cast', ['wallet', 'address', '--ledger', '--mnemonic-index', String(index)]);
      return {
        spec,
        address,
        forgeArgs: ['--ledger', '--mnemonic-indexes', String(index)],
        castArgs: ['--ledger', '--mnemonic-index', String(index)],
      };
    }
    case 'unlocked': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`unlocked signer needs an address: ${spec}`);
      if (!rpcUrl) throw new Error('unlocked signers require an RPC URL');
      // Anvil unlocks every impersonated account; forge only needs the mode flag.
      return {
        spec,
        address: capture('cast', ['to-check-sum-address', value]),
        forgeArgs: ['--unlocked'],
        castArgs: ['--unlocked', '--from', value],
      };
    }
    default:
      throw new Error(`Unknown signer spec ${spec}; use keystore:<path>, account:<name>, ledger[:<index>], or unlocked:<address>`);
  }
}

/** Parses repeated `--signer role=spec` arguments into { role: spec }. */
export function parseSignerSpecs(values) {
  const specs = {};
  for (const value of values) {
    const at = value.indexOf('=');
    if (at <= 0) throw new Error(`--signer expects <role>=<spec>, got ${value}`);
    const role = value.slice(0, at);
    if (specs[role]) throw new Error(`Signer ${role} given twice`);
    specs[role] = value.slice(at + 1);
  }
  return specs;
}

/**
 * Resolves every required role. Distinct wallets are de-duplicated so two
 * roles held by the same key map to a single `--keystore` flag, and only one
 * Ledger may be used per run (Foundry accepts `--ledger` once).
 */
export async function resolveSigners(specs, roles, { rpcUrl } = {}) {
  const missing = roles.filter((role) => !specs[role]);
  if (missing.length) {
    throw new Error(`Missing signers: ${missing.map((role) => `--signer ${role}=<spec>`).join(' ')}`);
  }
  const ledgers = new Set(roles.map((role) => specs[role]).filter((spec) => spec.startsWith('ledger')));
  if (ledgers.size > 1) throw new Error('Foundry accepts one --ledger per run; hold at most one role on a Ledger');
  const signers = {};
  const walletArgs = new Map();
  for (const role of roles) {
    const signer = await resolveSigner(specs[role], { rpcUrl });
    signers[role] = signer;
    walletArgs.set(signer.forgeArgs.join(' '), signer.forgeArgs);
  }
  return { signers, forgeArgs: [...walletArgs.values()].flat() };
}

export function addresses(signers) {
  return Object.fromEntries(Object.entries(signers).map(([role, signer]) => [role, signer.address]));
}

export function signerEnvironment(names, signerAddresses) {
  return Object.fromEntries(
    Object.entries(signerAddresses).filter(([role]) => names[role]).map(([role, address]) => [names[role], address]),
  );
}

export function assertSignerOwners(rpcUrl, environment, names, requirements) {
  for (const [role, contract, label] of requirements) {
    requireEnvironment([names[role]], environment);
    const address = environment[names[role]];
    if (!sameAddress(call(rpcUrl, contract, 'owner()(address)'), address)) {
      throw new Error(`${role} (${address}) is not the ${label} owner`);
    }
  }
}
