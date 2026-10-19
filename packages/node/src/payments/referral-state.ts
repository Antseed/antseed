import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import type { ReferralInvite } from '@antseed/protocol/signatures';
import type { ReferralsClient } from './evm/referrals-client.js';
import { decodeInvite } from './invites.js';
import { withFileLock } from '../utils/file-lock.js';

/**
 * Local referral state shared by Desktop and the CLI, stored at
 * `<dataDir>/referral.json`. Redeeming an invite (after `previewInvite`
 * passed) saves it as `invited`; the buyer daemon carries it in the metadata
 * it signs until AntseedStatsV2 binds it on a settlement, which Antscan hints
 * and `referrerOf` confirms before it is recorded as `bound`. Nothing here
 * signs or sends anything on-chain.
 *
 *   none → invited (pending first settlement) → bound
 *
 * Every record is scoped to a wallet on one AntseedReferrals deployment
 * (`ReferralScope`), so switching networks or deployments with the same data
 * directory neither carries an invite signed for another deployment nor
 * blocks a new one with a binding made elsewhere. The issued-invite indices
 * are scoped the same way, by the signing wallet.
 *
 * Every read-modify-write of the file runs under `referral.lock` (see
 * `updateFile`), shared by every process using the data directory, so a
 * redemption, a daemon sync and an invite allocation never drop each
 * other's updates. That lock is only held for local file IO and never
 * nests another lock; callers that need a longer critical section (invite
 * allocation) take their own lock first and update the file inside it.
 */
export type ReferralState = {
  state: 'none' | 'invited' | 'bound';
  /** The redeemed invite string, while `invited`. */
  invite?: string;
  /** The inviter: recovered from the invite while `invited`, confirmed on-chain once `bound`. */
  referrer?: string;
  /**
   * Read from a record written before state was scoped: it may belong to
   * another wallet or deployment, so a `bound` one is checked on-chain (see
   * `syncReferralState`) and can be replaced by a new invite meanwhile.
   */
  unverified?: true;
  /** ISO timestamp of the last write. */
  updatedAt?: string;
};

/** A wallet (the buyer as referee, the signer as referrer) on one referrals deployment. */
export type ReferralScope = {
  wallet: string;
  chainId: number;
  referralsAddress: string;
};

/**
 * The buyer's bound referrer: an address, null while unbound, or undefined
 * when unknown (lookup unavailable or failed).
 */
export type ReferralLookup = (buyer: string) => Promise<string | null | undefined>;

/** How `syncReferralState` learns about a binding. */
export type ReferralLookups = {
  /** Advisory and free of RPC (Antscan): asked first, never trusted alone. */
  explorer?: ReferralLookup | null;
  /** Authoritative: `referrerOf` on the configured deployment (see `referrerOfLookup`). */
  chain?: ReferralLookup | null;
};

type IssuedInvites = { epoch: number; indices: number[] };

type ReferralFile = {
  version: 2;
  /** Referee state by `scopeKey(buyer scope)`. */
  referees: Record<string, ReferralState>;
  /** Invite indices handed out in each signer's latest issue epoch, by `scopeKey(signer scope)`. */
  issued: Record<string, IssuedInvites>;
  /** The unscoped record of a version-1 file, until a scoped write replaces it. */
  legacy?: { state?: ReferralState; issued?: IssuedInvites };
};

const STATES: ReadonlyArray<ReferralState['state']> = ['none', 'invited', 'bound'];

/** Checksummed wallet, or null when `value` is not an address. */
export function normalizeReferrer(value: string | null | undefined): string | null {
  try {
    return getAddress(value?.trim() ?? '');
  } catch {
    return null;
  }
}

/** `referrerOf(buyer)` as a lookup: null while unbound (zero address); a failed read rejects. */
export function referrerOfLookup(client: Pick<ReferralsClient, 'referrerOf'>): ReferralLookup {
  return async (buyer) => {
    const referrer = await client.referrerOf(buyer);
    return referrer === ZeroAddress ? null : getAddress(referrer);
  };
}

function referralStatePath(dataDir: string): string {
  return join(dataDir, 'referral.json');
}

function referralLockPath(dataDir: string): string {
  return join(dataDir, 'referral.lock');
}

function scopeKey(scope: ReferralScope): string {
  return `${scope.chainId}:${getAddress(scope.referralsAddress)}:${getAddress(scope.wallet)}`;
}

function validState(value: unknown): ReferralState | undefined {
  const state = value as ReferralState | null | undefined;
  return state && STATES.includes(state.state) ? state : undefined;
}

function validIssued(value: unknown): IssuedInvites | undefined {
  const issued = value as IssuedInvites | null | undefined;
  return issued && Number.isInteger(issued.epoch) && Array.isArray(issued.indices) ? issued : undefined;
}

