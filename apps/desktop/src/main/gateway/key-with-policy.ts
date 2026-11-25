/**
 * A new key only goes into use once the policy it must carry is on it. Saved
 * first, a failed policy write would leave an unrestricted key in use, and a
 * later call would accept it because it authenticates.
 */
export async function publishKeyWithPolicy<K>(options: {
  create: () => Promise<K>;
  /** Null when the key needs no policy. */
  applyPolicy: ((key: K) => Promise<void>) | null;
  revoke: (key: K) => Promise<void>;
  save: (key: K) => void;
}): Promise<K> {
  const key = await options.create();
  if (options.applyPolicy) {
    try {
      await options.applyPolicy(key);
    } catch (err) {
      await options.revoke(key).catch(() => undefined);
      throw err;
    }
  }
  options.save(key);
  return key;
}
