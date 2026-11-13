import { useSyncExternalStore } from 'react';

/** The last console link that couldn't be opened, and from which page; null when there's none to show. */
type LaunchFailure = { path: string; error: string } | null;

let failure: LaunchFailure = null;
const listeners = new Set<() => void>();

function publish(next: LaunchFailure): void {
  failure = next;
  for (const listener of listeners) listener();
}

/**
 * Opens a page of the gateway console in the browser. A failure (the local
 * gateway didn't start, the console link couldn't be made) is kept for the
 * shell's notice instead of the click silently doing nothing.
 */
export async function openGatewayConsole(path: string): Promise<boolean> {
  try {
    const result = await window.antseedDesktop?.gatewayOpenConsole?.(path);
    if (result && !result.ok) {
      publish({ path, error: result.error ?? 'Could not open your gateway console' });
      return false;
    }
    if (failure) publish(null);
    return true;
  } catch (err) {
    publish({ path, error: err instanceof Error ? err.message : 'Could not open your gateway console' });
    return false;
  }
}

export function dismissConsoleLaunchFailure(): void {
  publish(null);
}

export function useConsoleLaunchFailure(): LaunchFailure {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => failure,
    () => failure,
  );
}