async function readFileState(dataDir: string): Promise<ReferralFile> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(referralStatePath(dataDir), 'utf8')) as Record<string, unknown>;
  } catch {
    return { version: 2, referees: {}, issued: {} };
  }
  if (parsed?.['version'] === 2) {
    const file = parsed as unknown as ReferralFile;
    return { version: 2, referees: file.referees ?? {}, issued: file.issued ?? {}, ...(file.legacy ? { legacy: file.legacy } : {}) };
  }
  // Version 1: one unscoped record, kept as unverified legacy state.
  const state = validState(parsed);
  const issued = validIssued(parsed?.['issued']);
  const legacy = {
    ...(state ? { state: { state: state.state, ...(state.invite ? { invite: state.invite } : {}), ...(state.referrer ? { referrer: state.referrer } : {}) } } : {}),
    ...(issued ? { issued } : {}),
  };
  return { version: 2, referees: {}, issued: {}, ...(state || issued ? { legacy } : {}) };
}

async function writeFileState(dataDir: string, file: ReferralFile): Promise<void> {
  const filePath = referralStatePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  // Unique per writer, so overlapping writes never rename each other's file.
  const temporaryPath = `${filePath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Read the file, apply `change`, and write it back when `change` asks to,
 * all under the shared referral lock.
 */
async function updateFile<T>(dataDir: string, change: (file: ReferralFile) => { result: T; write: boolean }): Promise<T> {
  return withFileLock(referralLockPath(dataDir), async () => {
    const file = await readFileState(dataDir);
    const { result, write } = change(file);
    if (write) await writeFileState(dataDir, file);
    return result;
  });
}

/** This scope's referee state; an unscoped legacy record is returned as `unverified`. */
export async function readReferralState(dataDir: string, scope: ReferralScope): Promise<ReferralState | null> {
  return refereeState(await readFileState(dataDir), scope);
}

function refereeState(file: ReferralFile, scope: ReferralScope): ReferralState | null {
  const scoped = validState(file.referees[scopeKey(scope)]);
  if (scoped) return scoped;
  const legacy = validState(file.legacy?.state);
  return legacy ? { ...legacy, unverified: true } : null;
}

/** Replace this scope's referee state. The legacy record is dropped: this scope has adopted or replaced it. */
export async function writeReferralState(dataDir: string, scope: ReferralScope, state: ReferralState): Promise<ReferralState> {
  return (await updateRefereeState(dataDir, scope, () => state))!;
}

/**
 * Atomically replace this scope's referee state with `next(current)`, or
 * keep it (returned unchanged) when `next` returns null.
 */
async function updateRefereeState(
  dataDir: string,
  scope: ReferralScope,
  next: (current: ReferralState | null) => ReferralState | null,
): Promise<ReferralState | null> {
  return updateFile<ReferralState | null>(dataDir, (file) => {
    const current = refereeState(file, scope);
    const state = next(current);
    if (!state) return { result: current, write: false };
    const { unverified: _unverified, ...rest } = state;
    const stored: ReferralState = { ...rest, updatedAt: new Date().toISOString() };
    file.referees[scopeKey(scope)] = stored;
    if (file.legacy?.state) delete file.legacy.state;
    return { result: stored, write: true };
  });
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

/** A binding for this exact scope; it cannot change. */
function isFinal(state: ReferralState | null): state is ReferralState {
  return state?.state === 'bound' && !state.unverified;
}

/**
 * Save a checked invite (see `checkInvite`) as pending for `scope` so the
 * buyer daemon carries it, replacing an earlier pending one. A binding on
 * this deployment is kept and returned instead: it cannot change.
 */
export async function saveReferralInvite(dataDir: string, scope: ReferralScope, invite: string, referrer: string): Promise<ReferralState> {
  const checksummed = getAddress(referrer);
  // Kept only when final, so never null.
  return (await updateRefereeState(dataDir, scope, (stored) => (isFinal(stored) ? null : { state: 'invited', invite, referrer: checksummed })))!;
}

/** Drop a pending invite. A binding on this deployment is kept. */
export async function clearReferralInvite(dataDir: string, scope: ReferralScope): Promise<ReferralState> {
  return (await updateRefereeState(dataDir, scope, (stored) => (isFinal(stored) ? null : { state: 'none' })))!;
}

/**
 * Invite indices this install already handed out for `epoch`, signed by
 * `scope.wallet` for its deployment. Indices from an unscoped legacy record
 * count too: reusing one could hand out an invite twice.
 */
export async function readIssuedInviteIndices(dataDir: string, scope: ReferralScope, epoch: number): Promise<number[]> {
  const file = await readFileState(dataDir);
  return issuedIndices(file, scope, epoch);
}

function issuedIndices(file: ReferralFile, scope: ReferralScope, epoch: number): number[] {
  const scoped = validIssued(file.issued[scopeKey(scope)]);
  const legacy = validIssued(file.legacy?.issued);
  return [...new Set([
    ...(scoped?.epoch === epoch ? scoped.indices : []),
    ...(legacy?.epoch === epoch ? legacy.indices : []),
  ])].sort((a, b) => a - b);
}

/** Remember that invite (epoch, index) was handed out for `scope`; older epochs are forgotten. */
export async function recordIssuedInvite(dataDir: string, scope: ReferralScope, epoch: number, index: number): Promise<number[]> {
  return updateFile(dataDir, (file) => {
    const indices = [...new Set([...issuedIndices(file, scope, epoch), index])].sort((a, b) => a - b);
    file.issued[scopeKey(scope)] = { epoch, indices };
    if (file.legacy?.issued) delete file.legacy.issued;
    return { result: indices, write: true };
  });
}

async function ask(lookup: ReferralLookup | null | undefined, buyer: string): Promise<string | null | undefined> {
  if (!lookup) return undefined;
  const answer = await lookup(buyer).catch(() => undefined);
  if (answer === null) return null;
  const referrer = normalizeReferrer(answer);
  return referrer === ZeroAddress ? null : referrer ?? undefined;
}

/** Shortest and longest wait between `referrerOf` reads while Antscan does not report a binding. */
export const REFERRAL_CHAIN_RECHECK_MIN_MS = 10 * 60_000;
export const REFERRAL_CHAIN_RECHECK_MAX_MS = 60 * 60_000;

/**
 * When `referrerOf` may next be read for a pending invite, by data directory
 * and scope. Kept in memory: each process reads at most once per backoff
 * window (plus once per Antscan hint), and a restart only costs one read.
 */
type ChainRecheck = { invite: string; nextAt: number; delayMs: number; hinted: boolean };
const chainRechecks = new Map<string, ChainRecheck>();

export type SyncReferralOptions = {
  /** Clock for the `referrerOf` backoff; tests only. */
  now?: () => number;
};

/**
 * Re-read this scope's state and record a binding once it is confirmed on
 * the configured deployment, so the daemon stops carrying the invite.
 *
 * While an invite is pending, Antscan (`explorer`) is the cheap trigger: when
 * it reports a binding, `referrerOf` (`chain`) is read, and only its answer
 * is persisted. Antscan may be absent, down, or not index this deployment,
 * so `referrerOf` is also read on a backoff while Antscan does not report a
 * binding: at once, then after REFERRAL_CHAIN_RECHECK_MIN_MS, doubling up to
 * REFERRAL_CHAIN_RECHECK_MAX_MS. A hint Antscan repeats without the chain
 * confirming it waits for that schedule too, so RPC reads stay bounded. An
 * unknown or unconfirmed answer keeps the invite. A legacy `bound` record is
 * checked with `referrerOf` directly and becomes this scope's binding, or
 * `none` when the buyer is unbound here.
 */
export async function syncReferralState(
  dataDir: string,
  scope: ReferralScope,
  lookups: ReferralLookups,
  options: SyncReferralOptions = {},
): Promise<ReferralState | null> {
  const now = options.now ?? Date.now;
  const state = await readReferralState(dataDir, scope);
  const recheckKey = `${dataDir}\0${scopeKey(scope)}`;
  if (state?.state !== 'invited') chainRechecks.delete(recheckKey);
  if (state?.state === 'invited') {
    const hint = await ask(lookups.explorer, scope.wallet);
    if (!lookups.chain) return state;
    let recheck = chainRechecks.get(recheckKey);
    if (!recheck || recheck.invite !== state.invite) {
      recheck = { invite: state.invite ?? '', nextAt: 0, delayMs: REFERRAL_CHAIN_RECHECK_MIN_MS, hinted: false };
      chainRechecks.set(recheckKey, recheck);
    }
    const due = now() >= recheck.nextAt;
    if (!due && !(hint && !recheck.hinted)) return state;
    // Book the read before awaiting it, so concurrent syncs do not repeat it.
    if (due) {
      recheck.nextAt = now() + recheck.delayMs;
      recheck.delayMs = Math.min(recheck.delayMs * 2, REFERRAL_CHAIN_RECHECK_MAX_MS);
    }
    recheck.hinted = !!hint;
    const bound = await ask(lookups.chain, scope.wallet);
    if (!bound) return state;
    chainRechecks.delete(recheckKey);
    // A confirmed binding is final, whatever was saved during the lookups.
    const boundState: ReferralState = { state: 'bound', referrer: bound };
    return writeReferralState(dataDir, scope, boundState).catch(() => boundState);
  }
  if (state?.state === 'bound' && state.unverified) {
    const bound = await ask(lookups.chain, scope.wallet);
    if (bound === undefined) return state;
    const verified: ReferralState = bound ? { state: 'bound', referrer: bound } : { state: 'none' };
    // "Unbound here" only replaces the legacy record it checked, never an
    // invite redeemed for this scope during the lookup.
    return updateRefereeState(dataDir, scope, (current) => (bound || current?.unverified ? verified : null)).catch(() => verified);
  }
  return state;
}
