import { useLayoutEffect, useRef } from 'react';

/** Keep a locally anchored picker inside its view, above the status bar. */
export function modelMenuSpace(anchor: { top: number; bottom: number }, bounds: { top: number; bottom: number }) {
  const below = Math.max(0, bounds.bottom - anchor.bottom - 12);
  const above = Math.max(0, anchor.top - bounds.top - 12);
  const upwards = below < 160 && above > below;
  return { upwards, maxHeight: Math.min(380, upwards ? above : below) };
}

export function useModelMenuViewport(open: boolean, close: () => void) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const anchor = menu.offsetParent as HTMLElement | null;
    const view = menu.closest<HTMLElement>('.view');
    if (!anchor || !view) return;
    const trigger = anchor.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    const update = () => {
      const rect = view.getBoundingClientRect();
      const space = modelMenuSpace(anchor.getBoundingClientRect(), {
        top: Math.max(0, rect.top),
        bottom: Math.min(window.innerHeight, rect.bottom),
      });
      menu.style.maxHeight = `${space.maxHeight}px`;
      menu.style.top = space.upwards ? 'auto' : 'calc(100% + 4px)';
      menu.style.bottom = space.upwards ? 'calc(100% + 4px)' : 'auto';
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        trigger?.focus();
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(view);
    observer.observe(anchor);
    window.addEventListener('resize', update);
    document.addEventListener('keydown', keydown);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('keydown', keydown);
    };
  }, [open, close]);
  return menuRef;
}
