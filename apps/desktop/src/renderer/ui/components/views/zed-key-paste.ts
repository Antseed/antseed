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
} {
  const [key, setKey] = useState<{ apiKey: string; fingerprint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pastedFingerprint, setPastedFingerprint] = useState(readPasted);

  useEffect(() => {
    // Forget the last key first: a reload that fails must not keep offering a
    // key the gateway may have revoked.
    setKey(null);
    setError(null);
    if (!connected) return;
    let cancelled = false;
    void loadZedKey(window.antseedDesktop?.gatewayGetEndpoint).then((result) => {
      if (cancelled) return;
      if ('error' in result) setError(result.error);
      else setKey(result);
    });
    return () => { cancelled = true; };
  }, [connected, reload, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const fingerprint = key?.fingerprint ?? null;
  const markPasted = useCallback(() => {
    if (!fingerprint) return;
    writePasted(fingerprint);
    setPastedFingerprint(fingerprint);
  }, [fingerprint]);

  // Until the key is read there is nothing to paste, so the row stays calm.
  return { apiKey: key?.apiKey ?? null, pasted: !key || key.fingerprint === pastedFingerprint, markPasted, error, retry };
}
