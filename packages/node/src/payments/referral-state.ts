import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import type { ReferralInvite } from '@antseed/protocol/signatures';
import { decodeInvite, recoverInviter, type InviteDomain } from './invites.js';

/**
 * Local referral state shared by Desktop and the CLI, stored at
 * `<dataDir>/referral.json`. Redeeming an invite (after `previewInvite`
 * passed) saves it as `invited`; the buyer daemon carries it in the metadata
 * it signs until AntseedStatsV2 binds it on a settlement, and the Referrals
 * contract confirms the binding, which is recorded as `bound`. Nothing here
 * signs or sends anything on-chain.
 *
 *   none → invited (pending first settlement) → bound
 *
 * `issued` remembers the invites this wallet handed out in its latest issue
 * epoch, so the next one gets a fresh index even before either is used.
 *
 * Each wallet keeps its own state per Referrals deployment (chain id +
 * contract, the invite's EIP-712 domain), so neither switching networks nor
 * replacing the wallet that uses the data directory reuses another
 * binding, pending invite or issued indices.
 */
export type ReferralState = {
  state: 'none' | 'invited' | 'bound';
  /** The redeemed invite string, while `invited`. */
  invite?: string;
  /** The inviter: recovered from the invite while `invited`, per the Referrals contract once `bound`. */
  referrer?: string;
  /** Invite indices handed out for `issued.epoch`. */
  issued?: { epoch: number; indices: number[] };
  /** ISO timestamp of the last write. */
  updatedAt?: string;
};

/** Whose state it is: the wallet, on a Referrals deployment (the invite's EIP-712 domain). */
export type ReferralScope = InviteDomain & { wallet: string };

/**
 * The buyer's bound referrer: an address, null while unbound, or undefined
 * when unknown (lookup unavailable or failed).
 */
export type ReferralLookup = (buyer: string) => Promise<string | null | undefined>;

type ReferralStateFile = {
  version: 2;
  deployments: Record<string, ReferralState>;
  /** A pre-scoped file's state, kept until the deployment it belongs to adopts it. */
  legacy?: ReferralState;
};

const STATES: ReadonlyArray<ReferralState['state']> = ['none', 'invited', 'bound'];

/** Checksummed wallet, or null when `value` is not an address (or is the zero address). */
export function normalizeReferrer(value: string | null | undefined): string | null {
  try {
    const address = getAddress(value?.trim() ?? '');
    return address === ZeroAddress ? null : address;
  } catch {
    return null;
  }
}

function referralStatePath(dataDir: string): string {
  return join(dataDir, 'referral.json');
}

function scopeKey(scope: ReferralScope): string {
  return `${scope.chainId}:${getAddress(scope.referralsAddress).toLowerCase()}:${getAddress(scope.wallet).toLowerCase()}`;
}

function validState(value: unknown): ReferralState | null {
  const state = value as ReferralState | null;
  return state && typeof state === 'object' && STATES.includes(state.state) ? state : null;
}

async function readStateFile(dataDir: string): Promise<ReferralStateFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(referralStatePath(dataDir), 'utf8'));
  } catch {
    return { version: 2, deployments: {} };
  }
  const file = parsed as Partial<ReferralStateFile> | null;
  if (file?.version === 2 && file.deployments && typeof file.deployments === 'object') {
    const legacy = validState(file.legacy);
    return { version: 2, deployments: file.deployments, ...(legacy ? { legacy } : {}) };
  }
  // Written before states were scoped to a deployment.
  const legacy = validState(parsed);
  return { version: 2, deployments: {}, ...(legacy ? { legacy } : {}) };
}

/**
 * A pre-scoped state belongs to `scope` only when it holds a pending invite
 * signed for that deployment by the recorded referrer (the first wallet that
 * writes its state there takes it over). A bound state carries
 * nothing that names its deployment, so it is never assumed bound on any of
 * them: the wallet reads as unbound and redemption is checked on-chain again.
 */
function adoptLegacy(legacy: ReferralState | undefined, scope: ReferralScope): ReferralState | null {
  if (legacy?.state !== 'invited' || !legacy.invite || !legacy.referrer) return null;
  let invite: ReferralInvite;
  try {
    invite = decodeInvite(legacy.invite);
  } catch {
    return null;
  }
  const signer = recoverInviter(invite, { chainId: scope.chainId, referralsAddress: scope.referralsAddress });
  return signer && signer === normalizeReferrer(legacy.referrer) ? legacy : null;
}

