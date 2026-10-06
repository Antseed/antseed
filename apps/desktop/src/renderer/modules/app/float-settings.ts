/** Floating pill behavior settings, persisted per install (localStorage). */

export const VPR_FLOAT_AUTO_OPEN_STORAGE_KEY = 'antseed.desktop.vpr.floatAutoOpen';

/** Whether the pill should pop up on its own when routed traffic starts.
    On by default — only an explicit opt-out disables it. */
export function loadFloatAutoOpen(): boolean {
  try {
    return localStorage.getItem(VPR_FLOAT_AUTO_OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveFloatAutoOpen(value: boolean): void {
  try {
    localStorage.setItem(VPR_FLOAT_AUTO_OPEN_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }
}

export const VPR_FLOAT_SHOW_ROUTED_PEER_STORAGE_KEY = 'antseed.desktop.vpr.floatShowRoutedPeer';

/** Debug aid: name the seller each chat's requests actually route to next to
    its model in the pill's chat rows. */
export function loadFloatShowRoutedPeer(): boolean {
  try {
    return localStorage.getItem(VPR_FLOAT_SHOW_ROUTED_PEER_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveFloatShowRoutedPeer(value: boolean): void {
  try {
    localStorage.setItem(VPR_FLOAT_SHOW_ROUTED_PEER_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }
}
