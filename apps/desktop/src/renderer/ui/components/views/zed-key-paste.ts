import { useCallback, useEffect, useState } from 'react';

export const ZED_APP = 'zed';
const STORAGE_KEY = 'antseed.zedKeyPasted';

/** Zed keeps a key per URL, so a new key or a new gateway means pasting again. Only this digest is stored, never the key. */
export async function zedKeyFingerprint(origin: string, apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${origin}\n${apiKey}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type GetEndpoint = (opts?: { app?: string }) => Promise<{ ok: boolean; origin?: string; apiKey?: string; error?: string }>;

/** Zed's key from the gateway, or why it couldn't be read. */
export async function loadZedKey(getEndpoint: GetEndpoint | undefined): Promise<{ apiKey: string; fingerprint: string } | { error: string }> {
  try {
    const endpoint = await getEndpoint?.({ app: ZED_APP });
    if (!endpoint?.ok || !endpoint.origin || !endpoint.apiKey) {
      return { error: endpoint?.error || 'Couldn’t read Zed’s key from the gateway.' };
    }
    return { apiKey: endpoint.apiKey, fingerprint: await zedKeyFingerprint(endpoint.origin, endpoint.apiKey) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type ZedKey = { apiKey: string; fingerprint: string };
type ZedKeyRead = ZedKey | { error: string };

/**
 * Reads of Zed's key for its settings dialog. Each read first clears what was
 * shown, so a failed one never leaves a key the console has since revoked or
 * replaced, and an answer a newer read or a close has overtaken is dropped.
 */
export function createZedKeyReads(load: () => Promise<ZedKeyRead>, show: (read: ZedKeyRead | null) => void) {
  let current = 0;
  return {
    /** Reads and shows Zed's key; resolves to it, or null when a newer read or a close overtook this one. */
    async refresh(): Promise<ZedKeyRead | null> {
      const id = ++current;
      show(null);
      const read = await load();
      if (id !== current) return null;
      show(read);
      return read;
    },
    /** Drops any read in flight. */
    close(): void {
      current += 1;
    },
  };
}

/** The key to copy, read again at that moment; null when that read failed or was overtaken. */
export async function readZedKeyToCopy(reads: { refresh: () => Promise<ZedKeyRead | null> }): Promise<string | null> {
  const read = await reads.refresh();
  return read && 'apiKey' in read ? read.apiKey : null;
}

function readPasted(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePasted(fingerprint: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, fingerprint);
  } catch {
    // Without storage the reminder just comes back next time.
  }
}

/**
 * The app can't see Zed's keychain, so the user says when the key is in.
 * `reload` changes whenever the key may have changed.
 */
export function useZedKeyPaste(connected: boolean, reload: unknown): {
  apiKey: string | null;
  pasted: boolean;
  markPasted: () => void;
  error: string | null;
  retry: () => void;
  /** Reads the key again and returns it for copying: it may have been replaced in the console meanwhile. */
  keyToCopy: () => Promise<string | null>;
} {
  const [key, setKey] = useState<ZedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pastedFingerprint, setPastedFingerprint] = useState(readPasted);
  const [reads] = useState(() => createZedKeyReads(
    () => loadZedKey(window.antseedDesktop?.gatewayGetEndpoint),
    (read) => {
      setKey(read && 'apiKey' in read ? read : null);
      setError(read && 'error' in read ? read.error : null);
    },
  ));

  useEffect(() => {
    if (!connected) {
      reads.close();
      setKey(null);
      setError(null);
      return;
    }
    void reads.refresh();
    // Back from the console (where the key may have been replaced): read again.
    const onFocus = () => { void reads.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      reads.close();
    };
  }, [connected, reload, attempt, reads]);

  const keyToCopy = useCallback(() => readZedKeyToCopy(reads), [reads]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const fingerprint = key?.fingerprint ?? null;
  const markPasted = useCallback(() => {
    if (!fingerprint) return;
    writePasted(fingerprint);
    setPastedFingerprint(fingerprint);
  }, [fingerprint]);

  // Until the key is read there is nothing to paste, so the row stays calm.
  return { apiKey: key?.apiKey ?? null, pasted: !key || key.fingerprint === pastedFingerprint, markPasted, error, retry, keyToCopy };
}
