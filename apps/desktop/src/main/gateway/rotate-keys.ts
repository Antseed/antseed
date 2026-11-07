type RotatableKey = { id: string | null };

/** The gateway no longer knows the key (its database was reset, say), so nothing can use it. */
export function isKeyGone(err: unknown): boolean {
  return /unknown key/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Replaces keys one at a time. A key is only forgotten once the gateway has
 * revoked it: the old key may be leaked and still able to spend, so a failure
 * keeps its id for another try and is reported rather than passed off as done.
 * One failure doesn't stop the other keys from being replaced.
 */
export async function rotateKeys(
  scopes: readonly string[],
  ops: {
    get: (scope: string) => RotatableKey | null | undefined;
    revoke: (id: string) => Promise<void>;
    forget: (scope: string) => void;
  },
): Promise<void> {
  const failed: string[] = [];
  let reason = '';
  for (const scope of scopes) {
    const existing = ops.get(scope);
    try {
      if (existing?.id) await ops.revoke(existing.id);
      ops.forget(scope);
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
    throw new Error(`Could not replace the ${failed.join(', ')} key: the old one still works. Try again. (${reason})`);
  }
}
