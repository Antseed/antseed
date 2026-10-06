import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const explanation = 'Early withdrawal permanently burns some principal, based on the remaining lock and configured limits. No penalty after expiry. Preview shows the exact burn and payout. Claim rewards separately.';

/** Shared help for early-exit amounts and percentages. Portal avoids clipping in tables and modals. */
export function EarlyExitHelp() {
  return <InfoHelp label="About the early-exit penalty">{explanation}</InfoHelp>;
}

export function InfoHelp({ label, children, symbol = '?' }: { label: string; children: ReactNode; symbol?: '?' | 'i' }) {
  const id = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepOpen = () => { clearTimeout(hideTimer.current); };
  const hideSoon = () => { hideTimer.current = setTimeout(() => setPlacement(null), 150); };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const trigger = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const show = () => {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 240 > window.innerHeight;
    setPlacement({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: above ? rect.top - 8 : rect.bottom + 8, above });
  };
  useEffect(() => {
    if (!placement) return;
    const dismiss = () => setPlacement(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('keydown', key, true);
    };
  }, [placement]);
  return <span className="early-exit-help">
    <button ref={trigger} type="button" className="early-exit-help__trigger" aria-label={label} aria-describedby={placement ? id : undefined}
      onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={() => setPlacement(null)} onClick={show}>{symbol}</button>
    {placement && createPortal(<span id={id} role="tooltip" className="early-exit-help__tooltip" onMouseEnter={keepOpen} onMouseLeave={hideSoon}
      style={{ left: placement.left, top: placement.top, transform: placement.above ? 'translateY(-100%)' : undefined }}>
      {children}
    </span>, document.body)}
  </span>;
}
