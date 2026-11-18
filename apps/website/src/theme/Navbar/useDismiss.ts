import {useEffect, type RefObject} from 'react';

type ElementRef = RefObject<HTMLElement | null>;

/** While `open`, closes on a click outside `inside` (one element or several) and on Escape (which hands focus back to `returnFocus`). */
export function useDismiss(
  open: boolean,
  inside: ElementRef | readonly ElementRef[],
  close: () => void,
  returnFocus?: ElementRef,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const refs = Array.isArray(inside) ? inside : [inside as ElementRef];
    const onClick = (e: MouseEvent) => {
      if (!refs.some((ref) => ref.current?.contains(e.target as Node))) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      returnFocus?.current?.focus();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, inside, close, returnFocus]);
}
