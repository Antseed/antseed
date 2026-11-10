/**
 * Private covers the whole gateway: the desktop's key and every app's own key.
 * The desktop key's policy is what the app shows as the mode, so it changes in
 * the order that never claims more privacy than the apps have: into Private it
 * goes last, after every app key; out of Private it goes first. A failed write
 * stops there and is reported, so a half-applied switch is never shown as done.
 */
export async function applyPrivacyToKeys(
  mode: 'anonymous' | 'private',
  desktopKeyId: string,
  appKeyIds: string[],
  apply: (id: string) => Promise<void>,
): Promise<void> {
  const apps = appKeyIds.filter((id) => id !== desktopKeyId);
  const order = mode === 'private' ? [...apps, desktopKeyId] : [desktopKeyId, ...apps];
  for (const id of order) await apply(id);
}