function stateIn(file: ReferralStateFile, scope: ReferralScope): ReferralState | null {
  return validState(file.deployments[scopeKey(scope)]) ?? adoptLegacy(file.legacy, scope);
}

export async function readReferralState(dataDir: string, scope: ReferralScope): Promise<ReferralState | null> {
  return stateIn(await readStateFile(dataDir), scope);
}

async function writeStateFile(dataDir: string, file: ReferralStateFile): Promise<void> {
  const filePath = referralStatePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  // Unique per write: concurrent writers never share (or rename away) each other's file.
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_TIMEOUT_MS = 45_000;
const LOCK_RETRY_MS = 25;
/** The takeover lock is held for a few file operations only. */
const TAKEOVER_STALE_MS = 10_000;

/** In-process queue per state file, so this process waits on a promise rather than polling its own lock. */
const localLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` holding the data dir's referral lock: one writer at a time across
 * this process and every other (CLI, Desktop, buyer daemon, dashboard) that
 * shares the directory. The lock file names its holder with a random token
 * and is refreshed while held; one left by a crashed process is taken over
 * once it goes stale (see `takeOverStaleLock`), and release removes it only
 * while it still holds this holder's token.
 */
async function withReferralLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${referralStatePath(dataDir)}.lock`;
  const previous = localLocks.get(lockPath) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const token = await acquireFileLock(lockPath);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await releaseFileLock(lockPath, token);
    }
  });
  localLocks.set(lockPath, run);
  try {
    return await run;
  } finally {
    if (localLocks.get(lockPath) === run) localLocks.delete(lockPath);
  }
}

