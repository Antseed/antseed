import { useCallback, useEffect, useState } from 'react';

export const ZED_APP = 'zed';
const STORAGE_KEY = 'antseed.zedKeyPasted';

/** Zed keeps a key per URL, so a new key or a new gateway means pasting again. Only this digest is stored, never the key. */
export async function zedKeyFingerprint(origin: string, apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${origin}\n${apiKey}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
export function useZedKeyPaste(connected: boolean, reload: unknown): { apiKey: string | null; pasted: boolean; markPasted: () => void } {
  const [key, setKey] = useState<{ apiKey: string; fingerprint: string } | null>(null);
  const [pastedFingerprint, setPastedFingerprint] = useState(readPasted);

  useEffect(() => {
    if (!connected) {
      setKey(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const endpoint = await window.antseedDesktop?.gatewayGetEndpoint?.({ app: ZED_APP });
      if (!endpoint?.ok || !endpoint.origin || !endpoint.apiKey) return;
      const fingerprint = await zedKeyFingerprint(endpoint.origin, endpoint.apiKey);
      if (!cancelled) setKey({ apiKey: endpoint.apiKey, fingerprint });
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [connected, reload]);

  const fingerprint = key?.fingerprint ?? null;
  const markPasted = useCallback(() => {
    if (!fingerprint) return;
    writePasted(fingerprint);
    setPastedFingerprint(fingerprint);
  }, [fingerprint]);

  // Until the key is read there is nothing to paste, so the row stays calm.
  return { apiKey: key?.apiKey ?? null, pasted: !key || key.fingerprint === pastedFingerprint, markPasted };
}
