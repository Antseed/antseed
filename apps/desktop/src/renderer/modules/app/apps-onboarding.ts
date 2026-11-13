import {
  defaultStorage,
  readStorageFlag,
  type StorageLike,
  writeStorageFlag,
} from './local-storage-flag';

/**
 * One-shot Apps onboarding: after the user's first chat, a dot appears on the
 * Apps nav item; opening Apps then plays a "connect your tools" intro screen.
 * Seen-state persists per install (localStorage) like the other one-off
 * dialog dismissals.
 */
export const APPS_ONBOARDING_SEEN_KEY = 'antseed:appsOnboardingSeen';

export function isAppsOnboardingSeen(storage: StorageLike | null = defaultStorage()): boolean {
  return readStorageFlag(APPS_ONBOARDING_SEEN_KEY, storage);
}

export function persistAppsOnboardingSeen(storage: StorageLike | null = defaultStorage()): void {
  writeStorageFlag(APPS_ONBOARDING_SEEN_KEY, storage);
}

/** Nav-rail dot condition: the user hasn't opened the Apps screen yet. */
export function shouldNotifyAppsOnboarding(storage: StorageLike | null = defaultStorage()): boolean {
  return !isAppsOnboardingSeen(storage);
}
