type PrivacyMode = 'anonymous' | 'private';

/**
 * Private covers the whole gateway: the desktop's key and every app's own key.
 * The desktop key's policy is what the app shows as the mode, so it changes in
 * the order that never claims more privacy than the apps have: into Private it
 * goes last, after every app key; out of Private it goes first. A failed write
 * stops there and is reported, so a half-applied switch is never shown as done.
 * `commit` saves the mode; a key saved while the switch ran gets it after that
 * (see `publishUnderCurrentPrivacy` for one saved after).
 */
export async function applyPrivacyToKeys(
  mode: PrivacyMode,
  desktopKeyId: string,
  listKeyIds: () => string[],
  apply: (id: string) => Promise<void>,
  commit: () => void,
): Promise<void> {
  const apps = listKeyIds().filter((id) => id !== desktopKeyId);
  const order = mode === 'private' ? [...apps, desktopKeyId] : [desktopKeyId, ...apps];
  for (const id of order) await apply(id);
  commit();
  for (const id of listKeyIds()) {
    if (id !== desktopKeyId && !apps.includes(id)) await apply(id);
  }
}

/**
 * Creates and saves a key carrying the mode as it stood when it started. A
 * switch that saved a different mode meanwhile may have missed it (it wasn't
 * saved yet when the switch listed keys), so the key is brought to the mode
 * saved now; if that fails it is discarded rather than left unrestricted.
 */
export async function publishUnderCurrentPrivacy<K>(
  publish: (mode: PrivacyMode) => Promise<K>,
  currentMode: () => PrivacyMode,
  apply: (key: K, mode: PrivacyMode) => Promise<void>,
  discard: (key: K) => Promise<void>,
): Promise<K> {
  const assumed = currentMode();
  const key = await publish(assumed);
  const now = currentMode();
  if (now === assumed) return key;
  try {
    await apply(key, now);
  } catch (err) {
    await discard(key).catch(() => undefined);
    throw err;
  }
  return key;
}
