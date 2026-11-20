import {useCallback, useEffect, useRef, useState} from 'react';

const COPIED_MS = 1500;

/** Writes `text` to the clipboard: the Clipboard API, or a selected textarea where it is missing (http, no permission). */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), {value: text});
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** `copy(text)` writes it to the clipboard; `copied` stays true for a moment after a copy succeeds. */
export function useCopy(): {copied: boolean; copy: (text: string) => void} {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    });
  }, []);
  return {copied, copy};
}
