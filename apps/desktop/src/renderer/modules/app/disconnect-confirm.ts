import {
  defaultStorage,
  readStorageFlag,
  type StorageLike,
  writeStorageFlag,
} from './local-storage-flag';

/**
 * "Don't show again" flag for the Home power-button disconnect confirmation,
 * persisted per install (localStorage) like the other one-off dialog dismissals.
 */
export const DISCONNECT_CONFIRM_DISMISSED_KEY = 'antseed:disconnectConfirmDismissed';

export function isDisconnectConfirmDismissed(storage: StorageLike | null = defaultStorage()): boolean {
  return readStorageFlag(DISCONNECT_CONFIRM_DISMISSED_KEY, storage);
}

export function persistDisconnectConfirmDismissed(
  dontShowAgain: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!dontShowAgain) return;
  writeStorageFlag(DISCONNECT_CONFIRM_DISMISSED_KEY, storage);
}
