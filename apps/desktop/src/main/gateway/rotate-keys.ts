type RotatableKey = { id: string | null; secret: string };

/** The gateway no longer knows the key (its database was reset, say), so nothing can use it. */
export function isKeyGone(err: unknown): boolean {
  return /unknown key/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Issues a new secret for each key: same key on the gateway, so its limits,
 * policy and usage stay, and the old secret stops working. A failure keeps the
 * saved key for another try and is reported rather than passed off as done,
 * because the old secret may be leaked and can still spend. One failure doesn't
 * stop the others. `rotate` answers null for a key that can't come back
 * (revoked or expired): that one is forgotten, and a new key follows on demand.
 */
export async function rotateKeys(
  scopes: readonly string[],
  ops: {
    get: (scope: string) => RotatableKey | null | undefined;
    rotate: (id: string) => Promise<string | null>;
    save: (scope: string, secret: string) => void;
    forget: (scope: string) => void;
  },
): Promise<void> {
  const failed: string[] = [];
  let reason = '';
  for (const scope of scopes) {
    const existing = ops.get(scope);
    try {
      const secret = existing?.id ? await ops.rotate(existing.id) : null;
      if (secret) ops.save(scope, secret);
      else ops.forget(scope);
    } catch (err) {
      if (isKeyGone(err)) {
        ops.forget(scope);
        continue;
      }
      failed.push(scope);
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  if (failed.length > 0) {
    throw new Error(`The ${failed.join(', ')} key could not be changed and still works. Try again. (${reason})`);
  }
}

/** A gateway record of a key the app holds. */
export type KeyRecord = { status?: unknown; expiresAt?: unknown };

export function keyIsUsable(record: KeyRecord, now = Date.now()): boolean {
  return record.status === 'active' && !(typeof record.expiresAt === 'number' && record.expiresAt <= now);
}

/**
 * What to do when the gateway answers 401 for a saved key. Only a key it has
 * no record of may be recreated. A record means someone revoked, expired or
 * re-issued it on purpose, and a quiet replacement would undo that with a key
 * that has no limits or policy.
 */
export async function assertKeyMayBeRecreated(
  key: { id: string | null; label: string },
  readRecord: (id: string) => Promise<KeyRecord>,
): Promise<void> {
  if (!key.id) return;
  try {
    await readRecord(key.id);
  } catch (err) {
    if (isKeyGone(err)) return;
    throw err;
  }
  throw new Error(`The "${key.label}" key was revoked, expired or replaced in the Gateway Console. Restore it there, or choose Replace keys in Settings.`);
}
