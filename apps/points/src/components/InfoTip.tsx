import { useId, useState, type ReactNode } from 'react';

/** A small (i) that explains a number: shows on hover or keyboard focus, and toggles on tap. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="tip" data-open={open || undefined} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="tip-i" aria-label={label} aria-describedby={id} onClick={() => setOpen((v) => !v)} onBlur={() => setOpen(false)}>i</button>
      <span id={id} role="tooltip" className="tip-body">{children}</span>
    </span>
  );
}
