import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether Studio is on (Settings → Preview). Null until the main process has
 * answered, so nothing hides or redirects on a guess.
 */
let enabled: boolean | null = null;
let loading = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(): void {
  if (enabled !== null || loading) return;
  const read = window.antseedDesktop?.studioGetEnabled;
  if (!read) {
    enabled = false;
    emit();
    return;
  }
  loading = true;
  void read()
    .then((result) => { enabled = result?.ok === true && result.enabled === true; })
    .catch(() => { enabled = false; })
    .finally(() => { loading = false; emit(); });
}

export function useStudioPreview(): boolean | null {
  useEffect(load, []);
  return useSyncExternalStore(subscribe, () => enabled, () => enabled);
}

/** Turns Studio on or off; resolves to what the main process kept. */
export async function setStudioPreview(next: boolean): Promise<boolean> {
  const result = await window.antseedDesktop?.studioSetEnabled?.(next);
  if (!result?.ok) throw new Error(result?.error || 'Could not change the Studio setting.');
  enabled = result.enabled === true;
  emit();
  return enabled;
}