/** Create `path` exclusively holding `token`; false when it already exists. */
async function createExclusive(path: string, token: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${token}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** The lock's holder token and age, or null when there is no lock. */
async function inspectLock(path: string): Promise<{ token: string; ageMs: number } | null> {
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { token: content.trim(), ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}

async function acquireFileLock(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    if (await createExclusive(lockPath, token)) return token;
    const held = await inspectLock(lockPath);
    if (held && held.ageMs > LOCK_STALE_MS) {
      await takeOverStaleLock(lockPath, held.token);
      continue;
    }
    if (Date.now() > deadline) throw new Error('Referral state is busy; try again.');
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/**
 * Remove a stale lock without racing another recoverer. Checking a lock's
 * age and removing it are separate steps, so two processes that both saw
 * it stale could otherwise both remove it, the second deleting the fresh
 * lock the first just took. Removal therefore happens only under a
 * takeover lock, and only after re-checking, under it, that the lock is
 * still the same stale one (same holder token, still stale): a fresh lock
 * cannot appear in between, because nothing creates the lock while the
 * stale one exists and only a takeover holder removes it. Exported for tests;
 * not part of the package API.
 */
export async function takeOverStaleLock(lockPath: string, staleToken: string): Promise<void> {
  const takeoverPath = `${lockPath}.takeover`;
  const token = `${process.pid}:${randomUUID()}`;
  if (!(await createExclusive(takeoverPath, token))) {
    // Another process is recovering it; a takeover lock left by a crash mid-recovery is cleared.
    const takeover = await inspectLock(takeoverPath);
    if (takeover && takeover.ageMs > TAKEOVER_STALE_MS) await releaseFileLock(takeoverPath, takeover.token);
    return;
  }
  try {
    const held = await inspectLock(lockPath);
    if (held && held.token === staleToken && held.ageMs > LOCK_STALE_MS) await rm(lockPath, { force: true });
  } finally {
    await releaseFileLock(takeoverPath, token);
  }
}

/** Remove `path` only while it still names `token` as its holder. */
async function releaseFileLock(path: string, token: string): Promise<void> {
  const held = await inspectLock(path);
  if (held?.token === token) await rm(path, { force: true });
}

/**
 * Read-modify-write `scope`'s state under the data dir's lock. `update` gets
 * the latest stored state and returns the next one, or null to leave it as
 * is; the result is the state now stored.
 */
export async function updateReferralState(
  dataDir: string,
  scope: ReferralScope,
  update: (current: ReferralState | null) => ReferralState | null | Promise<ReferralState | null>,
): Promise<ReferralState | null> {
  return withReferralLock(dataDir, async () => {
    const file = await readStateFile(dataDir);
    const current = stateIn(file, scope);
    const next = await update(current);
    if (!next) return current;
    const stored: ReferralState = { ...next, updatedAt: new Date().toISOString() };
    const deployments = { ...file.deployments, [scopeKey(scope)]: stored };
    // A legacy state this deployment adopted is now stored under it.
    const legacy = file.legacy && !adoptLegacy(file.legacy, scope) ? file.legacy : undefined;
    await writeStateFile(dataDir, { version: 2, deployments, ...(legacy ? { legacy } : {}) });
    return stored;
  });
}

export async function writeReferralState(dataDir: string, scope: ReferralScope, state: ReferralState): Promise<ReferralState> {
  return (await updateReferralState(dataDir, scope, () => state))!;
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
export async function saveReferralInvite(dataDir: string, scope: ReferralScope, invite: string, referrer: string): Promise<ReferralState> {
  const stored = await updateReferralState(dataDir, scope, (current) =>
    current?.state === 'bound' ? null : { ...keepIssued(current), state: 'invited', invite, referrer: getAddress(referrer) });
  return stored!;
}

/** Drop a pending invite. A bound referral is kept. */
export async function clearReferralInvite(dataDir: string, scope: ReferralScope): Promise<ReferralState> {
  const stored = await updateReferralState(dataDir, scope, (current) =>
    current?.state === 'bound' ? null : { ...keepIssued(current), state: 'none' });
  return stored!;
}

/** Invite indices this install already handed out for `epoch`. */
export function issuedInviteIndices(state: ReferralState | null, epoch: number): number[] {
  return state?.issued?.epoch === epoch ? state.issued.indices : [];
}

/** `state` with invite (epoch, index) recorded as handed out; older epochs are forgotten. */
export function withIssuedInvite(state: ReferralState | null, epoch: number, index: number): ReferralState {
  const indices = [...new Set([...issuedInviteIndices(state, epoch), index])].sort((a, b) => a - b);
  return { ...(state ?? { state: 'none' }), issued: { epoch, indices } };
}

/** Remember that invite (epoch, index) was handed out; older epochs are forgotten. */
export async function recordIssuedInvite(dataDir: string, scope: ReferralScope, epoch: number, index: number): Promise<ReferralState> {
  return (await updateReferralState(dataDir, scope, (current) => withIssuedInvite(current, epoch, index)))!;
}

function keepIssued(state: ReferralState | null): Pick<ReferralState, 'issued'> {
  return state?.issued ? { issued: state.issued } : {};
}

/** How often an explorer's "not bound yet" is double-checked on-chain. */
export const REFERRAL_RECHECK_MS = 10 * 60_000;
const lastOnChainCheck = new Map<string, number>();

export interface SyncReferralOptions {
  /** Minimum time between on-chain checks while the explorer reports no binding. */
  recheckMs?: number;
  now?: () => number;
}

/**
 * Re-read the state file and, once a pending invite is bound, record it so
 * the daemon stops carrying the invite. The binding is recorded only once
 * `verify` (the Referrals contract's `referrerOf`) confirms it; without a
 * verifier the invite stays pending. `lookup` (Antscan, no RPC) is a fast
 * path: a reported binding is verified right away, an explorer failure or
 * unknown answer falls back to `verify`, and "not bound" is still checked
 * on-chain every `recheckMs`, so a lagging or broken explorer cannot keep a
 * bound invite pending. An unknown answer from `verify` keeps the local state.
 */
export async function syncReferralState(
  dataDir: string,
  scope: ReferralScope,
  lookup: ReferralLookup | null,
  verify: ReferralLookup | null = null,
  options: SyncReferralOptions = {},
): Promise<ReferralState | null> {
  const state = await readReferralState(dataDir, scope);
  if (state?.state !== 'invited' || !verify) return state;
  if (lookup) {
    const hinted = await lookup(scope.wallet).catch(() => undefined);
    if (hinted === null || (hinted !== undefined && !normalizeReferrer(hinted))) {
      const key = `${resolve(dataDir)}|${scopeKey(scope)}`;
      const now = (options.now ?? Date.now)();
      const last = lastOnChainCheck.get(key);
      if (last !== undefined && now - last < (options.recheckMs ?? REFERRAL_RECHECK_MS)) return state;
      lastOnChainCheck.set(key, now);
    }
  }
  const bound = normalizeReferrer(await verify(scope.wallet).catch(() => undefined));
  if (!bound) return state;
  const boundState: ReferralState = { ...keepIssued(state), state: 'bound', referrer: bound };
  // Applied to the latest state: a write made while the lookups ran (an
  // issued index, a replaced invite) is kept, not overwritten.
  return updateReferralState(dataDir, scope, (latest) =>
    latest?.state === 'invited' && latest.invite === state.invite ? { ...boundState, ...keepIssued(latest) } : null,
  ).catch(() => boundState);
}
