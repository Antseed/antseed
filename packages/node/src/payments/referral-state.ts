import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAddress } from 'ethers';
import type { ReferralInvite } from '@antseed/protocol/signatures';
import { decodeInvite } from './invites.js';

/**
 * Local referral state shared by Desktop and the CLI, stored at
 * `<dataDir>/referral.json`. Redeeming an invite (after `previewInvite`
 * passed) saves it as `invited`; the buyer daemon carries it in the metadata
 * it signs until AntseedStatsV2 binds it on a settlement, and Antscan reports
 * the binding, which is recorded as `bound`. Nothing here signs or sends
 * anything on-chain.
 *
 *   none → invited (pending first settlement) → bound
 *
 * `issued` remembers the invites this wallet handed out in its latest issue
 * epoch, so the next one gets a fresh index even before either is used.
 */
export type ReferralState = {
  state: 'none' | 'invited' | 'bound';
  /** The redeemed invite string, while `invited`. */
  invite?: string;
  /** The inviter: recovered from the invite while `invited`, per Antscan once `bound`. */
  referrer?: string;
  /** Invite indices handed out for `issued.epoch`. */
  issued?: { epoch: number; indices: number[] };
  /** ISO timestamp of the last write. */
  updatedAt?: string;
};

/**
 * The buyer's bound referrer: an address, null while unbound, or undefined
 * when unknown (lookup unavailable or failed). Backed by Antscan, so it costs
 * no RPC reads.
 */
export type ReferralLookup = (buyer: string) => Promise<string | null | undefined>;

/** Checksummed wallet, or null when `value` is not an address. */
export function normalizeReferrer(value: string | null | undefined): string | null {
  try {
    return getAddress(value?.trim() ?? '');
  } catch {
    return null;
  }
}

function referralStatePath(dataDir: string): string {
  return join(dataDir, 'referral.json');
}

export async function readReferralState(dataDir: string): Promise<ReferralState | null> {
  try {
    const parsed = JSON.parse(await readFile(referralStatePath(dataDir), 'utf8')) as ReferralState;
    if (!parsed || !['none', 'invited', 'bound'].includes(parsed.state)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeReferralState(dataDir: string, state: ReferralState): Promise<ReferralState> {
  const filePath = referralStatePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  const stored = { ...state, updatedAt: new Date().toISOString() };
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  return stored;
}

export async function referralStateMtimeMs(dataDir: string): Promise<number | null> {
  try {
    return (await stat(referralStatePath(dataDir))).mtimeMs;
  } catch {
    return null;
  }
}

/** The redeemed, not-yet-bound invite to carry in signed metadata; null otherwise. */
export function pendingInvite(state: ReferralState | null): ReferralInvite | null {
  if (state?.state !== 'invited' || !state.invite) return null;
  try {
    return decodeInvite(state.invite);
  } catch {
    return null;
  }
}

/**
 * Save a checked invite (see `checkInvite`) as pending so the buyer daemon
 * carries it. A bound referral is kept and returned instead: it cannot change.
 */
export async function saveReferralInvite(dataDir: string, invite: string, referrer: string): Promise<ReferralState> {
  const stored = await readReferralState(dataDir);
  if (stored?.state === 'bound') return stored;
  return writeReferralState(dataDir, { ...keepIssued(stored), state: 'invited', invite, referrer: getAddress(referrer) });
}

/** Drop a pending invite. A bound referral is kept. */
export async function clearReferralInvite(dataDir: string): Promise<ReferralState> {
  const stored = await readReferralState(dataDir);
  if (stored?.state === 'bound') return stored;
  return writeReferralState(dataDir, { ...keepIssued(stored), state: 'none' });
}

/** Invite indices this install already handed out for `epoch`. */
export function issuedInviteIndices(state: ReferralState | null, epoch: number): number[] {
  return state?.issued?.epoch === epoch ? state.issued.indices : [];
}

/** Remember that invite (epoch, index) was handed out; older epochs are forgotten. */
export async function recordIssuedInvite(dataDir: string, epoch: number, index: number): Promise<ReferralState> {
  const stored = await readReferralState(dataDir);
  const indices = [...new Set([...issuedInviteIndices(stored, epoch), index])].sort((a, b) => a - b);
  return writeReferralState(dataDir, { ...(stored ?? { state: 'none' }), issued: { epoch, indices } });
}

function keepIssued(state: ReferralState | null): Pick<ReferralState, 'issued'> {
  return state?.issued ? { issued: state.issued } : {};
}

/**
 * Re-read the state file and, once Antscan reports a pending invite bound,
 * record it so the daemon stops carrying the invite. An unknown answer keeps the
 * local state.
 */
export async function syncReferralState(
  dataDir: string,
  buyer: string,
  lookup: ReferralLookup | null,
): Promise<ReferralState | null> {
  const state = await readReferralState(dataDir);
  if (state?.state !== 'invited' || !lookup) return state;
  const bound = normalizeReferrer(await lookup(buyer).catch(() => undefined));
  if (!bound) return state;
  const boundState: ReferralState = { ...keepIssued(state), state: 'bound', referrer: bound };
  return writeReferralState(dataDir, boundState).catch(() => boundState);
}
