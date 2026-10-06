export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStorageFlag(key: string, storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function writeStorageFlag(key: string, storage: StorageLike | null): void {
  try {
    storage?.setItem(key, 'true');
  } catch {
    // Storage unavailable; the one-shot UI will appear again next time.
  }
}
