import {useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject} from 'react';
import {flushSync} from 'react-dom';
import {useLocation} from '@docusaurus/router';
import {useDismiss} from './useDismiss';

type HoverMenu = {
  open: boolean;
  close: () => void;
  rootProps: {
    onPointerEnter: (e: PointerEvent) => void;
    onPointerLeave: () => void;
    onBlur: () => void;
  };
  triggerProps: {
    'aria-expanded': boolean;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent) => void;
  };
};

/** A disclosure menu that opens on mouse hover as well as click; ArrowDown opens it and focuses its first link, Escape or a click
 *  outside closes it, and so does focus or the mouse leaving it. */
export function useHoverMenu(
  root: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>,
): HoverMenu {
  const [open, setOpen] = useState(false);
  // a mouse click lands on a menu its hover already opened: it should keep it open, not toggle it shut
  const hovered = useRef(false);
  const close = useCallback(() => setOpen(false), []);
  const focusInside = () => root.current?.contains(document.activeElement) ?? false;
  const {pathname} = useLocation();

  useEffect(close, [pathname, close]);
  useDismiss(open, root, close, trigger);

  return {
    open,
    close,
    rootProps: {
      onPointerEnter: (e) => {
        if (e.pointerType !== 'mouse') return;
        hovered.current = true;
        setOpen(true);
      },
      onPointerLeave: () => {
        hovered.current = false;
        if (!focusInside()) close();
      },
      // focus moves after blur fires: check where it landed on the next tick
      onBlur: () => setTimeout(() => !focusInside() && close(), 0),
    },
    triggerProps: {
      'aria-expanded': open,
      onClick: () => setOpen((o) => hovered.current || !o),
      onKeyDown: (e) => {
        if (e.key !== 'ArrowDown') return;
        e.preventDefault();
        flushSync(() => setOpen(true));
        menu.current?.querySelector<HTMLElement>('a')?.focus();
      },
    },
  };
}
