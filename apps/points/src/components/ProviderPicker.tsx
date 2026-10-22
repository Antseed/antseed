import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { fmtBoost } from '../lib/format';
import type { Provider } from '../lib/model';

export function BoostTag({ boost }: { boost: number }) {
  const zero = boost < 0.01;
  return <span className={`boost-tag${zero ? ' zero' : ''}`}>{zero ? '0×' : fmtBoost(boost)}</span>;
}

/** A provider dropdown that shows each provider's boost as a tag, which a native <select> can't. */
export function ProviderPicker({ providers, value, onChange, label = 'Provider' }: {
  providers: Provider[];
  value: Provider | undefined;
  onChange: (agentId: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, providers.findIndex((p) => p.agentId === value?.agentId)));
  }, [open, providers, value]);

  const pick = (p: Provider) => {
    onChange(p.agentId);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((i) => Math.min(providers.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
    }
    if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault();
      const p = providers[active];
      if (p) pick(p);
    }
  };

  return (
    <div className="picker" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}: ${value?.name ?? 'none'}, boost ${fmtBoost(value?.boost ?? 0)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-name">{value?.name ?? 'Loading…'}</span>
        {value && <BoostTag boost={value.boost} />}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <ul className="picker-list" id={listId} role="listbox" aria-label={label}>
          {providers.map((p, i) => (
            <li
              key={p.agentId}
              role="option"
              aria-selected={p.agentId === value?.agentId}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              <span className="picker-name">{p.name}</span>
              <BoostTag boost={p.boost} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
