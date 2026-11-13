import { useEffect, type RefObject } from 'react';

/** Closes an open menu on a click outside it or on Escape. */
export function useDropdownDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: (open: false) => void,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [ref, open, close]);
}
