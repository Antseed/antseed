import type { Identity } from '@antseed/node';
import { isAttachOnly } from './attach-only.js';

export const ATTACH_ONLY_IMPORT_REFUSED =
  'This desktop is attached to an isolated testbench and signs with the testbench buyer\'s wallet; importing a key is disabled here. Import keys in a normal desktop, or test signer import on a full isolated profile (pnpm testbench mainnet).';

export type IdentityImportResult = {
  ok: boolean;
  address?: string;
  backupPath?: string | null;
  error?: string;
  identity?: Identity;
};

export type IdentityImportDeps = {
  safeStorageAvailable: () => boolean;
  toIdentity: (hex: string) => Identity;
  backup: () => Promise<string | null>;
  save: (hex: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

/** Refusal for attach-only desktops, before any secure storage or file is touched; null elsewhere. */
export function identityImportRefusal(env: NodeJS.ProcessEnv = process.env): { ok: false; error: string } | null {
  return isAttachOnly(env) ? { ok: false, error: ATTACH_ONLY_IMPORT_REFUSED } : null;
}

/**
 * Validates and stores an imported signer key. In attach-only mode it refuses first:
 * the encrypted identity it would replace belongs to the developer's real desktop.
 */
export async function importIdentityKey(rawKey: string, deps: IdentityImportDeps): Promise<IdentityImportResult> {
  const refused = identityImportRefusal(deps.env);
  if (refused) return refused;
  if (!deps.safeStorageAvailable()) {
    return { ok: false, error: 'Secure storage is not available on this system.' };
  }
  const hex = rawKey.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return { ok: false, error: 'Invalid private key: expected 64 hex characters (with or without a 0x prefix).' };
  }
  let identity: Identity;
  try {
    identity = deps.toIdentity(hex);
  } catch (err) {
    return { ok: false, error: `Invalid private key: ${err instanceof Error ? err.message : String(err)}` };
  }
  const backupPath = await deps.backup();
  await deps.save(hex);
  return { ok: true, address: identity.wallet.address, backupPath, identity };
}
