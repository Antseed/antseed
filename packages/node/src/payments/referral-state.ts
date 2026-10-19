import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
 * Each Referrals deployment (chain id + contract, the invite's EIP-712
 * domain) keeps its own state in the file, so switching networks with the
 * same data directory neither reuses another deployment's binding nor its
 * pending invite or issued indices.
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

/** The Referrals deployment a state belongs to: the invite's EIP-712 domain. */
export type ReferralScope = InviteDomain;

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
  return `${scope.chainId}:${getAddress(scope.referralsAddress).toLowerCase()}`;
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
 * signed for that deployment by the recorded referrer. A bound state carries
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
  const signer = recoverInviter(invite, scope);
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

/** In-process queue per state file, so this process waits on a promise rather than polling its own lock. */
const localLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` holding the data dir's referral lock: one writer at a time across
 * this process and every other (CLI, Desktop, buyer daemon, dashboard) that
 * shares the directory. The lock file is refreshed while held, and one left
 * by a crashed process is taken over once it goes stale.
 */
async function withReferralLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${referralStatePath(dataDir)}.lock`;
  const previous = localLocks.get(lockPath) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    await acquireFileLock(lockPath);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(lockPath, now, now).catch(() => {});
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await rm(lockPath, { force: true });
    }
  });
  localLocks.set(lockPath, run);
  try {
    return await run;
  } finally {
    if (localLocks.get(lockPath) === run) localLocks.delete(lockPath);
  }
}

async function acquireFileLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => null);
    if (held !== null && held > LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error('Referral state is busy; try again.');
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
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

/**
 * Re-read the state file and, once a pending invite is bound, record it so
 * the daemon stops carrying the invite. `lookup` (Antscan, no RPC) is only a
 * hint: the binding is recorded once `verify` (the Referrals contract's
 * `referrerOf`) confirms it, and without a verifier the invite stays pending.
 * Without `lookup`, `verify` is asked directly. An unknown answer keeps the
 * local state.
 */
export async function syncReferralState(
  dataDir: string,
  scope: ReferralScope,
  buyer: string,
  lookup: ReferralLookup | null,
  verify: ReferralLookup | null = null,
): Promise<ReferralState | null> {
  const state = await readReferralState(dataDir, scope);
  if (state?.state !== 'invited' || !verify) return state;
  if (lookup && !normalizeReferrer(await lookup(buyer).catch(() => undefined))) return state;
  const bound = normalizeReferrer(await verify(buyer).catch(() => undefined));
  if (!bound) return state;
  const boundState: ReferralState = { ...keepIssued(state), state: 'bound', referrer: bound };
  // Applied to the latest state: a write made while the lookups ran (an
  // issued index, a replaced invite) is kept, not overwritten.
  return updateReferralState(dataDir, scope, (latest) =>
    latest?.state === 'invited' && latest.invite === state.invite ? { ...boundState, ...keepIssued(latest) } : null,
  ).catch(() => boundState);
}
