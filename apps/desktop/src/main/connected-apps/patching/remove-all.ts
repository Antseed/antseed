/** Runs every removal, so one app's unwritable config doesn't leave the rest patched. */
export function removeEach<T>(items: readonly T[], remove: (item: T) => void, onError: (item: T, err: unknown) => void): void {
  for (const item of items) {
    try {
      remove(item);
    } catch (err) {
      onError(item, err);
    }
  }
}
